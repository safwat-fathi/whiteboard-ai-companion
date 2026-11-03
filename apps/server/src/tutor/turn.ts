import {
  type BlobStore,
  type ChatRequest,
  type MessageDto,
  newId,
  type Usage,
} from '@whiteboard/core'
import {
  createUIMessageStream,
  isStepCount,
  type ModelMessage,
  type PrepareStepFunction,
  type StopCondition,
  streamText,
  type ToolSet,
  type UIMessageChunk,
} from 'ai'
import type { BoardService } from '../board-service'
import type { Config } from '../config'
import type { BooksDb, MessageRow, MessagesDb, SettingsDb } from '../db'
import { ApiError } from '../errors'
import { type SourceRange, sanitizeCites } from './cites'
import { buildTurnContext } from './context'
import {
  addUsage,
  costOf,
  type Llm,
  noUsage,
  pickModel,
  type StepUsage,
  upstreamError,
  usageOf,
} from './llm'
import { createMemory } from './memory'
import { systemPrefix } from './prompts'
import { buildScopePack, defang } from './scope'
import { dailyCap } from './settings'
import { type StubFixture, stubModel } from './stub'

const DAY_MS = 86_400_000

export type TurnCtx = {
  boardId: string
  turnId: string
  request: ChatRequest
  /** Writes a part to the chat stream (and into the stored message). */
  emit: (c: UIMessageChunk) => void
}

export type TutorDeps = {
  config: Config
  boards: BoardService
  messages: MessagesDb
  settings: SettingsDb
  /** The daily cap and ledger, and the book text behind the scope pack. */
  books: BooksDb
  /** Null when no Meta key is configured (and not stubbed). */
  llm: Llm | null
  /** Present = TUTOR_STUB: a scripted model replaces the provider and nothing else changes. */
  stub?: StubFixture[]
  /** The cheap model, for the rolling summary of older turns; absent = no summaries. */
  summarise?: (prompt: string) => Promise<string>
  /** Where uploaded pictures live: the turn reads the ones the student attached. */
  blobs: BlobStore
  /** The tools of a turn and, optionally, a hook that adds pictures to the next step. */
  tools?: (ctx: TurnCtx) => {
    tools: ToolSet
    prepareStep?: PrepareStepFunction<ToolSet>
  }
  now?: () => number
}

/** What the stub model was asked, for the stub-only test route. Images are reduced to their size. */
export type RecordedCall = { prompt: unknown[]; tools: string[] }

type Part = { type: string; [k: string]: unknown }

const sizeOf = (d: unknown): number => {
  if (typeof d === 'string') return d.length
  if (d instanceof Uint8Array) return d.length
  const inner = (d as { data?: unknown } | null)?.data
  return inner === undefined ? 0 : sizeOf(inner)
}
const plain = (content: unknown): unknown =>
  Array.isArray(content)
    ? content.map((p: { type?: string; data?: unknown; mediaType?: string }) =>
        p.type === 'file'
          ? { type: 'file', mediaType: p.mediaType, bytes: sizeOf(p.data) }
          : p,
      )
    : content

/** The stream's error text: JSON with the api.md code, so the dock can tell a quota problem from a cap. */
const wire = (e: unknown): string => {
  const err = e instanceof ApiError ? e : upstreamError(e)
  return JSON.stringify({ code: err.code, message: err.message })
}

/** Earlier turns as the model sees them: the text, plus one line per board change (R12). */
function historyOf(rows: MessageRow[]): ModelMessage[] {
  return rows.map((m) => {
    const text = m.parts
      .map((p) => {
        const q = p as {
          type?: string
          text?: string
          data?: { label?: string; count?: number }
        }
        if (q.type === 'text') return q.text ?? ''
        if (q.type === 'data-batch')
          return `(board change: ${q.data?.label}, ${q.data?.count} element(s))`
        return ''
      })
      .filter(Boolean)
      .join('\n')
    const shown = (m.context as { pictures?: unknown[] } | undefined)?.pictures
      ?.length
    // an old picture is not sent again, only remembered
    const note =
      m.role === 'user' && shown
        ? `\n(the student attached ${shown} picture${shown === 1 ? '' : 's'} of the board)`
        : ''
    return { role: m.role, content: text + note } as ModelMessage
  })
}

export function createTutor(deps: TutorDeps) {
  const { config, boards, messages, settings, books } = deps
  const now = deps.now ?? Date.now
  const t = config.tutor
  const active = new Map<string, string>() // boardId -> turnId: one turn per board
  const recorded = new Map<string, RecordedCall[]>()
  const memory = createMemory({
    messages,
    settings,
    summarise: deps.summarise ?? null,
  })

  /**
   * Checks everything that can fail with a plain HTTP error, takes the board's lock and stores the question. Throws
   * before any byte is streamed; whatever goes wrong afterwards reaches the client as a stream `error` part.
   */
  async function start(req: ChatRequest, signal: AbortSignal) {
    const board = boards.getBoard(req.boardId)
    if (!board) throw new ApiError('not_found', `unknown board ${req.boardId}`)
    if (active.has(board.id))
      throw new ApiError('turn_busy', 'The AI is still working on this board.')
    const dayStart = now() - (now() % DAY_MS)
    const cap = dailyCap(settings, config)
    if (books.spentSince(dayStart) >= cap)
      throw new ApiError('budget_exceeded', 'The daily budget is used up.', {
        cap: 'daily',
        limitUsd: cap,
      })
    if (!deps.stub && !deps.llm)
      throw new ApiError(
        'upstream_error',
        'The tutor is not configured: the server has no MODEL_API_KEY.',
      )

    const turnId = newId()
    const boardId = board.id
    const mem = memory.load(boardId)
    const history = historyOf(mem.window)
    active.set(boardId, turnId) // taken before the first await, so a second request cannot slip in
    let context: Awaited<ReturnType<typeof buildTurnContext>>
    try {
      context = await buildTurnContext({ boards, blobs: deps.blobs }, boardId, {
        context: req.context,
        images: req.message.images,
      })
    } catch (e) {
      active.delete(boardId)
      throw e
    }
    messages.append({
      id: `${turnId}:u`,
      boardId,
      turnId,
      role: 'user',
      parts: [{ type: 'text', text: req.message.text }],
      context: context.stored,
      createdAt: now(),
    })

    const stream = createUIMessageStream({
      onError: wire,
      execute: async ({ writer }) => {
        const parts: Part[] = []
        const sources: SourceRange[] = [] // the pages the model was shown: the only ones it may cite
        const textAt = new Map<string, number>()
        const emit = (c: UIMessageChunk) => {
          if (c.type === 'data-source')
            sources.push((c as unknown as { data: SourceRange }).data)
          if (c.type === 'text-start')
            textAt.set(c.id, parts.push({ type: 'text', text: '' }) - 1)
          else if (c.type === 'text-delta') {
            const p = parts[textAt.get(c.id) ?? -1]
            if (p) p.text = (p.text as string) + c.delta
          } else if (c.type.startsWith('data-'))
            parts.push({ type: c.type, data: (c as { data: unknown }).data })
          try {
            writer.write(c)
          } catch {
            // the client went away; the turn still finishes and is stored
          }
        }
        const say = (id: string, text: string) => {
          emit({ type: 'text-start', id })
          emit({ type: 'text-delta', id, delta: text })
          emit({ type: 'text-end', id })
        }

        const ac = new AbortController()
        let timedOut = false
        const onAbort = () => ac.abort()
        signal.addEventListener('abort', onAbort)
        if (signal.aborted) ac.abort()
        const timer = setTimeout(() => {
          timedOut = true
          ac.abort()
        }, t.turnTimeoutMs)

        let usage: StepUsage = noUsage()
        let upstream: unknown
        let fellBack = false
        let modelId = pickModel(t, req.message.text)
        let status: 'done' | 'stopped' = 'done'
        let stubbed: ReturnType<typeof stubModel> | undefined
        try {
          // the message starts before anything else, so the client has one to attach every part to; its id is the stored one
          emit({ type: 'start', messageId: `${turnId}:a` })
          emit({ type: 'data-turn', data: { turnId } })
          emit({ type: 'data-status', data: { state: 'thinking' } })
          const scope = board.scope
          const pack = buildScopePack(scope, books, t.chapterStuffMaxTokens)
          for (const src of pack.sources)
            emit({ type: 'data-source', data: src } as UIMessageChunk)
          if (deps.stub) {
            stubbed = stubModel(deps.stub, req.message.text, {
              BOOK_ID: 'bookId' in scope ? (scope.bookId ?? '') : '',
              PAGE_0: String(pack.sources[0]?.pageStart ?? 1),
            })
            modelId = 'stub-tutor'
          }
          const model =
            stubbed ??
            (deps.llm as Llm).model(modelId, t.fallbackModel, () => {
              fellBack = true
            })
          const overCost: StopCondition<ToolSet> = ({ steps }) =>
            t.price !== null &&
            (costOf(
              t.price,
              steps.reduce((a, s) => addUsage(a, usageOf(s.usage)), noUsage()),
            ) ?? 0) >= t.maxTurnCostUsd
          const toolset = deps.tools?.({ boardId, turnId, request: req, emit })
          const result = streamText({
            model,
            instructions: systemPrefix({
              profile: settings.get('profile'),
              scopePack: pack.pack ?? undefined,
            }),
            messages: [
              ...history,
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: mem.summary
                      ? `<conversation_summary>\n${defang(mem.summary)}\n</conversation_summary>\n${context.text}`
                      : context.text,
                  },
                  ...context.pictures.map((p) => ({
                    type: 'image' as const,
                    image: p.bytes,
                    mediaType: p.mediaType,
                  })),
                  { type: 'text', text: req.message.text },
                ],
              },
            ],
            tools: toolset?.tools ?? {},
            ...(toolset?.prepareStep
              ? { prepareStep: toolset.prepareStep }
              : {}),
            stopWhen: [isStepCount(t.maxSteps), overCost],
            abortSignal: ac.signal,
            maxRetries: 2,
            ...(t.reasoningEffort
              ? {
                  providerOptions: {
                    meta: { reasoningEffort: t.reasoningEffort },
                  },
                }
              : {}),
            onError: ({ error }) => {
              upstream = error
            },
          })
          for await (const c of result.toUIMessageStream({
            sendStart: false,
            sendFinish: false,
            onError: wire,
          }))
            emit(c)
          const steps = await Promise.resolve(result.steps).catch(() => [])
          usage = steps.reduce(
            (a, s) => addUsage(a, usageOf(s.usage)),
            noUsage(),
          )
          const last = steps.at(-1)
          if (timedOut)
            say(
              'note',
              `Stopped: the turn took longer than ${Math.round(t.turnTimeoutMs / 1000)} s.`,
            )
          else if (!ac.signal.aborted && last?.finishReason === 'tool-calls')
            say(
              'note',
              t.price !== null && overCost({ steps } as never)
                ? `Stopped: this turn reached its cost cap of $${t.maxTurnCostUsd}.`
                : `Stopped: this turn used its ${t.maxSteps} steps. Ask me to continue.`,
            )
          if (timedOut || ac.signal.aborted || upstream !== undefined)
            status = 'stopped'
        } catch (e) {
          upstream = e
          status = 'stopped'
          emit({ type: 'error', errorText: wire(e) })
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
        }
        let unverified = 0
        for (const p of parts)
          if (p.type === 'text') {
            const r = sanitizeCites(p.text as string, sources)
            p.text = r.text
            unverified += r.stripped
          }
        const cost = costOf(t.price, usage)
        const u: Usage = {
          ...usage,
          costUsd: cost,
          model: modelId,
          ...(fellBack ? { fallback: true } : {}),
          ...(unverified ? { unverifiedCites: unverified } : {}),
        }
        emit({ type: 'data-usage', data: u })
        emit({ type: 'data-status', data: { state: status } })
        try {
          if (cost !== null && cost > 0)
            books.addSpend({
              at: now(),
              kind: 'turn',
              ref: turnId,
              costUsd: cost,
            })
          messages.append({
            id: `${turnId}:a`,
            boardId,
            turnId,
            role: 'assistant',
            parts: parts.filter((p) => p.type !== 'text' || p.text !== ''),
            model: modelId,
            usage: u,
            createdAt: now(),
          })
          if (stubbed)
            recorded.set(
              boardId,
              stubbed.doStreamCalls.map((c) => ({
                prompt: (c.prompt as { role: string; content: unknown }[]).map(
                  (m) => ({
                    role: m.role,
                    content: plain(m.content),
                  }),
                ),
                tools: (c.tools ?? []).map((x) => x.name),
              })),
            )
        } finally {
          active.delete(boardId)
        }
        // best effort and off the critical path: a failed summary just means the window is all the tutor remembers
        void memory.maybeSummarise(boardId).catch((e) => {
          console.error(
            'summary failed:',
            e instanceof Error ? e.name : typeof e,
          )
        })
        emit({ type: 'finish' } as UIMessageChunk)
      },
    })
    return { turnId, stream }
  }

  const toDto = ({ boardId: _b, ...m }: MessageRow): MessageDto =>
    m as MessageDto

  return {
    start,
    toDto,
    isBusy: (boardId: string) => active.has(boardId),
    chatStart: memory.chatStart,
    newChat(boardId: string): void {
      if (active.has(boardId))
        throw new ApiError(
          'turn_busy',
          'The AI is still working on this board.',
        )
      memory.reset(boardId)
    },
    activeTurn: (boardId: string) => active.get(boardId),
    /** "What the AI sees": the exact context a turn with this descriptor would send. */
    previewContext: (
      boardId: string,
      context: ChatRequest['context'],
      images: string[] = [],
    ) =>
      buildTurnContext({ boards, blobs: deps.blobs }, boardId, {
        context,
        images,
      }),
    lastRequest: (boardId: string) => recorded.get(boardId),
    models: () => ({
      tutor: t.model,
      tutorAr: t.modelAr,
      fallback: t.fallbackModel,
      cheap: config.cheapModel,
      vision: config.visionModel,
      embed: config.embedModel,
      priced: t.price !== null,
    }),
  }
}
export type Tutor = ReturnType<typeof createTutor>

import {
  type ChatRequest,
  type MessageDto,
  newId,
  type Usage,
} from '@whiteboard/core'
import {
  createUIMessageStream,
  isStepCount,
  type ModelMessage,
  type StopCondition,
  streamText,
  type ToolSet,
  type UIMessageChunk,
} from 'ai'
import type { BoardService } from '../board-service'
import type { Config } from '../config'
import type { BooksDb, MessageRow, MessagesDb, SettingsDb } from '../db'
import { ApiError } from '../errors'
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
import { systemPrefix } from './prompts'
import { type StubFixture, stubModel } from './stub'

const DAY_MS = 86_400_000

export type TurnCtx = { boardId: string; turnId: string; request: ChatRequest }

export type TutorDeps = {
  config: Config
  boards: BoardService
  messages: MessagesDb
  settings: SettingsDb
  /** `addSpend` / `spentSince` only: the daily cap and the ledger. */
  books: Pick<BooksDb, 'addSpend' | 'spentSince'>
  /** Null when no Meta key is configured (and not stubbed). */
  llm: Llm | null
  /** Present = TUTOR_STUB: a scripted model replaces the provider and nothing else changes. */
  stub?: StubFixture[]
  /** The tools of a turn (T8 supplies the board and book tools). */
  tools?: (ctx: TurnCtx) => ToolSet
  now?: () => number
}

/** What the stub model was asked, for the stub-only test route. Images are reduced to their size. */
export type RecordedCall = { prompt: unknown[]; tools: string[] }

type Part = { type: string; [k: string]: unknown }

const plain = (content: unknown): unknown =>
  Array.isArray(content)
    ? content.map((p: { type?: string; data?: unknown; mediaType?: string }) =>
        p.type === 'file'
          ? {
              type: 'file',
              mediaType: p.mediaType,
              bytes: (p.data as { length?: number } | undefined)?.length ?? 0,
            }
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
    return { role: m.role, content: text } as ModelMessage
  })
}

export function createTutor(deps: TutorDeps) {
  const { config, boards, messages, settings, books } = deps
  const now = deps.now ?? Date.now
  const t = config.tutor
  const active = new Map<string, string>() // boardId -> turnId: one turn per board
  const recorded = new Map<string, RecordedCall[]>()

  /**
   * Checks everything that can fail with a plain HTTP error, takes the board's lock and stores the question. Throws
   * before any byte is streamed; whatever goes wrong afterwards reaches the client as a stream `error` part.
   */
  function start(req: ChatRequest, signal: AbortSignal) {
    const board = boards.getBoard(req.boardId)
    if (!board) throw new ApiError('not_found', `unknown board ${req.boardId}`)
    if (active.has(board.id))
      throw new ApiError('turn_busy', 'The AI is still working on this board.')
    const dayStart = now() - (now() % DAY_MS)
    if (books.spentSince(dayStart) >= config.dailyBudgetUsd)
      throw new ApiError('budget_exceeded', 'The daily budget is used up.', {
        cap: 'daily',
        limitUsd: config.dailyBudgetUsd,
      })
    if (!deps.stub && !deps.llm)
      throw new ApiError(
        'upstream_error',
        'The tutor is not configured: the server has no META_API_KEY.',
      )

    const turnId = newId()
    const boardId = board.id
    const history = historyOf(messages.page(boardId, { limit: 16 }).messages)
    messages.append({
      id: `${turnId}:u`,
      boardId,
      turnId,
      role: 'user',
      parts: [{ type: 'text', text: req.message.text }],
      context: req.context, // ponytail: picture and digest ids join this in T15/T16
      createdAt: now(),
    })
    active.set(boardId, turnId)

    const stream = createUIMessageStream({
      onError: wire,
      execute: async ({ writer }) => {
        const parts: Part[] = []
        const textAt = new Map<string, number>()
        const emit = (c: UIMessageChunk) => {
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
          emit({ type: 'data-turn', data: { turnId } })
          emit({ type: 'data-status', data: { state: 'thinking' } })
          if (deps.stub) {
            stubbed = stubModel(deps.stub, req.message.text, {})
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
          const result = streamText({
            model,
            instructions: systemPrefix({ profile: settings.get('profile') }),
            messages: [...history, { role: 'user', content: req.message.text }],
            tools: deps.tools?.({ boardId, turnId, request: req }) ?? {},
            stopWhen: [isStepCount(t.maxSteps), overCost],
            abortSignal: ac.signal,
            maxRetries: 2,
            onError: ({ error }) => {
              upstream = error
            },
          })
          for await (const c of result.toUIMessageStream({
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
        const cost = costOf(t.price, usage)
        const u: Usage = {
          ...usage,
          costUsd: cost,
          model: modelId,
          ...(fellBack ? { fallback: true } : {}),
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

import type { MessageDto, Usage } from '@whiteboard/core'
import type { UIMessage } from 'ai'

// Pure helpers behind the chat tab: no React, so they test without a DOM.

export type BatchChip = {
  batchId: string
  seq: number
  label: string
  bounds: { x: number; y: number; w: number; h: number } | null
  count: number
}
export type SourceRange = {
  bookId: string
  pageStart: number
  pageEnd: number
  label?: string
}
export type TurnState = 'thinking' | 'reading' | 'drawing' | 'done' | 'stopped'

/** The custom `data-*` parts the chat stream adds (api.md), as the UI message type sees them. */
export type TutorData = {
  turn: { turnId: string }
  batch: BatchChip
  usage: Usage
  status: { state: TurnState; text?: string }
  source: SourceRange
}
export type TutorMessage = UIMessage<unknown, TutorData>
type Part = TutorMessage['parts'][number]

export type ChatError = {
  code: string
  message: string
  details?: Record<string, unknown>
}

/** A stored message as the chat list shows it. */
export const toMessage = (m: MessageDto): TutorMessage => ({
  id: m.id,
  role: m.role,
  parts: (m.parts as Part[]).concat(
    m.usage ? [{ type: 'data-usage', data: m.usage } as Part] : [],
  ),
})

export const textOf = (m: TutorMessage): string =>
  m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')

const asChatError = (v: unknown): ChatError | null => {
  const e = (v as { error?: unknown } | null)?.error ?? v
  const o = e as { code?: unknown; message?: unknown; details?: unknown }
  return typeof o?.code === 'string' && typeof o.message === 'string'
    ? {
        code: o.code,
        message: o.message,
        ...(o.details && typeof o.details === 'object'
          ? { details: o.details as Record<string, unknown> }
          : {}),
      }
    : null
}

/**
 * What went wrong, in api.md's terms. A refused request (409, 429, 502 ...) reaches us as the body text in an Error; a
 * failure mid-stream as the stream's `errorText` (JSON with `code` and `message`). Anything else is a plain message.
 */
export function parseChatError(e: unknown): ChatError {
  const raw = e instanceof Error ? e.message : String(e)
  try {
    const found = asChatError(JSON.parse(raw))
    if (found) return found
  } catch {}
  if (e instanceof TypeError || /failed to fetch|network/i.test(raw))
    return { code: 'network', message: 'The server could not be reached.' }
  return { code: 'error', message: raw || 'Something went wrong.' }
}

/** The notice under the composer for a turn that did not start or did not finish. */
export function errorNotice(e: ChatError): string {
  if (e.code === 'turn_busy') return 'The AI is still working on this board.'
  if (e.code === 'budget_exceeded') {
    const cap = e.details?.cap
    return cap === 'daily'
      ? 'The daily AI budget is used up. Raise it in settings to continue.'
      : `${e.message} (cap: ${String(cap ?? 'turn')}).`
  }
  return e.message
}

export const sourcesOf = (m: TutorMessage): SourceRange[] =>
  m.parts.flatMap((p) => (p.type === 'data-source' ? [p.data] : []))

/** A `cite:` link is shown as a link only when the model was actually shown that page in this turn (R6). */
export const isVerifiedCite = (
  c: { bookId: string; page: number },
  sources: readonly SourceRange[],
): boolean =>
  sources.some(
    (s) =>
      s.bookId === c.bookId && c.page >= s.pageStart && c.page <= s.pageEnd,
  )

export const batchesOf = (m: TutorMessage): BatchChip[] =>
  m.parts.flatMap((p) => (p.type === 'data-batch' ? [p.data] : []))

export const usageOfMessage = (m: TutorMessage): Usage | undefined =>
  m.parts.flatMap((p) => (p.type === 'data-usage' ? [p.data] : [])).at(-1)

export const turnStateOf = (m: TutorMessage): TurnState | undefined =>
  m.parts
    .flatMap((p) => (p.type === 'data-status' ? [p.data.state] : []))
    .at(-1)

const n = (x: number) => x.toLocaleString('en-US')
/** "muse-spark-1.3 · 1,200 in (400 cached) · 210 out · $0.0123"; dollars only when the model is priced. */
export function footerText(u: Usage): string {
  return [
    u.model,
    `${n(u.inputTokens)} in${u.cachedTokens > 0 ? ` (${n(u.cachedTokens)} cached)` : ''}`,
    `${n(u.outputTokens)} out`,
    ...(u.costUsd === null ? [] : [`$${u.costUsd.toFixed(4)}`]),
    ...(u.fallback ? ['fallback model'] : []),
    ...(u.unverifiedCites
      ? [
          `${u.unverifiedCites} citation${u.unverifiedCites === 1 ? '' : 's'} could not be verified`,
        ]
      : []),
  ].join(' · ')
}

/** Tool-call chip text: "Added concept map · 12 elements". */
export const chipText = (b: BatchChip): string =>
  `${b.label} · ${b.count} element${b.count === 1 ? '' : 's'}`

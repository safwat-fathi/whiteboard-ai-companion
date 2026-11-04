'use client'

import { Component, type ReactNode, useMemo } from 'react'
import {
  type BatchChip,
  batchesOf,
  chipText,
  footerText,
  isVerifiedCite,
  sourcesOf,
  type TutorMessage,
  turnIdOf,
  usageOfMessage,
} from './chat-core'
import { Markdown } from './Markdown'

export type MessageActions = {
  onCite?: (c: { bookId: string; page: number }) => void
  onLocate?: (elementId: string) => void
  /** Chip actions; absent until the board can act on them. */
  onLocateBatch?: (b: BatchChip) => void
  onUndoBatch?: (b: BatchChip) => void
}

/** Per-message undo state, owned by the chat tab. */
export type TurnUndo = {
  /** Offer "Undo this response" (the turn is over and changed the board). */
  available: boolean
  busy: boolean
  note?: string
  run: () => void
}

export function MessageView({
  message,
  actions,
  undo,
}: {
  message: TutorMessage
  actions: MessageActions
  undo?: TurnUndo
}) {
  const mine = message.role === 'user'
  const { onCite, onLocate } = actions
  // Stable while the message and the two callbacks are: Markdown skips its re-parse when its props are unchanged.
  const handlers = useMemo(() => {
    const sources = sourcesOf(message)
    return {
      isVerified: (c: { bookId: string; page: number }) =>
        isVerifiedCite(c, sources),
      onCite,
      onLocate,
    }
  }, [message, onCite, onLocate])
  const usage = usageOfMessage(message)
  return (
    <article
      aria-label={mine ? 'You' : 'Tutor'}
      data-turn={mine ? undefined : turnIdOf(message)}
      className={`flex flex-col text-sm transition-all ${
        mine
          ? 'self-end max-w-[85%] rounded-2xl rounded-tr-xs bg-blue-50/90 border border-blue-100 text-slate-900 px-3.5 py-2 shadow-2xs'
          : 'self-stretch max-w-full text-slate-800 py-1'
      }`}
    >
      <div
        dir="auto"
        style={{ overflowWrap: 'anywhere' }}
        className="leading-relaxed"
      >
        {message.parts.map((p, i) => {
          if (p.type === 'text')
            return mine ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts of one message never reorder
              <p key={i} className="m-0 whitespace-pre-wrap font-sans text-sm">
                {p.text}
              </p>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts of one message never reorder
              <Markdown key={i} text={p.text} handlers={handlers} />
            )
          return null
        })}
      </div>
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {batchesOf(message).map((b) => (
          <span
            key={b.batchId}
            className="inline-flex items-center gap-2 rounded-full border border-blue-200/90 bg-blue-50/80 px-2.5 py-0.5 text-xs text-blue-800 font-medium shadow-2xs"
          >
            <span>{chipText(b)}</span>
            {actions.onLocateBatch && (
              <button
                type="button"
                className="font-semibold text-blue-600 hover:text-blue-800 underline underline-offset-2 cursor-pointer text-xs"
                onClick={() => actions.onLocateBatch?.(b)}
              >
                Locate
              </button>
            )}
            {actions.onUndoBatch && (
              <button
                type="button"
                className="font-semibold text-blue-600 hover:text-blue-800 underline underline-offset-2 cursor-pointer text-xs"
                onClick={() => actions.onUndoBatch?.(b)}
              >
                Undo
              </button>
            )}
          </span>
        ))}
      </div>
      {undo?.available && (
        <p className="mt-2 text-xs">
          <button
            type="button"
            disabled={undo.busy}
            onClick={undo.run}
            className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors shadow-2xs cursor-pointer disabled:opacity-50"
          >
            Undo this response
          </button>
        </p>
      )}
      {undo?.note && (
        <p role="status" className="mt-1 text-xs text-slate-600 font-medium">
          {undo.note}
        </p>
      )}
      {usage && (
        <p className="mt-1.5 text-[11px] font-medium text-slate-400">
          {footerText(usage)}
        </p>
      )}
    </article>
  )
}

/** One broken message must not take the whole conversation down with it. */
export class MessageBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <p role="note" className="m-0 text-xs font-medium text-red-600">
        This message could not be shown.
      </p>
    ) : (
      this.props.children
    )
  }
}

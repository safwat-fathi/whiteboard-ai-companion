'use client'

import { Component, type ReactNode } from 'react'

import {
  type BatchChip,
  batchesOf,
  chipText,
  footerText,
  isVerifiedCite,
  sourcesOf,
  type TutorMessage,
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

const chip: React.CSSProperties = {
  display: 'inline-flex',
  gap: 6,
  alignItems: 'center',
  border: '1px solid #c9d3ea',
  background: '#f1f5ff',
  borderRadius: 14,
  padding: '2px 10px',
  fontSize: 13,
  margin: '4px 6px 0 0',
}
const mini: React.CSSProperties = {
  font: 'inherit',
  border: 'none',
  background: 'none',
  color: '#1a56db',
  textDecoration: 'underline',
  cursor: 'pointer',
  padding: 0,
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
  const sources = sourcesOf(message)
  const handlers = {
    isVerified: (c: { bookId: string; page: number }) =>
      isVerifiedCite(c, sources),
    onCite: actions.onCite,
    onLocate: actions.onLocate,
  }
  const usage = usageOfMessage(message)
  return (
    <article
      aria-label={mine ? 'You' : 'Tutor'}
      style={{
        alignSelf: mine ? 'flex-end' : 'stretch',
        maxWidth: mine ? '85%' : '100%',
        background: mine ? '#eef3ff' : 'transparent',
        borderRadius: 10,
        padding: mine ? '6px 10px' : '2px 2px',
      }}
    >
      <div dir="auto" style={{ overflowWrap: 'anywhere' }}>
        {message.parts.map((p, i) => {
          if (p.type === 'text')
            return mine ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts of one message never reorder
              <p key={i} style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                {p.text}
              </p>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts of one message never reorder
              <Markdown key={i} text={p.text} handlers={handlers} />
            )
          return null
        })}
      </div>
      <div>
        {batchesOf(message).map((b) => (
          <span key={b.batchId} style={chip}>
            {chipText(b)}
            {actions.onLocateBatch && (
              <button
                type="button"
                style={mini}
                onClick={() => actions.onLocateBatch?.(b)}
              >
                Locate
              </button>
            )}
            {actions.onUndoBatch && (
              <button
                type="button"
                style={mini}
                onClick={() => actions.onUndoBatch?.(b)}
              >
                Undo
              </button>
            )}
          </span>
        ))}
      </div>
      {undo?.available && (
        <p style={{ margin: '6px 0 0', fontSize: 13 }}>
          <button type="button" disabled={undo.busy} onClick={undo.run}>
            Undo this response
          </button>
        </p>
      )}
      {undo?.note && (
        <p role="status" style={{ margin: '6px 0 0', fontSize: 13 }}>
          {undo.note}
        </p>
      )}
      {usage && (
        <p style={{ margin: '6px 0 0', fontSize: 12, color: '#666' }}>
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
      <p role="note" style={{ color: '#a33', fontSize: 13, margin: 0 }}>
        This message could not be shown.
      </p>
    ) : (
      this.props.children
    )
  }
}

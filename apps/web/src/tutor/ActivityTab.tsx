'use client'

import type { ActivityTurn } from '@whiteboard/core'
import { useState } from 'react'
import { undoNote } from './chat-core'
import type { LocateItem } from './locate'

type Batch = ActivityTurn['batches'][number]
export const batchItem = (b: Batch): LocateItem => ({
  ids: b.touchedIds ?? [],
  bounds: b.bounds,
})

const STATUS: Record<ActivityTurn['status'], string> = {
  running: 'working…',
  done: 'done',
  stopped: 'stopped',
  error: 'failed',
}

const link: React.CSSProperties = {
  font: 'inherit',
  background: 'none',
  border: 'none',
  color: '#1a56db',
  textDecoration: 'underline',
  cursor: 'pointer',
  padding: 0,
}

/** The AI's work on this board, turn by turn (jump-to-ai.md): every row locates, every batch can be undone. */
export function ActivityTab({
  turns,
  hasMore,
  loadMore,
  failed,
  onLocate,
  undo,
}: {
  turns: ActivityTurn[]
  hasMore: boolean
  loadMore: () => void
  failed: boolean
  onLocate: (items: LocateItem[]) => void
  undo?: {
    turn: (turnId: string) => Promise<{ undone: number; skipped: number }>
    batch: (batchId: string) => Promise<{ undone: number; skipped: number }>
  }
}) {
  const [notes, setNotes] = useState<Record<string, string>>({})
  const run = async (
    key: string,
    call: () => Promise<{ undone: number; skipped: number }>,
  ) => {
    try {
      const note = undoNote(await call())
      setNotes((n) => ({ ...n, [key]: note }))
    } catch (e) {
      setNotes((n) => ({
        ...n,
        [key]: e instanceof Error ? e.message : 'Could not undo.',
      }))
    }
  }
  if (failed)
    return (
      <p role="alert" style={{ padding: 12, fontSize: 13 }}>
        The activity could not be loaded.
      </p>
    )
  if (turns.length === 0)
    return (
      <p style={{ padding: 12, color: '#555', fontSize: 13 }}>
        The tutor's work on this board will be listed here.
      </p>
    )
  return (
    <ol
      aria-label="The tutor's work"
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 10,
        display: 'grid',
        gap: 12,
      }}
    >
      {turns.map((t) => (
        <li
          key={t.turnId}
          data-turn={t.turnId}
          style={{
            border: '1px solid #ddd',
            borderRadius: 8,
            padding: '8px 10px',
          }}
        >
          <div dir="auto" style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
            {t.userText || 'A question'}
          </div>
          <div style={{ fontSize: 12, color: '#666' }}>
            {new Date(t.startedAt).toLocaleTimeString()} · {STATUS[t.status]} ·{' '}
            {t.batches.length} change
            {t.batches.length === 1 ? '' : 's'}
          </div>
          <div style={{ display: 'flex', gap: 10, margin: '4px 0' }}>
            <button
              type="button"
              style={link}
              onClick={() => onLocate(t.batches.map(batchItem))}
            >
              Locate turn
            </button>
            {undo && t.status !== 'running' && (
              <button
                type="button"
                style={link}
                onClick={() => void run(t.turnId, () => undo.turn(t.turnId))}
              >
                Undo turn
              </button>
            )}
          </div>
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gap: 2,
              fontSize: 13,
            }}
          >
            {t.batches.map((b) => (
              <li
                key={b.batchId}
                style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}
              >
                <span style={{ flex: 1 }}>
                  {b.label} · {b.count} element{b.count === 1 ? '' : 's'}
                </span>
                <button
                  type="button"
                  style={link}
                  onClick={() => onLocate([batchItem(b)])}
                >
                  Locate
                </button>
                {undo && (
                  <button
                    type="button"
                    style={link}
                    onClick={() =>
                      void run(t.turnId, () => undo.batch(b.batchId))
                    }
                  >
                    Undo
                  </button>
                )}
              </li>
            ))}
          </ul>
          {notes[t.turnId] && (
            <p role="status" style={{ margin: '4px 0 0', fontSize: 13 }}>
              {notes[t.turnId]}
            </p>
          )}
        </li>
      ))}
      {hasMore && (
        <li>
          <button type="button" onClick={loadMore}>
            Show earlier work
          </button>
        </li>
      )}
    </ol>
  )
}

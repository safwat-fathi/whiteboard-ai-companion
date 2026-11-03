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
      <p role="alert" className="p-4 text-xs font-medium text-red-600">
        The activity could not be loaded.
      </p>
    )
  if (turns.length === 0)
    return (
      <p className="p-4 text-xs text-slate-500">
        The tutor's work on this board will be listed here.
      </p>
    )
  return (
    <ol aria-label="The tutor's work" className="m-0 list-none p-3 grid gap-3">
      {turns.map((t) => (
        <li
          key={t.turnId}
          data-turn={t.turnId}
          className="rounded-2xl border border-slate-200/90 bg-white p-3 shadow-2xs transition-all hover:border-slate-300 flex flex-col gap-1.5"
        >
          <div
            dir="auto"
            className="font-semibold text-slate-900 text-sm break-words"
          >
            {t.userText || 'A question'}
          </div>
          <div className="text-xs text-slate-500">
            {new Date(t.startedAt).toLocaleTimeString()} ·{' '}
            <span
              className={
                t.status === 'running' ? 'text-blue-600 font-semibold' : ''
              }
            >
              {STATUS[t.status]}
            </span>{' '}
            · {t.batches.length} change
            {t.batches.length === 1 ? '' : 's'}
          </div>
          <div className="flex gap-3 my-1">
            <button
              type="button"
              className="text-xs font-semibold text-blue-600 hover:text-blue-800 underline underline-offset-2 cursor-pointer"
              onClick={() => onLocate(t.batches.map(batchItem))}
            >
              Locate turn
            </button>
            {undo && t.status !== 'running' && (
              <button
                type="button"
                className="text-xs font-semibold text-blue-600 hover:text-blue-800 underline underline-offset-2 cursor-pointer"
                onClick={() => void run(t.turnId, () => undo.turn(t.turnId))}
              >
                Undo turn
              </button>
            )}
          </div>
          <ul className="m-0 list-none p-0 grid gap-1 text-xs text-slate-700">
            {t.batches.map((b) => (
              <li key={b.batchId} className="flex items-baseline gap-2">
                <span className="flex-1 text-slate-600">
                  {b.label} · {b.count} element{b.count === 1 ? '' : 's'}
                </span>
                <button
                  type="button"
                  className="text-xs font-medium text-blue-600 hover:text-blue-800 underline underline-offset-2 cursor-pointer"
                  onClick={() => onLocate([batchItem(b)])}
                >
                  Locate
                </button>
                {undo && (
                  <button
                    type="button"
                    className="text-xs font-medium text-blue-600 hover:text-blue-800 underline underline-offset-2 cursor-pointer"
                    onClick={() =>
                      void run(b.batchId, () => undo.batch(b.batchId))
                    }
                  >
                    Undo
                  </button>
                )}
                {notes[b.batchId] && (
                  <span role="status" className="text-xs text-slate-500">
                    {notes[b.batchId]}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {notes[t.turnId] && (
            <div role="status" className="text-xs text-slate-500">
              {notes[t.turnId]}
            </div>
          )}
        </li>
      ))}
      {hasMore && (
        <li className="text-center pt-2">
          <button
            type="button"
            className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer shadow-2xs"
            onClick={loadMore}
          >
            Show earlier work
          </button>
        </li>
      )}
    </ol>
  )
}

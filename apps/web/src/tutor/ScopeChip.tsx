'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Outline } from '../../app/library/Outline'
import { ui } from '../../app/library/ui'
import type { Book, LibraryApi, Section } from '../library/api'
import {
  buildScope,
  buildTree,
  type Scope,
  scopeLabel,
  tickedOf,
  toggle,
} from '../library/scope'
import { BookIcon } from '../ui/icons'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The top bar's scope chip: what this board studies, and a dialog to change it (a book, and optionally some of its sections). */
export function ScopeChip({
  api,
  boardId,
  scope,
  onChange,
}: {
  api: LibraryApi
  boardId: string
  scope: Scope | null
  onChange: (s: Scope | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [book, setBook] = useState<Book | null>(null)
  const [sections, setSections] = useState<Section[]>([])
  const bookId = scope?.bookId
  useEffect(() => {
    setBook(null)
    setSections([])
    if (!bookId) return
    let live = true
    api.getBook(bookId).then(
      (b) => live && setBook(b),
      () => {},
    )
    api.outline(bookId).then(
      (s) => live && setSections(s),
      () => {},
    )
    return () => {
      live = false
    }
  }, [api, bookId])

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        title="Change what this board studies"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-full border border-slate-200/90 bg-slate-50/80 px-2.5 py-0.5 text-xs font-medium text-slate-700 transition-all duration-150 hover:border-blue-400 hover:bg-blue-50/50 hover:text-blue-700 cursor-pointer"
      >
        <BookIcon size={13} className="text-slate-400" />
        <span>{scopeLabel(scope, book?.title, sections)}</span>
      </button>
      {open && (
        <ScopePicker
          api={api}
          scope={scope}
          onClose={() => setOpen(false)}
          onApply={async (next) => {
            await api.setBoardScope(boardId, next ?? {})
            onChange(next)
            setOpen(false)
          }}
        />
      )}
    </>
  )
}

function ScopePicker({
  api,
  scope,
  onApply,
  onClose,
}: {
  api: LibraryApi
  scope: Scope | null
  onApply: (s: Scope | null) => Promise<void>
  onClose: () => void
}) {
  const [books, setBooks] = useState<Book[] | null>(null)
  const [bookId, setBookId] = useState(scope?.bookId ?? '')
  const [sections, setSections] = useState<Section[]>([])
  const [ticked, setTicked] = useState<ReadonlySet<number>>(tickedOf(scope))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    api.listBooks().then(
      (b) => live && setBooks(b.filter((x) => x.status === 'ready')),
      (e) => live && setError(message(e)),
    )
    return () => {
      live = false
    }
  }, [api])
  useEffect(() => {
    if (!bookId) return setSections([])
    let live = true
    api.outline(bookId).then(
      (s) => live && setSections(s),
      (e) => live && setError(message(e)),
    )
    return () => {
      live = false
    }
  }, [api, bookId])

  const apply = async (next: Scope | null) => {
    setBusy(true)
    setError(null)
    try {
      await onApply(next)
    } catch (e) {
      setError(message(e))
      setBusy(false)
    }
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <div style={ui.backdrop}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose what this board studies"
        style={{
          ...ui.dialog,
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          minWidth: 320,
        }}
      >
        <div className="shrink-0">
          <h2
            style={{ marginTop: 0, fontSize: 18 }}
            className="font-bold text-slate-900"
          >
            What does this board study?
          </h2>
          {error && (
            <p role="alert" style={ui.alert}>
              {error}
            </p>
          )}
          {books === null ? (
            <p className="text-sm text-slate-500">Loading your books…</p>
          ) : books.length === 0 ? (
            <p className="text-sm text-slate-500">
              No indexed books yet. Add one in the library.
            </p>
          ) : (
            <label className="flex flex-col gap-1.5 text-xs font-medium text-slate-700">
              Book
              <select
                value={bookId}
                onChange={(e) => {
                  setBookId(e.target.value)
                  setTicked(new Set())
                }}
                className="w-full rounded-xl border border-slate-200 bg-slate-50/50 p-2.5 text-sm text-slate-900 focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-100 transition-all font-sans"
              >
                <option value="">Choose a book…</option>
                {books.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {bookId && sections.length > 0 && (
          <div className="mt-3 flex-1 min-h-0 flex flex-col">
            <p style={ui.muted} className="mb-2 shrink-0">
              {ticked.size === 0
                ? 'The whole book'
                : `${ticked.size} section${ticked.size === 1 ? '' : 's'} chosen`}
              . Tick sections to focus on them.
            </p>
            <div className="overflow-y-auto pr-1 flex-1 min-h-0">
              <ul
                style={{ listStyle: 'none', padding: 0 }}
                className="space-y-1"
              >
                {buildTree(sections).map((n) => (
                  <Outline
                    key={n.section.id}
                    node={n}
                    ticked={ticked}
                    onTick={(id) => setTicked((t) => toggle(t, id))}
                    onOpen={() => {}}
                  />
                ))}
              </ul>
            </div>
          </div>
        )}
        <div
          style={ui.actions}
          className="mt-6 flex gap-2 justify-end shrink-0"
        >
          <button
            type="button"
            className="rounded-xl border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer shadow-2xs"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void apply(null)}
            className="rounded-xl border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer shadow-2xs"
          >
            No book
          </button>
          <button
            type="button"
            disabled={!bookId || busy}
            onClick={() => void apply(buildScope(bookId, ticked))}
            className="rounded-xl bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white shadow-2xs hover:bg-blue-700 transition-colors cursor-pointer disabled:opacity-50"
          >
            Use this
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

'use client'

import { useEffect, useState } from 'react'
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
        style={{
          font: 'inherit',
          border: '1px solid #ccc',
          borderRadius: 14,
          background: '#f6f6f6',
          padding: '2px 10px',
          cursor: 'pointer',
        }}
      >
        {scopeLabel(scope, book?.title, sections)}
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

  return (
    <div style={ui.backdrop}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose what this board studies"
        style={{
          ...ui.dialog,
          maxHeight: '80vh',
          overflow: 'auto',
          minWidth: 320,
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18 }}>
          What does this board study?
        </h2>
        {error && (
          <p role="alert" style={ui.alert}>
            {error}
          </p>
        )}
        {books === null ? (
          <p>Loading your books…</p>
        ) : books.length === 0 ? (
          <p>No indexed books yet. Add one in the library.</p>
        ) : (
          <label>
            Book{' '}
            <select
              value={bookId}
              onChange={(e) => {
                setBookId(e.target.value)
                setTicked(new Set())
              }}
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
        {bookId && sections.length > 0 && (
          <>
            <p style={ui.muted}>
              {ticked.size === 0
                ? 'The whole book'
                : `${ticked.size} section${ticked.size === 1 ? '' : 's'} chosen`}
              . Tick sections to focus on them.
            </p>
            <ul style={{ listStyle: 'none', padding: 0 }}>
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
          </>
        )}
        <div style={ui.actions}>
          <button
            type="button"
            disabled={!bookId || busy}
            onClick={() => void apply(buildScope(bookId, ticked))}
          >
            Use this
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void apply(null)}
          >
            No book
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

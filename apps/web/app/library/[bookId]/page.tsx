'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type Book,
  createLibraryApi,
  type Hit,
  type LibraryApi,
  type Section,
} from '../../../src/library/api'
import {
  buildScope,
  buildTree,
  scopeTitle,
  type TreeNode,
  toggle,
} from '../../../src/library/scope'
import { isInProgress, POLL_MS, statusText } from '../../../src/library/status'
import { SourceViewer } from '../SourceViewer'
import { Shell, ui } from '../ui'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE?.replace(/\/+$/, '')
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function BookPage() {
  const { bookId } = useParams<{ bookId: string }>()
  const api = useMemo(() => (API_BASE ? createLibraryApi(API_BASE) : null), [])
  if (!api)
    return (
      <Shell title="Book">
        <p role="alert">
          The library needs the server (set NEXT_PUBLIC_API_BASE).
        </p>
      </Shell>
    )
  return <BookView api={api} bookId={bookId} />
}

function BookView({ api, bookId }: { api: LibraryApi; bookId: string }) {
  const [book, setBook] = useState<Book | null>(null)
  const [sections, setSections] = useState<Section[]>([])
  const [error, setError] = useState<string | null>(null)
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set())
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{
    mode: 'hybrid' | 'keyword'
    hits: Hit[]
  } | null>(null)
  const [searching, setSearching] = useState(false)
  const [page, setPage] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([
        api.getBook(bookId),
        api.outline(bookId),
      ])
      setBook(b)
      setSections(s)
      setError(null)
    } catch (e) {
      setError(message(e))
    }
  }, [api, bookId])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (!book || !isInProgress(book.status)) return
    const t = setTimeout(() => void load(), POLL_MS)
    return () => clearTimeout(t)
  }, [book, load])

  async function runSearch() {
    if (!query.trim()) return
    setSearching(true)
    try {
      setResults(
        await api.search({
          query,
          bookId,
          sectionIds: ticked.size > 0 ? [...ticked] : undefined,
          k: 8,
        }),
      )
      setError(null)
    } catch (e) {
      setError(message(e))
    } finally {
      setSearching(false)
    }
  }
  async function study() {
    if (!book) return
    try {
      const board = await api.createBoard(
        scopeTitle(book.title, ticked, sections),
        buildScope(book.id, ticked),
      )
      // the editor opens the board whose id is stored here
      localStorage.setItem('whiteboard:boardId', board.id)
      location.assign('/')
    } catch (e) {
      setError(message(e))
    }
  }

  const tree = useMemo(() => buildTree(sections), [sections])
  const pages = book?.pages ?? 0
  return (
    <Shell title={book?.title ?? 'Book'}>
      {error && (
        <p role="alert" style={ui.alert}>
          {error}
        </p>
      )}
      {book && book.status !== 'ready' && (
        <p>
          {statusText(book)}. <Link href="/library">Back to the library</Link>
        </p>
      )}
      {book && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 24,
          }}
        >
          <div>
            <p style={ui.muted}>
              {pages} pages · {book.chunks} passages
            </p>
            <div style={ui.actions}>
              <button
                type="button"
                onClick={() => void study()}
                disabled={book.status !== 'ready'}
              >
                Study this
              </button>
              <span style={ui.muted}>
                {ticked.size === 0
                  ? 'the whole book'
                  : `${ticked.size} section${ticked.size === 1 ? '' : 's'} chosen`}
              </span>
              {ticked.size > 0 && (
                <button type="button" onClick={() => setTicked(new Set())}>
                  Clear
                </button>
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault()
                void runSearch()
              }}
              style={{ display: 'flex', gap: 8, margin: '14px 0' }}
            >
              <input
                type="search"
                aria-label="Search this book"
                placeholder="Search this book"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                dir="auto"
                style={{ flex: 1, minWidth: 0 }}
              />
              <button
                type="submit"
                disabled={searching || book.status !== 'ready'}
              >
                {searching ? 'Searching…' : 'Search'}
              </button>
            </form>
            {results && (
              <section aria-label="Search results">
                {results.mode === 'keyword' && (
                  <p style={ui.muted}>
                    Keyword matches only: meaning-based search is unavailable
                    right now.
                  </p>
                )}
                {results.hits.length === 0 && <p>Nothing found.</p>}
                <ol style={{ paddingLeft: 20 }}>
                  {results.hits.map((h) => (
                    <li key={h.chunkId} style={{ marginBottom: 8 }}>
                      <button
                        type="button"
                        onClick={() => h.pageStart && setPage(h.pageStart)}
                        style={{
                          all: 'unset',
                          cursor: 'pointer',
                          color: '#1a56db',
                        }}
                      >
                        {h.citeLabel}
                        {h.headingPath ? ` · ${h.headingPath}` : ''}
                      </button>
                      <div dir="auto" style={ui.muted}>
                        {h.text.slice(0, 280)}
                        {h.text.length > 280 ? '…' : ''}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <h2 style={{ fontSize: 17 }}>Contents</h2>
            {tree.length === 0 ? (
              <p style={ui.muted}>No sections yet.</p>
            ) : (
              <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
                {tree.map((n) => (
                  <Outline
                    key={n.section.id}
                    node={n}
                    ticked={ticked}
                    onTick={(id) => setTicked((t) => toggle(t, id))}
                    onOpen={setPage}
                  />
                ))}
              </ul>
            )}
          </div>
          <div style={{ position: 'sticky', top: 8, alignSelf: 'start' }}>
            {page !== null && pages > 0 ? (
              <SourceViewer
                api={api}
                bookId={bookId}
                page={page}
                pages={pages}
                onPage={setPage}
              />
            ) : (
              <p style={ui.muted}>
                Pick a search result or a section to read its page here.
              </p>
            )}
          </div>
        </div>
      )}
    </Shell>
  )
}

function Outline({
  node,
  ticked,
  onTick,
  onOpen,
}: {
  node: TreeNode
  ticked: ReadonlySet<number>
  onTick: (id: number) => void
  onOpen: (page: number) => void
}) {
  const s = node.section
  return (
    <li style={{ marginLeft: s.level > 1 ? 16 : 0, marginBottom: 4 }}>
      <label>
        <input
          type="checkbox"
          checked={ticked.has(s.id)}
          onChange={() => onTick(s.id)}
        />{' '}
        {s.title}
      </label>{' '}
      {s.pageStart !== null && (
        <button
          type="button"
          onClick={() => onOpen(s.pageStart as number)}
          style={{
            all: 'unset',
            cursor: 'pointer',
            color: '#1a56db',
            fontSize: 13,
          }}
        >
          pp. {s.pageStart}
          {s.pageEnd !== s.pageStart ? `–${s.pageEnd}` : ''}
        </button>
      )}
      {s.summary && (
        <details>
          <summary style={ui.muted}>Summary</summary>
          <div dir="auto" style={{ fontSize: 13 }}>
            {s.summary}
          </div>
        </details>
      )}
      {node.children.length > 0 && (
        <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
          {node.children.map((c) => (
            <Outline
              key={c.section.id}
              node={c}
              ticked={ticked}
              onTick={onTick}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

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
  toggle,
} from '../../../src/library/scope'
import { isInProgress, POLL_MS, statusText } from '../../../src/library/status'
import { useRefreshLoop } from '../../../src/library/useRefreshLoop'
import { BookIcon, SearchIcon, SparklesIcon } from '../../../src/ui/icons'
import { Outline } from '../Outline'
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
        <p role="alert" style={ui.alert}>
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
  useRefreshLoop(book && isInProgress(book.status) ? POLL_MS : null, load)

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
      localStorage.setItem('whiteboard:boardId', board.id) // so '/' opens it next time too
      location.assign(`/boards/${encodeURIComponent(board.id)}`)
    } catch (e) {
      setError(message(e))
    }
  }

  const tree = useMemo(() => buildTree(sections), [sections])
  const pages = book?.pages ?? 0

  const subtitle = book ? (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 font-medium">
      <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2.5 py-0.5 text-slate-700">
        <BookIcon size={12} className="text-slate-400" />
        {pages} pages
      </span>
      <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2.5 py-0.5 text-slate-700">
        {book.chunks} passages
      </span>
      {book.status === 'ready' && (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2.5 py-0.5 text-emerald-700 font-semibold">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Ready to study
        </span>
      )}
    </div>
  ) : undefined

  return (
    <Shell title={book?.title ?? 'Book'} subtitle={subtitle}>
      {error && (
        <p role="alert" style={ui.alert} className="mb-4">
          {error}
        </p>
      )}
      {book && book.status !== 'ready' && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 mb-6">
          {statusText(book)}.{' '}
          <Link
            href="/library"
            className="font-semibold underline hover:text-amber-900"
          >
            Back to the library
          </Link>
        </div>
      )}
      {book && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left Column: Actions, Search, Contents */}
          <div className="lg:col-span-7 flex flex-col gap-6">
            {/* Study bar card */}
            <div className="flex flex-wrap items-center gap-3 p-3.5 rounded-2xl border border-slate-200/90 bg-white shadow-2xs">
              <button
                type="button"
                onClick={() => void study()}
                disabled={book.status !== 'ready'}
                className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 active:scale-95 transition-all cursor-pointer disabled:opacity-50"
              >
                <SparklesIcon size={14} />
                <span>Study this</span>
              </button>
              <span className="text-xs font-medium text-slate-600">
                {ticked.size === 0
                  ? 'the whole book'
                  : `${ticked.size} section${ticked.size === 1 ? '' : 's'} chosen`}
              </span>
              {ticked.size > 0 && (
                <button
                  type="button"
                  onClick={() => setTicked(new Set())}
                  className="text-xs font-semibold text-blue-600 hover:text-blue-800 transition-colors cursor-pointer ml-auto"
                >
                  Clear
                </button>
              )}
            </div>

            {/* Search form */}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void runSearch()
              }}
              className="flex gap-2"
            >
              <div className="relative flex-1 min-w-0">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400">
                  <SearchIcon size={16} />
                </div>
                <input
                  type="search"
                  aria-label="Search this book"
                  placeholder="Search this book…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  dir="auto"
                  className="w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 transition-all font-sans"
                />
              </div>
              <button
                type="submit"
                disabled={searching || book.status !== 'ready'}
                className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-2xs hover:bg-slate-800 active:scale-95 transition-all cursor-pointer disabled:opacity-50"
              >
                {searching ? 'Searching…' : 'Search'}
              </button>
            </form>

            {/* Search Results */}
            {results && (
              <section
                aria-label="Search results"
                className="rounded-2xl border border-slate-200/90 bg-white p-4 shadow-2xs flex flex-col gap-3"
              >
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 m-0">
                    Search Results
                  </h3>
                  <span className="text-xs text-slate-500 font-medium">
                    {results.hits.length} hit
                    {results.hits.length === 1 ? '' : 's'}
                  </span>
                </div>
                {results.mode === 'keyword' && (
                  <p className="text-xs text-amber-700 bg-amber-50 p-2.5 rounded-lg border border-amber-200">
                    Keyword matches only: meaning-based search is unavailable
                    right now.
                  </p>
                )}
                {results.hits.length === 0 && (
                  <p className="text-xs text-slate-500 py-2">Nothing found.</p>
                )}
                <ol className="p-0 m-0 list-none space-y-3">
                  {results.hits.map((h) => (
                    <li
                      key={h.chunkId}
                      className="rounded-xl border border-slate-100 bg-slate-50/50 p-3 transition-colors hover:border-blue-200 hover:bg-blue-50/30"
                    >
                      <button
                        type="button"
                        onClick={() => h.pageStart && setPage(h.pageStart)}
                        className="font-semibold text-xs text-blue-600 hover:text-blue-800 underline underline-offset-2 cursor-pointer mb-1 block text-left"
                      >
                        {h.citeLabel}
                        {h.headingPath ? ` · ${h.headingPath}` : ''}
                      </button>
                      <div
                        dir="auto"
                        className="text-xs text-slate-600 leading-relaxed font-sans"
                      >
                        {h.text.slice(0, 280)}
                        {h.text.length > 280 ? '…' : ''}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {/* Table of Contents */}
            <div className="rounded-2xl border border-slate-200/90 bg-white p-4 sm:p-5 shadow-2xs flex flex-col gap-3">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                <h2 className="text-sm font-bold text-slate-900 m-0">
                  Contents
                </h2>
                <span className="text-xs text-slate-400 font-medium">
                  {sections.length} section{sections.length === 1 ? '' : 's'}
                </span>
              </div>
              {tree.length === 0 ? (
                <p className="text-xs text-slate-500 py-2">No sections yet.</p>
              ) : (
                <ul className="list-none pl-0 space-y-1">
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
          </div>

          {/* Right Column: Sticky Page Viewer */}
          <div className="lg:col-span-5 sticky top-6">
            <div className="rounded-2xl border border-slate-200/90 bg-white p-4 shadow-sm min-h-[480px] flex flex-col justify-center">
              {page !== null && pages > 0 ? (
                <SourceViewer
                  api={api}
                  bookId={bookId}
                  page={page}
                  pages={pages}
                  onPage={setPage}
                />
              ) : (
                <div className="flex flex-col items-center justify-center p-8 text-center text-slate-400 gap-3 my-auto">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
                    <BookIcon size={24} />
                  </div>
                  <p className="text-xs sm:text-sm font-medium text-slate-500 max-w-[220px] leading-relaxed">
                    Pick a search result or a section to read its page here.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Shell>
  )
}

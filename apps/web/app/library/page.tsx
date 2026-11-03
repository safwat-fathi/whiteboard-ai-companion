'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type Book,
  createLibraryApi,
  type Estimate,
  type LibraryApi,
  type PageRange,
  type PreviewPage,
} from '../../src/library/api'
import {
  formatUsd,
  isInProgress,
  methodSummary,
  parseRanges,
  pollDelay,
  r3Cost,
  statusText,
} from '../../src/library/status'
import { Shell, ui } from './ui'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE?.replace(/\/+$/, '')
const MAX_UPLOAD = 200 * 2 ** 20 // the server's limit
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function LibraryPage() {
  const api = useMemo(() => (API_BASE ? createLibraryApi(API_BASE) : null), [])
  if (!api)
    return (
      <Shell title="Library">
        <p role="alert">
          The library needs the server. Start it with <code>pnpm dev</code> and
          set <code>NEXT_PUBLIC_API_BASE</code> for the web app (see{' '}
          <code>.env.example</code>).
        </p>
      </Shell>
    )
  return <Library api={api} />
}

function Library({ api }: { api: LibraryApi }) {
  const [books, setBooks] = useState<Book[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const [indexing, setIndexing] = useState<Book | null>(null)

  const refresh = useCallback(async () => {
    try {
      setBooks(await api.listBooks())
      setError(null)
    } catch (e) {
      setError(message(e))
    }
  }, [api])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    const delay = pollDelay(books)
    if (delay === null) return
    const t = setTimeout(() => void refresh(), delay)
    return () => clearTimeout(t)
  }, [books, refresh])

  async function addFile(file: File) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf')
      return setError('Only PDF files can be added.')
    if (file.size > MAX_UPLOAD)
      return setError('That file is over the 200 MB limit.')
    setBusy(`Uploading ${file.name}…`)
    try {
      const book = await api.upload(file, file.name.replace(/\.pdf$/i, ''))
      await refresh()
      setIndexing(book)
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(null)
    }
  }
  async function act(run: () => Promise<unknown>) {
    try {
      await run()
      setError(null)
    } catch (e) {
      setError(message(e))
    }
    await refresh()
  }

  return (
    <Shell title="Library">
      {error && (
        <p role="alert" style={ui.alert}>
          {error}
        </p>
      )}
      <label
        style={{ ...ui.drop, ...(over ? ui.dropOver : {}) }}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const f = e.dataTransfer.files[0]
          if (f) void addFile(f)
        }}
      >
        <style>
          {'label:focus-within{outline:2px solid #1a56db;outline-offset:2px}'}
        </style>
        {busy ?? 'Drop a PDF here, or click to choose one'}
        <input
          type="file"
          accept="application/pdf,.pdf"
          style={ui.hiddenInput}
          disabled={busy !== null}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void addFile(f)
            e.target.value = ''
          }}
        />
      </label>

      <ul style={ui.list} aria-label="Books">
        {books.map((b) => (
          <li key={b.id} style={ui.card}>
            <div>
              <strong>{b.title}</strong>{' '}
              <span style={ui.muted}>{b.pages ?? '?'} pages</span>
            </div>
            <div>{statusText(b)}</div>
            {isInProgress(b.status) && (
              <progress
                max={1}
                value={b.progress}
                aria-label={`${b.title} progress`}
              />
            )}
            {methodSummary(b.methods) && (
              <div style={ui.muted}>Read as: {methodSummary(b.methods)}</div>
            )}
            {!!b.ingestMethod?.warnings?.length && (
              <div style={ui.muted}>
                The model cut off pages {b.ingestMethod.warnings.join(', ')}, so
                their text may be incomplete.
              </div>
            )}
            {b.ingestMethod?.notes?.map((n) => (
              <div key={n} style={ui.muted}>
                {n}
              </div>
            ))}
            <div style={ui.actions}>
              {b.status === 'uploaded' && (
                <button type="button" onClick={() => setIndexing(b)}>
                  Index…
                </button>
              )}
              {(b.status === 'failed' ||
                (b.status === 'ready' && !!b.ingestMethod?.notes?.length)) && (
                <button
                  type="button"
                  onClick={() => void act(() => api.retry(b.id))}
                >
                  Retry
                </button>
              )}
              {b.status === 'ready' && (
                <Link href={`/library/${b.id}`}>Open</Link>
              )}
              {!isInProgress(b.status) && (
                <button
                  type="button"
                  onClick={() => {
                    if (
                      confirm(
                        `Delete "${b.title}" and everything indexed from it?`,
                      )
                    )
                      void act(() => api.remove(b.id))
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          </li>
        ))}
        {books.length === 0 && !error && (
          <li style={ui.muted}>No books yet.</li>
        )}
      </ul>

      {indexing && (
        <EstimateDialog
          api={api}
          book={indexing}
          onClose={() => {
            setIndexing(null)
            void refresh()
          }}
        />
      )}
    </Shell>
  )
}

/** What indexing will do and cost, a look at pages before paying for anything, and the button that starts it. */
function EstimateDialog({
  api,
  book,
  onClose,
}: {
  api: LibraryApi
  book: Book
  onClose: () => void
}) {
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [r3Text, setR3Text] = useState('')
  const [previewText, setPreviewText] = useState('1')
  const [previews, setPreviews] = useState<PreviewPage[] | null>(null)
  const [working, setWorking] = useState<'preview' | 'start' | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    api
      .estimate(book.id)
      .then((e) => live && setEstimate(e))
      .catch((e) => live && setError(message(e)))
    return () => {
      live = false
    }
  }, [api, book.id])
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const ranges: PageRange[] | null = parseRanges(r3Text)
  const pages = book.pages ?? 0
  const outside = ranges?.find((r) => r.to > pages)
  const r3Usd = ranges ? r3Cost(ranges) : 0
  const needed = (estimate?.embedUsd ?? 0) + r3Usd
  const overBudget = estimate !== null && needed > estimate.dailyRemainingUsd
  const canStart =
    estimate !== null &&
    ranges !== null &&
    !outside &&
    !overBudget &&
    working === null

  async function preview() {
    const wanted = previewText
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1)
      .slice(0, 3)
    if (wanted.length === 0)
      return setError('Give up to three page numbers, such as 1, 40.')
    setWorking('preview')
    try {
      setPreviews(await api.preview(book.id, wanted))
      setError(null)
    } catch (e) {
      setError(message(e))
    } finally {
      setWorking(null)
    }
  }
  async function start() {
    setWorking('start')
    try {
      await api.index(book.id, ranges && ranges.length > 0 ? ranges : undefined)
      onClose()
    } catch (e) {
      setError(message(e))
      setWorking(null)
    }
  }

  return (
    <div style={ui.backdrop}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Index ${book.title}`}
        style={ui.dialog}
      >
        <h2 style={{ marginTop: 0 }}>Index “{book.title}”</h2>
        {error && (
          <p role="alert" style={ui.alert}>
            {error}
          </p>
        )}
        {!estimate && !error && <p>Looking at the pages…</p>}
        {estimate && (
          <>
            <p>
              {estimate.pages} pages. Pages with a text layer are read locally
              for free ({estimate.r1}). The other {estimate.r4} (
              {estimate.scanned} scanned, {estimate.mathDense} math-heavy) are
              read by a vision model (Muse, Meta; not billed here). Making the
              book searchable costs about {formatUsd(estimate.embedUsd)}{' '}
              (OpenRouter). Left of today’s budget:{' '}
              {formatUsd(estimate.dailyRemainingUsd)}.
            </p>
            <fieldset style={ui.fieldset}>
              <legend>Look first (free)</legend>
              <label>
                Pages{' '}
                <input
                  value={previewText}
                  onChange={(e) => setPreviewText(e.target.value)}
                  size={10}
                />
              </label>{' '}
              <button
                type="button"
                onClick={() => void preview()}
                disabled={working !== null}
              >
                {working === 'preview' ? 'Reading…' : 'Compare readings'}
              </button>
              {previews?.map((p) => (
                <div key={p.page} style={ui.preview}>
                  {/* biome-ignore lint/performance/noImgElement: a user's page raster from our own server */}
                  <img
                    src={api.pageImageUrl(book.id, p.page, 500)}
                    alt={`Page ${p.label}`}
                    style={{ width: 160, alignSelf: 'start' }}
                  />
                  <div>
                    <strong>Local text</strong>
                    <pre style={ui.pre}>{p.r1.text || '(nothing: a scan)'}</pre>
                  </div>
                  <div>
                    <strong>Vision model</strong>
                    <pre style={ui.pre}>
                      {'error' in p.r4
                        ? `Could not read: ${p.r4.error}`
                        : p.r4.text}
                    </pre>
                  </div>
                </div>
              ))}
            </fieldset>
            <fieldset style={ui.fieldset}>
              <legend>Optional paid OCR (R3)</legend>
              <label>
                Pages to read with paid OCR{' '}
                <input
                  value={r3Text}
                  onChange={(e) => setR3Text(e.target.value)}
                  placeholder="e.g. 1-9,20"
                  size={14}
                />
              </label>
              <div style={ui.muted}>
                About $0.002 a page, billed by OpenRouter. Leave empty to use
                only the free and Meta readings.
                {ranges === null && ' Use page ranges such as 1-9,20.'}
                {outside &&
                  ` Page ${outside.to} is past the last page (${pages}).`}
                {ranges &&
                  ranges.length > 0 &&
                  ` This would add about ${formatUsd(r3Usd)}.`}
                {overBudget && ' That is more than is left of today’s budget.'}
              </div>
            </fieldset>
          </>
        )}
        <div style={ui.actions}>
          <button
            type="button"
            onClick={() => void start()}
            disabled={!canStart}
          >
            {working === 'start' ? 'Starting…' : 'Index'}
          </button>
          <button type="button" ref={closeRef} onClick={onClose}>
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}

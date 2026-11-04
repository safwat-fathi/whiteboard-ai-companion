'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type Book,
  createLibraryApi,
  type LibraryApi,
} from '../../src/library/api'
import {
  isInProgress,
  methodSummary,
  pollDelay,
  statusText,
} from '../../src/library/status'
import { useRefreshLoop } from '../../src/library/useRefreshLoop'
import { UploadIcon } from '../../src/ui/icons'
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
  const delay = pollDelay(books)
  useRefreshLoop(delay === null ? null : error ? delay * 4 : delay, refresh) // slower while the server is failing

  async function addFile(file: File) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf')
      return setError('Only PDF files can be added.')
    if (file.size > MAX_UPLOAD)
      return setError('That file is over the 200 MB limit.')
    setBusy(`Uploading ${file.name}…`)
    try {
      const book = await api.upload(file, file.name.replace(/\.pdf$/i, ''))
      await refresh()
      await api.index(book.id)
      await refresh()
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
        className="group transition-all"
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
        <div className="flex flex-col items-center gap-2 pointer-events-none">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-blue-600 shadow-2xs group-hover:scale-105 transition-transform">
            <UploadIcon size={24} />
          </div>
          <span className="font-semibold text-slate-800 text-sm">
            {busy ?? 'Drop a PDF here, or click to choose one'}
          </span>
          <span className="text-xs text-slate-400">PDFs up to 200 MB</span>
        </div>
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
            <div className="flex items-center justify-between">
              <strong className="text-base text-slate-900 font-semibold">
                {b.title}
              </strong>{' '}
              <span
                style={ui.muted}
                className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium"
              >
                {b.pages ?? '?'} pages
              </span>
            </div>
            <div className="text-xs text-slate-600 font-medium">
              {statusText(b)}
            </div>
            {isInProgress(b.status) && (
              <progress
                max={1}
                value={b.progress}
                aria-label={`${b.title} progress`}
                className="w-full h-2 rounded-full overflow-hidden accent-blue-600"
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
                <button
                  type="button"
                  onClick={() => void act(() => api.index(b.id))}
                  className="rounded-xl bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-2xs hover:bg-blue-700 transition-colors cursor-pointer"
                >
                  Index
                </button>
              )}
              {(b.status === 'failed' ||
                (b.status === 'ready' && !!b.ingestMethod?.notes?.length)) && (
                <button
                  type="button"
                  onClick={() => void act(() => api.retry(b.id))}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-2xs hover:bg-slate-50 transition-colors cursor-pointer"
                >
                  Retry
                </button>
              )}
              {b.status === 'ready' && (
                <Link
                  href={`/library/${b.id}`}
                  className="rounded-xl bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-2xs hover:bg-blue-700 transition-colors inline-block"
                >
                  Open
                </Link>
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
                  className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 shadow-2xs hover:text-red-600 hover:border-red-200 transition-colors cursor-pointer ml-auto"
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
    </Shell>
  )
}

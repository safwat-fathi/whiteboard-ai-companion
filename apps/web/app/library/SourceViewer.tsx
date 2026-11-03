'use client'

import { useEffect, useState } from 'react'
import type { LibraryApi } from '../../src/library/api'
import { clampPage, pageCaption } from '../../src/library/viewer'

/**
 * One page of a book as the server rasterised it (cached on disk), with previous/next and the printed label under it.
 * Takes only a book and a page so the chat dock can mount it as its Source tab (M5).
 */
export function SourceViewer({
  api,
  bookId,
  page,
  pages,
  onPage,
}: {
  api: LibraryApi
  bookId: string
  page: number
  pages: number
  onPage: (page: number) => void
}) {
  const [label, setLabel] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    let live = true
    setLabel(null)
    setBroken(false)
    api
      .getPage(bookId, page)
      .then((p) => live && setLabel(p.label))
      .catch(() => {}) // the caption just stays without a label
    return () => {
      live = false
    }
  }, [api, bookId, page])

  return (
    <figure className="m-0 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/80 p-2 shadow-2xs">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(clampPage(page - 1, pages))}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 shadow-2xs transition-colors hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
        >
          Previous
        </button>
        <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
          <span>Page</span>
          <input
            type="number"
            min={1}
            max={pages}
            value={page}
            className="w-14 rounded-lg border border-slate-200 bg-white px-2 py-0.5 text-center text-xs font-bold text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            onChange={(e) => onPage(clampPage(Number(e.target.value), pages))}
          />
          <span className="text-slate-400 font-normal">of {pages}</span>
        </label>
        <button
          type="button"
          disabled={page >= pages}
          onClick={() => onPage(clampPage(page + 1, pages))}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 shadow-2xs transition-colors hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
        >
          Next
        </button>
      </div>
      {broken ? (
        <p
          role="alert"
          className="p-4 text-center text-xs font-medium text-red-600"
        >
          This page could not be shown.
        </p>
      ) : (
        <div className="flex justify-center rounded-2xl border border-slate-200 bg-white p-2 shadow-xs">
          <img
            src={api.pageImageUrl(bookId, page, 1200)}
            alt={`Page ${label ?? page}`}
            onError={() => setBroken(true)}
            className="max-w-full h-auto rounded-xl shadow-2xs object-contain"
          />
        </div>
      )}
      <figcaption className="text-center text-xs font-medium text-slate-500">
        {pageCaption({ label, page, pages })}
      </figcaption>
    </figure>
  )
}

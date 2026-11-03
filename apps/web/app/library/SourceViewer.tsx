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
    <figure style={{ margin: 0 }}>
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(clampPage(page - 1, pages))}
        >
          Previous
        </button>
        <label>
          Page{' '}
          <input
            type="number"
            min={1}
            max={pages}
            value={page}
            style={{ width: 70 }}
            onChange={(e) => onPage(clampPage(Number(e.target.value), pages))}
          />
        </label>
        <button
          type="button"
          disabled={page >= pages}
          onClick={() => onPage(clampPage(page + 1, pages))}
        >
          Next
        </button>
      </div>
      {broken ? (
        <p role="alert">This page could not be shown.</p>
      ) : (
        // biome-ignore lint/performance/noImgElement: the raster comes from our own server and is cached there
        <img
          src={api.pageImageUrl(bookId, page, 1200)}
          alt={`Page ${label ?? page}`}
          onError={() => setBroken(true)}
          style={{ maxWidth: '100%', border: '1px solid #ccc' }}
        />
      )}
      <figcaption style={{ color: '#555', fontSize: 13 }}>
        {pageCaption({ label, page, pages })}
      </figcaption>
    </figure>
  )
}

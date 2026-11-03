'use client'

import { useEffect, useState } from 'react'
import { SourceViewer } from '../../app/library/SourceViewer'
import type { LibraryApi } from '../library/api'

export type SourceRef = { bookId: string; page: number }

/** The dock's Source tab: the book page a citation points at, with the Book page's viewer. */
export function SourceTab({
  api,
  source,
  onPage,
}: {
  api: LibraryApi
  source: SourceRef | null
  onPage: (page: number) => void
}) {
  const [pages, setPages] = useState<{ bookId: string; n: number } | null>(null)
  const bookId = source?.bookId
  useEffect(() => {
    if (!bookId) return
    let live = true
    api.getBook(bookId).then(
      (b) => live && setPages({ bookId, n: b.pages ?? 0 }),
      () => live && setPages({ bookId, n: 0 }),
    )
    return () => {
      live = false
    }
  }, [api, bookId])

  if (!source)
    return (
      <p style={{ padding: 12, color: '#555', fontSize: 13 }}>
        Open a citation to see the book page here.
      </p>
    )
  const n = pages?.bookId === source.bookId ? pages.n : null
  if (n === null)
    return <p style={{ padding: 12, fontSize: 13 }}>Loading the book…</p>
  if (n === 0)
    return (
      <p role="alert" style={{ padding: 12, fontSize: 13 }}>
        That book is not available.
      </p>
    )
  return (
    <div style={{ padding: 8 }}>
      <SourceViewer
        api={api}
        bookId={source.bookId}
        page={source.page}
        pages={n}
        onPage={onPage}
      />
    </div>
  )
}

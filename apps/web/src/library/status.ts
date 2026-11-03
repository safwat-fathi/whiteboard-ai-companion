import type { Book, BookStatus, PageRange } from './api'

export const POLL_MS = 1500
const R3_USD_PER_PAGE = 0.00205 // mistral-ocr via OpenRouter, measured in S2

const RUNNING: BookStatus[] = [
  'queued',
  'extracting',
  'structuring',
  'embedding',
  'summarising',
]
export const isInProgress = (s: BookStatus): boolean => RUNNING.includes(s)

const pct = (p: number) => `${Math.round(p * 100)}%`

/** Where a book is, in words for a card. */
export function statusText(
  b: Pick<Book, 'status' | 'progress' | 'error' | 'chunks'>,
): string {
  switch (b.status) {
    case 'uploaded':
      return 'Not indexed yet'
    case 'queued':
      return 'Waiting to start'
    case 'extracting':
      return `Reading pages: ${pct(b.progress)}`
    case 'structuring':
      return `Cutting into passages: ${pct(b.progress)}`
    case 'embedding':
      return `Indexing for search: ${pct(b.progress)}`
    case 'summarising':
      return `Writing summaries: ${pct(b.progress)}`
    case 'ready':
      return `Ready: ${b.chunks} passages`
    case 'failed':
      return b.error ? `Failed: ${b.error}` : 'Failed'
  }
}

/** How the pages were read, leaving out the rungs that were not used. */
export function methodSummary(m: Book['methods']): string {
  return [
    m.R1 > 0 ? `local text ${m.R1}` : '',
    m.R4 > 0 ? `Muse ${m.R4}` : '',
    m.R3 > 0 ? `paid OCR ${m.R3}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** How long to wait before asking again, or null when nothing is running. */
export const pollDelay = (books: Pick<Book, 'status'>[]): number | null =>
  books.some((b) => isInProgress(b.status)) ? POLL_MS : null

export function formatUsd(x: number): string {
  if (x === 0) return '$0'
  return x >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(4)}`
}

/** "1-9,20" as ranges for the opt-in paid rung; '' is none; null when it is not that. */
export function parseRanges(spec: string): PageRange[] | null {
  if (!spec.trim()) return []
  const out: PageRange[] = []
  for (const part of spec.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim())
    if (!m) return null
    const from = Number(m[1])
    const to = Number(m[2] ?? m[1])
    if (from < 1 || to < from) return null
    out.push({ from, to, rung: 'R3' })
  }
  return out
}

/** About what the opt-in paid rung would cost for these ranges (overlaps counted once). */
export function r3Cost(ranges: PageRange[]): number {
  const pages = new Set<number>()
  for (const r of ranges) for (let p = r.from; p <= r.to; p++) pages.add(p)
  return pages.size * R3_USD_PER_PAGE
}

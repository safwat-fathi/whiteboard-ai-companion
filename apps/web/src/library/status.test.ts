import { describe, expect, it } from 'vitest'
import type { Book } from './api'
import {
  formatUsd,
  isInProgress,
  methodSummary,
  POLL_MS,
  parseRanges,
  pollDelay,
  r3Cost,
  statusText,
} from './status'

const book = (over: Partial<Book> = {}): Book => ({
  id: 'b',
  title: 'T',
  author: null,
  lang: null,
  pages: 10,
  status: 'uploaded',
  progress: 0,
  error: null,
  createdAt: 1,
  embedModel: null,
  ingestMethod: null,
  methods: { R1: 0, R3: 0, R4: 0 },
  chunks: 0,
  ...over,
})

describe('status', () => {
  it('knows which statuses are a job in flight', () => {
    for (const s of [
      'queued',
      'extracting',
      'structuring',
      'embedding',
      'summarising',
    ] as const)
      expect(isInProgress(s)).toBe(true)
    for (const s of ['uploaded', 'ready', 'failed'] as const)
      expect(isInProgress(s)).toBe(false)
  })

  it('says in words where a book is', () => {
    expect(statusText(book())).toBe('Not indexed yet')
    expect(statusText(book({ status: 'queued' }))).toBe('Waiting to start')
    expect(statusText(book({ status: 'extracting', progress: 0.3 }))).toBe(
      'Reading pages: 30%',
    )
    expect(statusText(book({ status: 'embedding', progress: 0.8 }))).toBe(
      'Indexing for search: 80%',
    )
    expect(statusText(book({ status: 'summarising', progress: 0.96 }))).toBe(
      'Writing summaries: 96%',
    )
    expect(statusText(book({ status: 'ready', chunks: 12 }))).toBe(
      'Ready: 12 passages',
    )
    expect(
      statusText(book({ status: 'failed', error: 'embedding: boom' })),
    ).toBe('Failed: embedding: boom')
    expect(statusText(book({ status: 'failed' }))).toBe('Failed')
  })

  it('summarises how pages were read and leaves out the empty rungs', () => {
    expect(methodSummary({ R1: 638, R3: 0, R4: 14 })).toBe(
      'local text 638 · Muse 14',
    )
    expect(methodSummary({ R1: 0, R3: 3, R4: 0 })).toBe('paid OCR 3')
    expect(methodSummary({ R1: 0, R3: 0, R4: 0 })).toBe('')
  })

  it('polls only while something is running', () => {
    expect(pollDelay([book(), book({ status: 'ready' })])).toBeNull()
    expect(pollDelay([book(), book({ status: 'embedding' })])).toBe(POLL_MS)
    expect(pollDelay([])).toBeNull()
  })

  it('formats money and prices the opt-in R3', () => {
    expect(formatUsd(0.0025)).toBe('$0.0025')
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(1.5)).toBe('$1.50')
    expect(
      r3Cost([
        { from: 1, to: 10, rung: 'R3' },
        { from: 5, to: 12, rung: 'R3' },
      ]),
    ).toBeCloseTo(12 * 0.00205, 10)
  })
})

describe('parseRanges', () => {
  it('reads "1-9,20" as R3 ranges and rejects anything else', () => {
    expect(parseRanges('1-9,20')).toEqual([
      { from: 1, to: 9, rung: 'R3' },
      { from: 20, to: 20, rung: 'R3' },
    ])
    expect(parseRanges(' 3 ')).toEqual([{ from: 3, to: 3, rung: 'R3' }])
    expect(parseRanges('')).toEqual([])
    for (const bad of ['x', '0', '5-2', '1-', '1,,2', '-3'])
      expect(parseRanges(bad)).toBeNull()
  })
})

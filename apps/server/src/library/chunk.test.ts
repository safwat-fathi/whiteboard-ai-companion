import { describe, expect, it } from 'vitest'
import type { SectionRow } from '../db'
import {
  type ChunkPage,
  chunkPages,
  embedInput,
  estimateTokens,
  ftsQuery,
  normaliseText,
} from './chunk'

describe('normaliseText', () => {
  it('folds Arabic variants, strips marks, maps digits and lower-cases Latin', () => {
    expect(normaliseText('إِذَا')).toBe('اذا') // hamza-alef + kasra + fatha
    expect(normaliseText('مدرسة')).toBe('مدرسه') // ta marbuta
    expect(normaliseText('على')).toBe('علي') // alef maqsura
    expect(normaliseText('كـــتاب')).toBe('كتاب') // tatweel
    expect(normaliseText('الفصل ٣ و ۴')).toBe('الفصل 3 و 4')
    expect(normaliseText('ﻻ')).toBe('لا') // presentation form, NFKC
    expect(normaliseText('The Cover-Up Method')).toBe('the cover-up method')
  })
})

describe('ftsQuery', () => {
  it('quotes the normalised tokens joined by OR and drops one-letter tokens', () => {
    expect(ftsQuery('How does the cover-up method work?')).toBe(
      '"how" OR "does" OR "the" OR "cover" OR "up" OR "method" OR "work"',
    )
    expect(ftsQuery('إذا كان a')).toBe('"اذا" OR "كان"')
  })
  it('is empty for punctuation only, so the caller can skip the keyword search', () => {
    expect(ftsQuery('?! -- ()')).toBe('')
    expect(ftsQuery('')).toBe('')
  })
  it('cannot be turned into FTS syntax by the user', () => {
    expect(ftsQuery('foo" OR bar* NEAR(a b) -c')).toBe(
      '"foo" OR "or" OR "bar" OR "near"',
    )
  })
})

const sec = (
  id: number,
  title: string,
  pageStart: number,
  pageEnd: number,
  parentId: number | null = null,
  level = parentId ? 2 : 1,
): SectionRow => ({
  id,
  bookId: 'b',
  parentId,
  ord: 0,
  level,
  title,
  pageStart,
  pageEnd,
  summary: null,
  tokens: null,
})
const page = (pageIndex: number, text: string, label?: string): ChunkPage => ({
  pageIndex,
  label: label ?? String(pageIndex),
  text,
})
const lines = (n: number, prefix = 'line') =>
  Array.from({ length: n }, (_, i) =>
    `${prefix} ${i} ${'word '.repeat(10)}`.trim(),
  )
const SMALL = { minTokens: 40, maxTokens: 80, overlapRatio: 0 }
const count = (s: string, sub: string) => s.split(sub).length - 1

describe('chunkPages', () => {
  it('keeps chunks within the token ceiling and numbers them in order', () => {
    const chunks = chunkPages(
      [page(1, lines(30).join('\n')), page(2, lines(30).join('\n'))],
      [sec(1, 'All', 1, 2)],
      SMALL,
    )
    expect(chunks.length).toBeGreaterThan(4)
    chunks.forEach((c, i) => {
      expect(c.ord).toBe(i)
      expect(c.tokens).toBeLessThanOrEqual(80)
      expect(c.tokens).toBe(estimateTokens(c.text))
    })
  })

  it('records the page range, printed labels and cite label across a page break', () => {
    const chunks = chunkPages(
      [page(4, lines(4).join('\n'), 'iv'), page(5, lines(4).join('\n'), 'v')],
      [],
    )
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      pageStart: 4,
      pageEnd: 5,
      citeLabel: 'pp. iv–v',
      sectionId: null,
      headingPath: '',
    })
    const one = chunkPages([page(7, 'a single page of text here', '3')], [])
    expect(one[0]?.citeLabel).toBe('p. 3')
  })

  it('assigns each page to its deepest section and writes the heading path', () => {
    const sections = [
      sec(1, 'Ch 1', 1, 2),
      sec(2, '1.1', 1, 1, 1),
      sec(3, '1.2', 2, 2, 1),
      sec(4, 'Ch 2', 3, 3),
    ]
    const chunks = chunkPages(
      [page(1, 'alpha'), page(2, 'beta'), page(3, 'gamma')],
      sections,
    )
    expect(chunks.map((c) => [c.sectionId, c.headingPath, c.text])).toEqual([
      [2, 'Ch 1 > 1.1', 'alpha'],
      [3, 'Ch 1 > 1.2', 'beta'],
      [4, 'Ch 2', 'gamma'],
    ])
  })

  it('leaves pages before the first section unsectioned and skips blank pages', () => {
    const chunks = chunkPages(
      [page(1, 'front matter'), page(2, ''), page(3, 'body text')],
      [sec(1, 'Ch 1', 3, 3)],
    )
    expect(chunks.map((c) => [c.sectionId, c.pageStart])).toEqual([
      [null, 1],
      [1, 3],
    ])
  })

  it('never splits a display equation, a table or a code fence', () => {
    const text = [
      ...lines(5),
      '$$',
      'x = \\frac{a}{b}',
      '+ y',
      '= z',
      '$$',
      ...lines(3),
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '| 3 | 4 |',
      ...lines(4),
      '```',
      'code line one',
      '',
      'code line two',
      '```',
      ...lines(5),
    ].join('\n')
    for (const max of [60, 80, 100, 120]) {
      const chunks = chunkPages([page(1, text)], [sec(1, 'S', 1, 1)], {
        minTokens: 20,
        maxTokens: max,
        overlapRatio: 0,
      })
      for (const c of chunks) {
        expect(count(c.text, '$$') % 2).toBe(0)
        expect(count(c.text, '```') % 2).toBe(0)
        const rows = c.text.split('\n').filter((l) => l.startsWith('|')).length
        expect([0, 4]).toContain(rows)
      }
    }
  })

  it('splits an over-long line at sentence ends and never inside $...$', () => {
    const sentence = (i: number) =>
      `Sentence ${i} says $x. y + z$ and then goes on for a while to take some room.`
    const long = Array.from({ length: 30 }, (_, i) => sentence(i)).join(' ')
    const chunks = chunkPages([page(1, long)], [sec(1, 'S', 1, 1)], SMALL)
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) {
      expect(count(c.text, '$') % 2).toBe(0)
      expect(c.tokens).toBeLessThanOrEqual(80)
    }
  })

  it('lets an atomic block bigger than the ceiling stand alone, whole', () => {
    const table = Array.from(
      { length: 40 },
      (_, i) => `| row ${i} | ${'x'.repeat(30)} |`,
    )
    const chunks = chunkPages(
      [page(1, [...lines(2), ...table, ...lines(2)].join('\n'))],
      [sec(1, 'S', 1, 1)],
      SMALL,
    )
    const big = chunks.find((c) => c.text.includes('| row 0 |'))
    expect(big?.text.split('\n').filter((l) => l.startsWith('|'))).toHaveLength(
      40,
    )
  })

  it('without overlap the chunks are the input, in order', () => {
    const input = [
      lines(25, 'a').join('\n'),
      '',
      lines(25, 'b').join('\n'),
    ].join('\n')
    const chunks = chunkPages([page(1, input)], [sec(1, 'S', 1, 1)], SMALL)
    expect(chunks.map((c) => c.text).join('\n')).toBe(
      input
        .split('\n')
        .filter((l) => l.trim())
        .join('\n'),
    )
  })

  it('repeats the tail of a chunk at the head of the next, within a section only', () => {
    const chunks = chunkPages(
      [page(1, lines(40).join('\n')), page(2, lines(10, 'other').join('\n'))],
      [sec(1, 'A', 1, 1), sec(2, 'B', 2, 2)],
      { minTokens: 40, maxTokens: 80, overlapRatio: 0.25 },
    )
    const a = chunks.filter((c) => c.sectionId === 1)
    expect(a.length).toBeGreaterThan(2)
    for (let i = 1; i < a.length; i++) {
      const prevLast = (a[i - 1] as { text: string }).text.split('\n').at(-1)
      expect((a[i] as { text: string }).text.split('\n')[0]).toBe(prevLast)
    }
    const firstOfB = chunks.find((c) => c.sectionId === 2)
    expect(firstOfB?.text).not.toContain('line')
  })

  it('stores the normalised copy for search and keeps $...$ in the display copy', () => {
    const [c] = chunkPages(
      [page(1, 'إِذَا كان $x^2$ موجباً')],
      [sec(1, 'S', 1, 1)],
    )
    expect(c?.text).toContain('$x^2$')
    expect(c?.textNorm).toBe('اذا كان $x^2$ موجبا')
  })
})

describe('embedInput', () => {
  it('puts the heading path before the text', () => {
    expect(embedInput({ headingPath: 'Ch 1 > 1.1', text: 'body' })).toBe(
      'Ch 1 > 1.1\nbody',
    )
    expect(embedInput({ headingPath: '', text: 'body' })).toBe('body')
  })
})

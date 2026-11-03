import { describe, expect, it } from 'vitest'
import { buildDigest, buildSelectionDetail } from './digest'
import { DEFAULT_STYLE, type Element } from './schema'

const OWNER = { kind: 'human' as const, id: 'owner' }
let zn = 0
const base = (
  id: string,
  x: number,
  y: number,
  over: Record<string, unknown> = {},
) => ({
  id,
  x,
  y,
  w: 100,
  h: 40,
  rotation: 0,
  z: `a${String(zn++).padStart(6, '0')}`,
  style: { ...DEFAULT_STYLE },
  locked: false,
  author: OWNER,
  v: 0,
  ...over,
})
const text = (id: string, x: number, y: number, t: string, over = {}) =>
  ({
    ...base(id, x, y, over),
    type: 'text',
    data: { text: t, size: 20, align: 'left', dir: 'auto' },
  }) as Element
const shape = (id: string, x: number, y: number, over = {}) =>
  ({
    ...base(id, x, y, over),
    type: 'shape',
    data: { kind: 'rect' },
  }) as Element
const math = (id: string, x: number, y: number, over = {}) =>
  ({
    ...base(id, x, y, over),
    type: 'math',
    data: { latex: '\\int_0^\\infty e^{-x}dx', display: true, size: 28 },
  }) as Element

/** 500 elements on a 25 x 20 grid of 150 x 100 cells: text, shapes and math in turn, every tenth drawn by the tutor. */
function board(n = 500): Element[] {
  zn = 0
  return Array.from({ length: n }, (_, i) => {
    const [x, y] = [(i % 25) * 150, Math.floor(i / 25) * 100]
    const over =
      i % 10 === 0 ? { author: { kind: 'agent', id: 'tutor:t8' } } : {}
    return i % 3 === 0
      ? text(`el_${i}`, x, y, `Label number ${i}`, over)
      : i % 3 === 1
        ? shape(`el_${i}`, x, y, over)
        : math(`el_${i}`, x, y, over)
  })
}

describe('buildDigest', () => {
  const els = board()
  const view = { x: 0, y: 0, w: 450, h: 250, zoom: 0.8 } // covers the first 3 columns and 3 rows
  const digest = buildDigest({
    title: 'Photosynthesis',
    seq: 1234,
    elements: els,
    viewport: view,
    selection: ['el_390', 'el_391'],
  })
  const lines = digest.split('\n')
  const rows = lines.filter((l) => /^el_\d+ \|/.test(l))

  it('opens with the board header, per-type counts, content, viewport and selection', () => {
    expect(lines[0]).toBe(
      'BOARD "Photosynthesis" · seq 1234 · 500 elements (text 167, shape 167, math 166)',
    )
    expect(lines[1]).toMatch(
      /^CONTENT \[0 0 3700 1940\] {3}VIEWPORT \[0 0 450 250\] zoom 0.8 {3}SELECTION el_390 el_391$/,
    )
    expect(lines[2]).toBe('id | type | x,y,w,h | by | detail')
  })

  it('lists the selection first, then what is in the viewport, then the rest, within 200 rows and about 3,000 tokens', () => {
    expect(rows.length).toBeLessThanOrEqual(200)
    expect(rows.length).toBeGreaterThan(100)
    expect(digest.length / 3).toBeLessThanOrEqual(3000)
    expect(rows[0]).toContain('el_390')
    expect(rows[1]).toContain('el_391')
    expect(
      rows
        .slice(2, 11)
        .map((r) => r.split(' | ')[0])
        .sort(),
    ).toEqual(
      [
        'el_0',
        'el_1',
        'el_2',
        'el_25',
        'el_26',
        'el_27',
        'el_50',
        'el_51',
        'el_52',
      ].sort(),
    )
  })

  it('says how many were left out and how to find them', () => {
    expect(lines.at(-1)).toBe(
      `(+${500 - rows.length} more not shown. Use get_elements with a region or type.)`,
    )
  })

  it("tells the tutor its own work from the student's, and keeps detail short", () => {
    expect(digest).toMatch(
      /el_0 \| text \| 0,0,100,40 \| AI t8 \| "Label number 0"/,
    )
    expect(digest).toMatch(
      /el_390 \| text \| 2250,1500,100,40 \| AI t8 \| "Label number 390"/,
    )
    expect(digest).toMatch(/el_1 \| shape \| 150,0,100,40 \| you \| rect/)
    expect(digest).toMatch(
      /el_2 \| math \| 300,0,100,40 \| you \| \\int_0\^\\infty e\^\{-x\}dx/,
    )
  })

  it('stays within about 3,000 tokens however long the texts are', () => {
    const long = Array.from({ length: 400 }, (_, i) =>
      text(`t${i}`, i * 10, 0, 'x'.repeat(500)),
    )
    const d = buildDigest({
      title: 'Long',
      seq: 1,
      elements: long,
      selection: [],
    })
    expect(d.length / 3).toBeLessThan(3200)
    expect(d).toMatch(/\(\+\d+ more not shown/)
  })

  it('a small board has no footer and an empty selection reads "none"', () => {
    const d = buildDigest({
      title: 'T',
      seq: 0,
      elements: [shape('a', 0, 0)],
      selection: [],
    })
    expect(d).toContain('SELECTION none')
    expect(d).not.toContain('more not shown')
    expect(
      buildDigest({ title: 'T', seq: 0, elements: [], selection: [] }),
    ).toContain('0 elements')
  })

  it('ignores selected ids that are not on the board', () => {
    const d = buildDigest({
      title: 'T',
      seq: 0,
      elements: [shape('a', 0, 0)],
      selection: ['a', 'ghost'],
    })
    expect(d).toContain('SELECTION a\n')
  })
})

describe('buildSelectionDetail', () => {
  it('gives the full data of the selected elements, and says what it left out', () => {
    const els = [
      text('a', 0, 0, 'hello'),
      shape('b', 0, 100),
      text('c', 0, 200, 'z'.repeat(2000)),
    ]
    const d = buildSelectionDetail(els, ['a', 'c', 'ghost'])
    expect(d).toContain('"id":"a"')
    expect(d).toContain('"text":"hello"')
    expect(d).not.toContain('"id":"b"')
    expect(d).not.toContain('ghost')
    expect(d.match(/z/g)?.length).toBeLessThan(700) // long text is cut in the detail
    const many = Array.from({ length: 300 }, (_, i) =>
      text(`m${i}`, 0, i, 'y'.repeat(100)),
    )
    const big = buildSelectionDetail(
      many,
      many.map((e) => e.id),
    )
    expect(big.length / 3).toBeLessThan(4200)
    expect(big).toMatch(/\(\+\d+ more selected elements not shown\)/)
  })
})

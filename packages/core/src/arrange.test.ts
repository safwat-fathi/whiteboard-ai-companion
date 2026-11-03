import { describe, expect, it } from 'vitest'
import { alignBatch, distributeBatch, stackBatch } from './arrange'
import { bounds } from './geometry'
import { applyBatch, createScene, type Scene } from './scene'
import type { Batch, Element } from './schema'
import { mk, stroke } from './test-utils'

const box = (id: string, x: number, y: number, w = 100, h = 40) =>
  mk(id, { x, y, w, h })
const arrowTo = (id: string, from: string, to: string): Element =>
  mk(id, {
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    data: {
      kind: 'arrow',
      points: [
        [0, 0],
        [10, 10],
      ],
      start: { id: from, fx: 1, fy: 0.5 },
      end: { id: to, fx: 0, fy: 0.5 },
    },
  })
/** Applies the batch to a copy and returns where every element ended up. */
const after = (scene: Scene, b: Batch | null) => {
  expect(b).not.toBeNull()
  const s = { els: new Map(scene.els) }
  applyBatch(s, b as Batch)
  return s
}
const at = (s: Scene, id: string) => {
  const e = s.els.get(id) as Element
  return { x: e.x, y: e.y }
}

describe('alignBatch', () => {
  const els = [
    box('a', 10, 100),
    box('b', 60, 20, 100, 40),
    box('c', 300, 220, 40, 100),
  ]
  const scene = () => createScene(els)

  it('left puts every left edge on the leftmost, right on the rightmost', () => {
    const sc = scene()
    const l = after(sc, alignBatch(sc, els, 'left'))
    expect(['a', 'b', 'c'].map((id) => at(l, id).x)).toEqual([10, 10, 10])
    const r = after(sc, alignBatch(sc, els, 'right'))
    // rightmost edge is c's 340
    expect(
      ['a', 'b', 'c'].map((id) => at(r, id).x + (sc.els.get(id) as Element).w),
    ).toEqual([340, 340, 340])
  })

  it('centre and middle put the centres on the centre of the whole group', () => {
    const sc = scene()
    const c = after(sc, alignBatch(sc, els, 'centre'))
    // group spans x 10..340: centre 175
    for (const id of ['a', 'b', 'c']) {
      const e = c.els.get(id) as Element
      expect(e.x + e.w / 2).toBeCloseTo(175, 6)
    }
    const m = after(sc, alignBatch(sc, els, 'middle'))
    // group spans y 20..320: middle 170
    for (const id of ['a', 'b', 'c']) {
      const e = m.els.get(id) as Element
      expect(e.y + e.h / 2).toBeCloseTo(170, 6)
    }
  })

  it('top and bottom', () => {
    const sc = scene()
    expect(
      ['a', 'b', 'c'].map(
        (id) => at(after(sc, alignBatch(sc, els, 'top')), id).y,
      ),
    ).toEqual([20, 20, 20])
    const b = after(sc, alignBatch(sc, els, 'bottom'))
    expect(
      ['a', 'b', 'c'].map((id) => at(b, id).y + (sc.els.get(id) as Element).h),
    ).toEqual([320, 320, 320])
  })

  it('moves only x for a horizontal align and only y for a vertical one, in one batch of patches', () => {
    const sc = scene()
    const b = alignBatch(sc, els, 'left') as Batch
    for (const op of b.ops) {
      expect(op.op).toBe('patch')
      if (op.op === 'patch') expect(Object.keys(op.set)).toEqual(['x'])
    }
    expect(b.label).toBe('Align left')
  })

  it('returns null when nothing would move', () => {
    const lined = [box('a', 10, 0), box('b', 10, 80)]
    expect(alignBatch(createScene(lined), lined, 'left')).toBeNull()
  })

  it('aligns by what is seen: a stroke counts with its ink reach', () => {
    const s = stroke('s', { x: 200, y: 0 }) // 100 x 50 box, pen width 2, ink reach beyond the box
    const r = box('r', 0, 0)
    const sc = createScene([s, r])
    const out = after(sc, alignBatch(sc, [s, r], 'left'))
    const [bs, br] = [
      bounds(out.els.get('s') as Element),
      bounds(out.els.get('r') as Element),
    ]
    expect(bs.minX).toBeCloseTo(br.minX, 6)
  })
})

describe('distributeBatch', () => {
  it('makes the gaps between neighbours equal, keeping the outer two where they are', () => {
    const els = [box('a', 0, 0), box('b', 50, 0), box('c', 400, 0)]
    const sc = createScene(els)
    const d = after(sc, distributeBatch(sc, els, 'horizontal'))
    // span 0..500, widths 300, gap (500-300)/2 = 100
    expect(['a', 'b', 'c'].map((id) => at(d, id).x)).toEqual([0, 200, 400])
  })

  it('works by position, not by the order the ids were given, and on the vertical axis', () => {
    const els = [
      box('c', 0, 300, 40, 100),
      box('a', 0, 0, 40, 100),
      box('b', 0, 120, 40, 100),
    ]
    const sc = createScene(els)
    const d = after(sc, distributeBatch(sc, els, 'vertical'))
    // span 0..400, heights 300, gap 50
    expect(['a', 'b', 'c'].map((id) => at(d, id).y)).toEqual([0, 150, 300])
  })

  it('needs three and returns null when already even', () => {
    const two = [box('a', 0, 0), box('b', 200, 0)]
    expect(distributeBatch(createScene(two), two, 'horizontal')).toBeNull()
    const even = [box('a', 0, 0), box('b', 150, 0), box('c', 300, 0)]
    expect(distributeBatch(createScene(even), even, 'horizontal')).toBeNull()
  })
})

describe('stackBatch', () => {
  const els = [box('c', 10, 200), box('a', 50, 10), box('b', 300, 120)]
  const sc = () => createScene(els)

  it('a column goes top to bottom by position at the gap, starting where the topmost is, left edges together', () => {
    const s = sc()
    const out = after(s, stackBatch(s, els, 'column', 24, 'start'))
    expect(['a', 'b', 'c'].map((id) => at(out, id))).toEqual([
      { x: 10, y: 10 },
      { x: 10, y: 74 },
      { x: 10, y: 138 },
    ])
  })

  it('a row goes left to right; centre and end align on the cross axis', () => {
    const rows = [box('a', 0, 0, 100, 40), box('b', 500, 300, 60, 100)]
    const s = createScene(rows)
    const out = after(s, stackBatch(s, rows, 'row', 10, 'centre'))
    expect(at(out, 'a').x).toBe(0)
    expect(at(out, 'b').x).toBe(110)
    // the group spans y 0..400: centre 200
    expect((out.els.get('a') as Element).y + 20).toBeCloseTo(200, 6)
    expect((out.els.get('b') as Element).y + 50).toBeCloseTo(200, 6)
    const end = after(s, stackBatch(s, rows, 'row', 10, 'end'))
    expect(at(end, 'a').y + 40).toBe(400)
    expect(at(end, 'b').y + 100).toBe(400)
  })

  it('patches only the coordinates that change: the first stays on its line, the last only goes up', () => {
    const s = sc()
    const b = stackBatch(s, els, 'column', 24, 'start') as Batch
    const sets = Object.fromEntries(
      b.ops.flatMap((o) =>
        o.op === 'patch' ? [[o.id, Object.keys(o.set).sort()]] : [],
      ),
    )
    expect(sets).toEqual({ a: ['x'], b: ['x', 'y'], c: ['y'] })
    expect(b.label).toBe('Stack column')
  })
})

describe('arrows attached to what moved', () => {
  it('follow their boxes in the same batch', () => {
    const els = [box('a', 0, 0), box('b', 300, 200), arrowTo('arr', 'a', 'b')]
    const sc = createScene(els)
    const b = alignBatch(
      sc,
      [els[0] as Element, els[1] as Element],
      'top',
    ) as Batch
    const patched = b.ops
      .filter((o) => o.op === 'patch')
      .map((o) => (o.op === 'patch' ? o.id : ''))
    expect(patched).toContain('arr')
    const out = after(sc, b)
    const arr = out.els.get('arr') as Element
    // a and b are now both at y 0: a (100x40) leaves at its right-middle (100, 20), b (100x40) enters at its left-middle (300, 20)
    expect(arr.y).toBeCloseTo(20, 6)
    expect(arr.x).toBeCloseTo(100, 6)
    expect(arr.w).toBeCloseTo(200, 6)
    expect(arr.h).toBeCloseTo(0, 6)
  })

  it('an arrow in the list is moved with the rest and not rerouted twice', () => {
    const els = [box('a', 0, 0), box('b', 300, 200), arrowTo('arr', 'a', 'b')]
    const sc = createScene(els)
    const b = alignBatch(sc, els, 'left') as Batch
    expect(
      b.ops.filter((o) => o.op === 'patch' && o.id === 'arr'),
    ).toHaveLength(1)
  })

  it('arrows the caller may not edit are left alone', () => {
    const els = [box('a', 0, 0), box('b', 300, 200), arrowTo('arr', 'a', 'b')]
    const sc = createScene(els)
    const b = alignBatch(sc, [els[0] as Element, els[1] as Element], 'top', {
      mayEdit: (e) => e.id !== 'arr',
    }) as Batch
    expect(b.ops.some((o) => o.op === 'patch' && o.id === 'arr')).toBe(false)
  })
})

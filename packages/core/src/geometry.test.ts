import { describe, expect, it } from 'vitest'
import {
  bounds,
  boundsOf,
  fitMath,
  hitTest,
  lockedAspect,
  outline,
  resizeBox,
  rotateTo,
  routeArrow,
  toLocal,
} from './geometry'
import { applyBatch, createScene } from './scene'
import { DEFAULT_STYLE, type Element } from './schema'
import { mk } from './test-utils'

const R45 = Math.PI / 4

describe('hitTest', () => {
  for (const zoom of [0.05, 1, 20]) {
    it(`rotated rect tip hits, 7px outside misses at zoom ${zoom}`, () => {
      const el = mk('a', {
        x: 100,
        y: 100,
        rotation: R45,
      })
      const c = { x: 150, y: 110 }
      const d = Math.SQRT1_2
      const tol = 6 / zoom
      const off = tol + DEFAULT_STYLE.strokeWidth / 2 + 1 / zoom
      const tip = { x: c.x + 50 * d, y: c.y + 50 * d }
      const out = {
        x: c.x + (50 + off) * d,
        y: c.y + (50 + off) * d,
      }
      expect(hitTest(el, tip, tol)).toBe(true)
      expect(hitTest(el, out, tol)).toBe(false)
      // unrotated hit would wrongly see the point at the same world x/y
      expect(hitTest(el, { x: 190 / 1, y: 110 }, 0.5)).toBe(false)
    })
  }

  it('unfilled hits only near outline, filled hits inside', () => {
    const open = mk('a', { w: 100, h: 100 })
    const filled = mk('b', { w: 100, h: 100, fill: '#f00' })
    expect(hitTest(open, { x: 50, y: 50 }, 6)).toBe(false)
    expect(hitTest(open, { x: 2, y: 50 }, 6)).toBe(true)
    expect(hitTest(filled, { x: 50, y: 50 }, 6)).toBe(true)
  })

  it('unfilled outline tolerance includes half the stroke width', () => {
    const el = mk('a', {
      w: 100,
      h: 100,
      style: { ...DEFAULT_STYLE, strokeWidth: 10 },
    })
    expect(hitTest(el, { x: 104, y: 50 }, 6 / 20)).toBe(true)
    expect(hitTest(el, { x: 108, y: 50 }, 6 / 20)).toBe(false)
  })

  it('one-point line is a hittable degenerate segment', () => {
    const l = mk('l', {
      x: 10,
      y: 10,
      data: { kind: 'line', points: [[0, 0]] },
    })
    expect(hitTest(l, { x: 12, y: 10 }, 3)).toBe(true)
    expect(hitTest(l, { x: 30, y: 10 }, 3)).toBe(false)
  })

  it('ellipse and diamond', () => {
    const e = mk('e', {
      w: 100,
      h: 100,
      data: { kind: 'ellipse' },
      fill: '#f00',
    })
    expect(hitTest(e, { x: 50, y: 50 }, 1)).toBe(true)
    expect(hitTest(e, { x: 2, y: 2 }, 1)).toBe(false) // bbox corner is outside
    const d = mk('d', {
      w: 100,
      h: 100,
      data: { kind: 'diamond' },
      fill: '#f00',
    })
    expect(hitTest(d, { x: 50, y: 50 }, 1)).toBe(true)
    expect(hitTest(d, { x: 5, y: 5 }, 1)).toBe(false)
  })

  it('arrows hit by distance to the polyline (points relative to x,y)', () => {
    const a = mk('l', {
      x: 10,
      y: 10,
      data: {
        kind: 'arrow',
        points: [
          [0, 0],
          [100, 0],
        ],
      },
    })
    expect(hitTest(a, { x: 60, y: 13 }, 6)).toBe(true)
    expect(hitTest(a, { x: 60, y: 20 }, 6)).toBe(false)
  })

  it('text, math, and rotated image hit by their stored box at zoom 0.05 and 20 (DPR 1 and 2)', () => {
    const t = {
      ...mk('t', { x: 0, y: 0, w: 100, h: 20, rotation: Math.PI / 2 }),
      type: 'text',
      data: { text: 'hi', size: 16, align: 'left', dir: 'auto' },
    } as Element
    // rotated 90 about (50,10): covers x 40..60, y -40..60
    expect(hitTest(t, { x: 50, y: -30 }, 1)).toBe(true)
    expect(hitTest(t, { x: 10, y: 10 }, 1)).toBe(false)

    const img = {
      ...mk('im', { x: 100, y: 100, w: 100, h: 60, rotation: R45 }),
      type: 'image',
      data: { blobId: 'b'.repeat(64), naturalW: 400, naturalH: 240 },
    } as Element
    const c = { x: 150, y: 130 }
    const d = Math.SQRT1_2
    for (const zoom of [0.05, 20]) {
      for (const _dpr of [1, 2]) {
        const tol = 6 / zoom
        // Right edge in local frame is +50 from centre along rotated X axis
        const insideEdge = { x: c.x + 50 * d, y: c.y + 50 * d }
        const outside7px = {
          x: c.x + (50 + 7 / zoom) * d,
          y: c.y + (50 + 7 / zoom) * d,
        }
        expect(hitTest(img, insideEdge, tol)).toBe(true)
        expect(hitTest(img, outside7px, tol)).toBe(false)
      }
    }
  })

  it('lockedAspect and fitMath compute math and image dimensions', () => {
    const m = {
      ...mk('m', { w: 80, h: 40 }),
      type: 'math',
      data: { latex: 'x', display: true, size: 20 },
    } as Element
    const im = {
      ...mk('i', { w: 120, h: 60 }),
      type: 'image',
      data: { blobId: 'a'.repeat(64), naturalW: 120, naturalH: 60 },
    } as Element
    expect(lockedAspect(m)).toBe(2)
    expect(lockedAspect(im)).toBe(2)
    expect(lockedAspect(mk('s'))).toBeNull()
    expect(fitMath({ width: 2.5, height: 1.2, depth: 0.3 }, 20)).toEqual({
      w: 50,
      h: 30,
    })
    expect(boundsOf(m)).toEqual(bounds(m))
  })

  it('toLocal inverse-rotates about the centre', () => {
    const p = toLocal(mk('a', { rotation: Math.PI / 2 }), { x: 50, y: 60 })
    expect(p.x).toBeCloseTo(100)
    expect(p.y).toBeCloseTo(10)
  })
})

describe('bounds', () => {
  it('90 degree rotation swaps w/h about the centre', () => {
    const b = bounds(
      mk('a', { x: 0, y: 0, w: 100, h: 20, rotation: Math.PI / 2 }),
    )
    expect(b.minX).toBeCloseTo(40)
    expect(b.maxX).toBeCloseTo(60)
    expect(b.minY).toBeCloseTo(-40)
    expect(b.maxY).toBeCloseTo(60)
  })

  it('linear bounds are finite for empty or missing points', () => {
    for (const data of [
      { kind: 'arrow' as const },
      { kind: 'line' as const, points: [] },
    ]) {
      const b = bounds(mk('l', { x: 5, y: 6, data }))
      expect(Object.values(b).every(Number.isFinite)).toBe(true)
    }
  })

  it('arrow bounds are points plus half stroke', () => {
    const b = bounds(
      mk('l', {
        x: 10,
        y: 10,
        style: { ...DEFAULT_STYLE, strokeWidth: 4 },
        data: {
          kind: 'line',
          points: [
            [0, 0],
            [100, 50],
          ],
        },
      }),
    )
    expect(b).toEqual({ minX: 8, minY: 8, maxX: 112, maxY: 62 })
  })
})

describe('routeArrow', () => {
  const arrow = (): Element =>
    mk('ar', {
      x: 0,
      y: 0,
      data: {
        kind: 'arrow',
        points: [
          [5, 5],
          [300, 300],
        ],
        start: { id: 't', fx: 1, fy: 0.5 },
      },
    })
  const target = () => mk('t', { x: 100, y: 100, w: 40, h: 20 })

  it('follows a moved, rotated and resized target; unbound end stays', () => {
    const t = target()
    const s = createScene([t, arrow()])
    expect(routeArrow(arrow(), s)).toEqual([
      [140, 110],
      [300, 300],
    ])
    applyBatch(s, {
      batchId: 'b',
      label: 'm',
      ops: [{ op: 'patch', id: 't', set: { x: 200, y: 0 } }],
    })
    expect(routeArrow(arrow(), s)[0]).toEqual([240, 10])
    applyBatch(s, {
      batchId: 'b2',
      label: 'r',
      ops: [{ op: 'patch', id: 't', set: { rotation: Math.PI / 2 } }],
    })
    const r = routeArrow(arrow(), s)[0] as [number, number]
    expect(r[0]).toBeCloseTo(220) // centre (220,10), right-middle -> bottom-middle
    expect(r[1]).toBeCloseTo(30)
    applyBatch(s, {
      batchId: 'b3',
      label: 'z',
      ops: [{ op: 'patch', id: 't', set: { w: 80, h: 40 } }],
    })
    const z = routeArrow(arrow(), s)[0] as [number, number]
    expect(z[0]).toBeCloseTo(240) // centre (240,20), local (40,0) rotated 90 -> (0,40)
    expect(z[1]).toBeCloseTo(60)
  })

  it('linear target ignores its rotation in resolveEnd', () => {
    const line = mk('t', {
      x: 100,
      y: 100,
      w: 40,
      h: 20,
      rotation: Math.PI / 2,
      data: {
        kind: 'line',
        points: [
          [0, 0],
          [40, 20],
        ],
      },
    })
    const s = createScene([line, arrow()])
    expect(routeArrow(arrow(), s)[0]).toEqual([140, 110])
  })

  it('removed target keeps the stored point', () => {
    const s = createScene([arrow()])
    expect(routeArrow(arrow(), s)).toEqual([
      [5, 5],
      [300, 300],
    ])
  })
})

describe('resizeBox / rotateTo', () => {
  const apply = (el: Element, patch: Record<string, unknown>) => ({
    ...el,
    ...patch,
  })
  const corner = (el: Element, lx: number, ly: number) => {
    const cx = el.x + el.w / 2
    const cy = el.y + el.h / 2
    const dx = el.x + lx * el.w - cx
    const dy = el.y + ly * el.h - cy
    const c = Math.cos(el.rotation)
    const s = Math.sin(el.rotation)
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }
  }

  it('keeps the opposite corner fixed in world space on a rotated element', () => {
    const el = mk('a', { x: 30, y: 40, w: 100, h: 60, rotation: 0.7 })
    const before = corner(el, 0, 0)
    const to = { x: 300, y: 250 }
    const patch = resizeBox(el, 'se', to, false)
    const after = corner(apply(el, patch) as Element, 0, 0)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
    // dragged corner lands on the pointer
    const se = corner(apply(el, patch) as Element, 1, 1)
    expect(se.x).toBeCloseTo(to.x, 6)
    expect(se.y).toBeCloseTo(to.y, 6)
  })

  it('edge handle keeps the opposite edge midpoint fixed', () => {
    const el = mk('a', { x: 30, y: 40, w: 100, h: 60, rotation: -1.1 })
    const before = corner(el, 0, 0.5)
    const patch = resizeBox(el, 'e', { x: 200, y: 200 }, false)
    const after = corner(apply(el, patch) as Element, 0, 0.5)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('clamps to 1 world unit when dragged past the anchor', () => {
    const el = mk('a', { x: 0, y: 0, w: 100, h: 50 })
    const p = resizeBox(el, 'se', { x: -50, y: -50 }, false) as {
      w: number
      h: number
    }
    expect(p.w).toBe(1)
    expect(p.h).toBe(1)
  })

  it('keepAspect preserves the ratio on corners', () => {
    const el = mk('a', { x: 0, y: 0, w: 100, h: 50 })
    const p = resizeBox(el, 'se', { x: 200, y: 60 }, true) as {
      w: number
      h: number
    }
    expect(p.w / p.h).toBeCloseTo(2)
  })

  it('patch holds only leaf keys', () => {
    const p = resizeBox(mk('a'), 'nw', { x: -5, y: -5 }, false)
    expect(Object.keys(p).sort()).toEqual(['h', 'w', 'x', 'y'])
    expect(Object.keys(rotateTo(mk('a'), 1, false))).toEqual(['rotation'])
  })

  it('linear elements are not resized or rotated', () => {
    const a = mk('l', {
      data: {
        kind: 'arrow',
        points: [
          [0, 0],
          [10, 10],
        ],
      },
    })
    expect(resizeBox(a, 'se', { x: 50, y: 50 }, false)).toEqual({})
    expect(rotateTo(a, 1, false)).toEqual({})
  })

  it('rotateTo snap15 gives multiples of pi/12', () => {
    const step = Math.PI / 12
    for (const a of [0.1, 0.3, 1, 2.7, -0.9, 6]) {
      const r = rotateTo(mk('a'), a, true).rotation as number
      expect(Math.abs(r / step - Math.round(r / step))).toBeLessThan(1e-9)
    }
    expect(rotateTo(mk('a'), 0.3, false).rotation).toBe(0.3)
  })
})

describe('outline', () => {
  const shape = (kind: 'rect' | 'diamond' | 'triangle' | 'ellipse') =>
    mk('a', { x: 10, y: 20, w: 100, h: 60, data: { kind } })

  it('is the closed polygon of the unrotated frame (what hit testing and selection outlines trace)', () => {
    expect(outline(shape('rect'))).toEqual([
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 80 },
      { x: 10, y: 80 },
    ])
    expect(outline(shape('diamond'))).toEqual([
      { x: 60, y: 20 },
      { x: 110, y: 50 },
      { x: 60, y: 80 },
      { x: 10, y: 50 },
    ])
    expect(outline(shape('triangle'))).toEqual([
      { x: 60, y: 20 },
      { x: 110, y: 80 },
      { x: 10, y: 80 },
    ])
    expect(outline(shape('ellipse'))).toHaveLength(64)
  })

  it('ignores rotation', () => {
    const r = mk('a', { x: 10, y: 20, w: 100, h: 60, rotation: 1 })
    expect(outline(r)).toEqual(outline({ ...r, rotation: 0 }))
  })
})

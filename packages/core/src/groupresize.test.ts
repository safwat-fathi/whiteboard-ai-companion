import { describe, expect, it } from 'vitest'
import { bounds } from './geometry'
import { resizeGroup } from './groupresize'
import { nodePlatform, registerBundledFonts } from './node'
import { applyBatch, createScene } from './scene'
import type { Element } from './schema'
import { chart, mk, stroke } from './test-utils'

registerBundledFonts()
const platform = nodePlatform()
const box = (id: string, x: number, y: number, w = 100, h = 40) =>
  mk(id, { x, y, w, h })
const text = (id: string, x: number, y: number, size = 20) =>
  mk(id, {
    x,
    y,
    w: 80,
    h: 28,
    type: 'text',
    data: { text: 'hello', size, align: 'left', dir: 'auto' },
  } as never)
const run = (
  els: Element[],
  handle: Parameters<typeof resizeGroup>[1],
  to: { x: number; y: number },
  keep = false,
) => resizeGroup(els, handle, to, keep, platform)
const num = (p: Record<string, unknown> | undefined, k: string) =>
  p?.[k] as number

describe('resizeGroup', () => {
  const a = box('a', 0, 0)
  const b = box('b', 100, 60) // the group spans 0..200 x 0..100

  it('scales boxes and their positions about the opposite corner', () => {
    const p = run([a, b], 'se', { x: 400, y: 200 })
    expect(p?.get('a')).toEqual({ x: 0, y: 0, w: 200, h: 80 })
    expect(p?.get('b')).toEqual({ x: 200, y: 120, w: 200, h: 80 })
  })

  it('an edge handle scales one axis; the opposite edge stays put', () => {
    const p = run([a, b], 'w', { x: -200, y: 50 })
    // box 0..200 becomes -200..200: x scale 2, anchored on the right edge (200)
    expect(p?.get('a')).toEqual({ x: -200, y: 0, w: 200, h: 40 })
    expect(p?.get('b')).toEqual({ x: 0, y: 60, w: 200, h: 40 })
  })

  it('shift keeps the aspect ratio on a corner', () => {
    const p = run([a, b], 'se', { x: 400, y: 120 }, true)
    // sx 2, sy 1.2: the larger wins, both 2
    expect(p?.get('b')).toEqual({ x: 200, y: 120, w: 200, h: 80 })
  })

  it('lines and arrows scale their points, strokes scale theirs, charts and pictures keep their aspect', () => {
    const line = mk('l', {
      x: 0,
      y: 0,
      w: 100,
      h: 50,
      data: {
        kind: 'line',
        points: [
          [0, 0],
          [100, 50],
        ],
      },
    } as never)
    const pen = stroke('s', { x: 100, y: 50 }) // 100 x 50, points (0,0) (50,25) (100,50)
    const ch = chart('c', { x: 0, y: 100, w: 200, h: 100 })
    const p = run([line, pen, ch], 'se', { x: 400, y: 400 })
    // (the box is the seen bounds, a little wider than the boxes: the factor is about 2, not exactly)
    const f = num(p?.get('l'), 'w') / 100
    expect(f).toBeGreaterThan(1.9)
    expect(f).toBeLessThan(2.1)
    const lp = p?.get('l')?.['data.points'] as number[][]
    expect(lp[1]?.[0]).toBeCloseTo(100 * f, 1)
    expect(lp[1]?.[1]).toBeCloseTo(50 * (num(p?.get('l'), 'h') / 50), 1)
    const sp = p?.get('s')?.['data.points'] as number[][]
    expect(sp).toHaveLength(3)
    expect(sp[2]?.[0]).toBeCloseTo(num(p?.get('s'), 'w'), 0) // the last point is the box's far corner
    expect(num(p?.get('c'), 'w') / num(p?.get('c'), 'h')).toBeCloseTo(2, 3) // aspect kept
    // an x-only drag: the chart scales by the smaller factor, so it stays the same shape and does not grow
    const wide = run([line, ch], 'e', { x: 400, y: 100 })
    expect(num(wide?.get('c'), 'w') / num(wide?.get('c'), 'h')).toBeCloseTo(
      2,
      6,
    )
    expect(num(wide?.get('c'), 'h')).toBeCloseTo(100, 1) // sy is 1
  })

  it('text and formulas scale their font size by the smaller factor, and text keeps its layout box', () => {
    const t = text('t', 0, 0, 20)
    const m = mk('m', {
      x: 100,
      y: 0,
      w: 60,
      h: 30,
      type: 'math',
      data: { latex: 'x', display: true, size: 28 },
    } as never)
    const p = run([t, m], 'se', { x: 400, y: 60 }) // box 0..160 x 0..30: sx 2.5, sy 2
    expect(num(p?.get('t'), 'data.size')).toBe(40) // 20 * min(2.5, 2)
    expect(num(p?.get('m'), 'data.size')).toBe(56)
    expect(num(p?.get('t'), 'w')).toBeGreaterThan(80) // laid out at the new size
  })

  it('keeps the group box at least 1 across, however far it is dragged past the other side', () => {
    const p = run([a, b], 'se', { x: -500, y: -500 })
    for (const id of ['a', 'b']) {
      expect(num(p?.get(id), 'w')).toBeGreaterThan(0)
      expect(num(p?.get(id), 'h')).toBeGreaterThan(0)
      expect(Number.isFinite(num(p?.get(id), 'x'))).toBe(true)
    }
  })

  it('refuses a locked member, a single element and a gesture that changes nothing', () => {
    expect(
      run([a, mk('k', { x: 100, y: 60, locked: true })], 'se', {
        x: 400,
        y: 200,
      }),
    ).toBeNull()
    expect(run([a], 'se', { x: 400, y: 200 })).toBeNull()
    expect(run([a, b], 'se', { x: 200, y: 100 })).toBeNull()
  })

  it('applies as one batch and its inverse restores everything', () => {
    const els = [a, b, text('t', 20, 200), stroke('s', { x: 300, y: 20 })]
    const scene = createScene(els)
    const p = run(els, 'se', { x: 640, y: 480 }) as Map<
      string,
      Record<string, unknown>
    >
    const b0 = els.map((e) => bounds(e))
    const { inverse } = applyBatch(scene, {
      batchId: 'r',
      label: 'Resize',
      ops: [...p].map(([id, set]) => ({ op: 'patch' as const, id, set })),
    })
    expect(bounds(scene.els.get('b') as Element)).not.toEqual(b0[1])
    applyBatch(scene, inverse)
    expect(els.map((e) => bounds(scene.els.get(e.id) as Element))).toEqual(b0)
  })
})

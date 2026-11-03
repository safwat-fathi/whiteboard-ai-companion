import { describe, expect, it } from 'vitest'
import { bounds } from '../geometry'
import { nodePlatform } from '../node'
import { applyBatch, createScene } from '../scene'
import type { Element } from '../schema'
import { mk } from '../test-utils'
import { describeElement } from './describe'
import { coreTools } from './index'
import { ELEMENT_BUDGET, type ToolCtx } from './registry'
import { drawStroke } from './stroke'

const ctx = (els: Element[] = [], over: Partial<ToolCtx> = {}): ToolCtx => ({
  scene: createScene(els),
  platform: nodePlatform(),
  turnId: 't1',
  author: { kind: 'agent', id: 'tutor:t1' },
  grantedIds: new Set(),
  selection: [],
  added: 0,
  ...over,
})
const run = async (input: unknown, c = ctx()) => {
  const out = await drawStroke.execute(drawStroke.input.parse(input), c)
  if (out.kind !== 'write') throw new Error('not a write')
  applyBatch(c.scene, out.batch) // also validates every element and op
  return { out, c }
}
const freehand = (c: ToolCtx, id: string) => {
  const el = c.scene.els.get(id)
  if (el?.type !== 'freehand') throw new Error('not a freehand element')
  return el
}
const underline = [
  [100, 200],
  [150, 260],
  [200, 200],
]

describe('draw_stroke', () => {
  it('stores the points relative to their tight box, put where the placement says, whatever frame they were given in', async () => {
    const { out, c } = await run({
      points: underline,
      placement: { x: 10, y: 20 },
    })
    const el = freehand(c, out.ids[0] as string)
    expect(el).toMatchObject({
      x: 10,
      y: 20,
      w: 100,
      h: 60,
      rotation: 0,
      locked: false,
      author: { kind: 'agent', id: 'tutor:t1' },
      data: { smoothing: 0.5, highlighter: false },
    })
    expect(el.data.pressure).toBeUndefined()
    // the given points are kept, in order, first at the box's corner
    const pts = el.data.points
    expect(pts[0]).toEqual([0, 0])
    expect(pts.at(-1)).toEqual([100, 0])
    expect(pts).toContainEqual([50, 60])
    // the bounds sent to the chat are the box plus the ink's reach
    expect(out.bounds?.x).toBeLessThanOrEqual(10)
    expect(out.bounds?.y).toBeLessThanOrEqual(20)
    expect((out.bounds?.x ?? 0) + (out.bounds?.w ?? 0)).toBeGreaterThanOrEqual(
      110,
    )
    // the same drawing from a frame far away is the same element
    const far = await run({
      points: underline.map((p) => [
        (p[0] as number) + 5000,
        (p[1] as number) - 3000,
      ]),
      placement: { x: 10, y: 20 },
    })
    expect(freehand(far.c, far.out.ids[0] as string).data.points).toEqual(pts)
  })

  it('fills in between sparse points, so the stroke follows the line the model meant (the pen smooths sparse samples away)', async () => {
    const { out, c } = await run({ points: underline })
    const pts = freehand(c, out.ids[0] as string).data.points
    expect(pts.length).toBeGreaterThan(20) // 3 points became a dense path
    for (let k = 1; k < pts.length; k++) {
      const [a, b] = [pts[k - 1], pts[k]] as [number[], number[]]
      expect(
        Math.hypot(
          (b[0] as number) - (a[0] as number),
          (b[1] as number) - (a[1] as number),
        ),
      ).toBeLessThanOrEqual(6.2)
    }
    // every stored point lies on one of the two segments (50,60 is the corner): |y| = 1.2 x up to 50, then back
    for (const [x, y] of pts as [number, number][])
      expect(
        Math.abs(y - (x <= 50 ? 1.2 * x : 1.2 * (100 - x))),
      ).toBeLessThanOrEqual(0.2)
  })

  it('stays inside the 10,000-point limit however far apart the points are', async () => {
    const { out, c } = await run({
      points: [
        [0, 0],
        [900000, 0],
        [0, 900000],
      ],
    })
    expect(
      freehand(c, out.ids[0] as string).data.points.length,
    ).toBeLessThanOrEqual(10_000)
  })

  it('rounds to the 0.1 grid like the pen does', async () => {
    const { out, c } = await run({
      points: [
        [0.04, 0.06],
        [10.26, 5.55],
      ],
      placement: { x: 0, y: 0 },
    })
    for (const [x, y] of freehand(c, out.ids[0] as string).data.points)
      for (const v of [x, y])
        expect(Math.abs(v * 10 - Math.round(v * 10))).toBeLessThan(1e-9)
  })

  it('draws a pen stroke in the pen style and a highlighter in the highlighter style', async () => {
    const pen = await run({ points: underline })
    expect(freehand(pen.c, pen.out.ids[0] as string).style).toMatchObject({
      stroke: '#1e1e1e',
      strokeWidth: 3,
      opacity: 1,
    })
    const hl = await run({ points: underline, highlighter: true })
    const el = freehand(hl.c, hl.out.ids[0] as string)
    expect(el.data.highlighter).toBe(true)
    expect(el.style).toMatchObject({
      stroke: '#ffd400',
      strokeWidth: 18,
      opacity: 0.45,
    })
  })

  it('takes a colour and a width of its own', async () => {
    const { out, c } = await run({
      points: underline,
      color: '#d55e00',
      width: 6,
    })
    expect(freehand(c, out.ids[0] as string).style).toMatchObject({
      stroke: '#d55e00',
      strokeWidth: 6,
    })
  })

  it('a tap is a dot: two identical points make a zero-size box', async () => {
    const { out, c } = await run({
      points: [
        [5, 5],
        [5, 5],
      ],
      placement: { x: 1, y: 2 },
    })
    expect(freehand(c, out.ids[0] as string)).toMatchObject({ w: 0, h: 0 })
  })

  it('refuses one point, 501 points and a point that is not an x and a y, naming the field', async () => {
    const bad = (points: unknown) =>
      expect(
        Promise.resolve().then(() =>
          drawStroke.execute(drawStroke.input.parse({ points }), ctx()),
        ),
      ).rejects.toMatchObject({
        name: 'ToolError',
        field: 'points',
        message: /points: .*2 to 500/,
      })
    await bad([[1, 2]])
    await bad(Array.from({ length: 501 }, (_, i) => [i, i]))
    await bad([[1, 2], [3]])
    await bad([
      [1, 2],
      [3, 4, 5],
    ])
    // 500 is the limit and is fine
    await run({ points: Array.from({ length: 500 }, (_, i) => [i, i % 9]) })
  })

  it('refuses coordinates so large that distances overflow, instead of dropping a segment (its length would be Infinity)', async () => {
    for (const points of [
      [
        [0, 0],
        [1.7e308, 1.7e308],
      ],
      [
        [-2e9, 0],
        [0, 0],
      ],
    ])
      await expect(
        Promise.resolve().then(() =>
          drawStroke.execute(drawStroke.input.parse({ points }), ctx()),
        ),
      ).rejects.toMatchObject({
        name: 'ToolError',
        field: 'points',
        message: /within 1e9/,
      })
    await run({
      points: [
        [-9e8, 0],
        [9e8, 5],
      ],
    }) // a long stroke inside the limit still works and stays inside the point cap
  })

  it('auto placement keeps clear of what is on the board', async () => {
    const existing = [mk('a', { x: 0, y: 0, w: 900, h: 700 })]
    const { c, out } = await run(
      { points: underline },
      ctx(existing, { viewport: { x: 0, y: 0, w: 1400, h: 900 } }),
    )
    const s = bounds(c.scene.els.get(out.ids[0] as string) as Element)
    const o = bounds(existing[0] as Element)
    expect(
      s.minX < o.maxX && s.maxX > o.minX && s.minY < o.maxY && s.maxY > o.minY,
    ).toBe(false)
  })

  it('counts as one element against the turn budget, reads as a stroke, and is in the registry', async () => {
    const over = await run(
      { points: underline },
      ctx([], { added: ELEMENT_BUDGET }),
    )
    expect(over.out.kind === 'write' && over.out.warnings?.[0]).toMatch(
      /soft limit of 40/,
    )
    expect(
      describeElement(
        over.c.scene.els.get(over.out.ids[0] as string) as Element,
      ).detail,
    ).toMatch(/^stroke, \d+ pts$/)
    expect(coreTools.map((t) => t.name)).toContain('draw_stroke')
  })
})

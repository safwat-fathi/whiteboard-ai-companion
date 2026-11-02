import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { matchesGolden } from '../test/matchesGolden'
import { bounds } from './geometry'
import { SpatialIndex } from './index'
import { nodePlatform } from './node'
import type { Platform } from './platform'
import {
  RenderCache,
  render,
  screenToWorld,
  worldToScreen,
  zoomAt,
  zoomBucket,
} from './render'
import { createScene } from './scene'
import {
  type Camera,
  type Element,
  type ShapeData,
  ZOOM_MAX,
  ZOOM_MIN,
} from './schema'
import { mk } from './test-utils'

const platform = nodePlatform()
const vp = { width: 600, height: 400, dpr: 1 }
const cam: Camera = { x: 0, y: 0, zoom: 1 }
const canvas = (w = vp.width, h = vp.height) => {
  const c = createCanvas(w, h)
  return { c, ctx: c.getContext('2d') as unknown as CanvasRenderingContext2D }
}
type MkOpts = NonNullable<Parameters<typeof mk>[1]>
const shape = (id: string, kind: ShapeData['kind'], p: MkOpts = {}) =>
  mk(id, { w: 80, h: 60, data: { kind }, ...p } as MkOpts)

const TIGHT = { maxMeanDiff: 0.05, maxBigDiffRatio: 0.0005 } // same engine: only noise-level drift allowed

function goldenEls(): Element[] {
  const blue = '#cfe3ff'
  return [
    shape('r', 'rect', { x: 20, y: 20, fill: blue }),
    shape('r2', 'rect', { x: 120, y: 20 }),
    shape('rr', 'rect', {
      x: 220,
      y: 20,
      data: { kind: 'rect', radius: 14 },
      fill: '#ffe3b0',
    }),
    shape('e', 'ellipse', { x: 20, y: 110, fill: '#d4f5d0' }),
    shape('e2', 'ellipse', { x: 120, y: 110, rotation: 0.5 }),
    shape('d', 'diamond', { x: 220, y: 110, fill: '#f6d2e8' }),
    shape('t', 'triangle', { x: 320, y: 110, fill: '#e8d9ff' }),
    shape('rot', 'rect', { x: 420, y: 20, rotation: Math.PI / 6, fill: blue }),
    shape('dash', 'rect', {
      x: 20,
      y: 200,
      style: { ...mk('s').style, dash: 'dashed', stroke: '#c0392b' },
    }),
    shape('dot', 'ellipse', {
      x: 120,
      y: 200,
      style: { ...mk('s').style, dash: 'dotted', strokeWidth: 3 },
    }),
    shape('line', 'line', {
      x: 220,
      y: 200,
      data: {
        kind: 'line',
        points: [
          [0, 60],
          [40, 0],
          [80, 50],
        ],
      },
    }),
    shape('arr', 'arrow', {
      x: 320,
      y: 200,
      data: {
        kind: 'arrow',
        arrowheads: { start: true, end: true },
        points: [
          [0, 30],
          [100, 30],
        ],
      },
    }),
    shape('a', 'rect', { x: 20, y: 300, w: 80, h: 50, fill: blue }),
    shape('b', 'ellipse', { x: 300, y: 300, w: 80, h: 50, fill: '#d4f5d0' }),
    shape('bound', 'arrow', {
      x: 100,
      y: 325,
      data: {
        kind: 'arrow',
        start: { id: 'a', fx: 1, fy: 0.5 },
        end: { id: 'b', fx: 0, fy: 0.5 },
        points: [
          [0, 0],
          [10, 0],
        ],
      },
    }),
  ]
}
const goldenScene = () => createScene(goldenEls())

describe('render', () => {
  it('matches the shapes golden', async () => {
    const { c, ctx } = canvas()
    render(ctx, goldenScene(), cam, vp, platform)
    await matchesGolden(c, 'shapes', TIGHT)
  })

  it('matches the panned and zoomed golden', async () => {
    const { c, ctx } = canvas()
    render(ctx, goldenScene(), { x: 60, y: 90, zoom: 2 }, vp, platform)
    await matchesGolden(c, 'shapes-zoom2', TIGHT)
  })

  it('matches the dpr 2 golden', async () => {
    const v2 = { ...vp, dpr: 2 }
    const { c, ctx } = canvas(1200, 800)
    render(ctx, goldenScene(), cam, v2, platform)
    await matchesGolden(c, 'shapes-dpr2', TIGHT)
  })

  // UPDATE_GOLDEN would make the check overwrite the golden instead of comparing
  it.skipIf(process.env.UPDATE_GOLDEN === '1')(
    'the golden check rejects a missing element and a 5 px shift',
    async () => {
      const els = goldenEls()
      const missing = els.filter((e) => e.id !== 'r')
      const shifted = els.map((e) => (e.id === 'rr' ? { ...e, x: e.x + 5 } : e))
      for (const variant of [missing, shifted]) {
        const { c, ctx } = canvas()
        render(ctx, createScene(variant), cam, vp, platform)
        await expect(matchesGolden(c, 'shapes', TIGHT)).rejects.toThrow(
          /golden shapes/,
        )
      }
    },
  )

  it('renders identical pixels twice', () => {
    const scene = goldenScene()
    const a = canvas()
    const b = canvas()
    render(a.ctx, scene, cam, vp, platform)
    render(b.ctx, scene, cam, vp, platform)
    render(b.ctx, scene, cam, vp, platform)
    expect(a.c.toBuffer('image/png').equals(b.c.toBuffer('image/png'))).toBe(
      true,
    )
  })

  for (const zoom of [0.05, 20]) {
    it(`culls to the brute-force visible count at zoom ${zoom}`, () => {
      let seed = 7
      const rnd = () => {
        seed = (seed * 1664525 + 1013904223) % 2 ** 32
        return seed / 2 ** 32
      }
      const els = Array.from({ length: 5000 }, (_, i) =>
        mk(`e${i}`, {
          x: rnd() * 2000 - 500,
          y: rnd() * 1500 - 500,
          w: 5 + rnd() * 60,
          h: 5 + rnd() * 40,
          rotation: rnd() < 0.25 ? rnd() * 3 : 0,
          data: { kind: i % 2 ? 'ellipse' : 'rect' },
        }),
      )
      const scene = createScene(els)
      const index = new SpatialIndex()
      index.load(els)
      const camera = { x: 400, y: 300, zoom }
      const view = {
        x0: 400,
        y0: 300,
        x1: 400 + 600 / zoom,
        y1: 300 + 400 / zoom,
      }
      const brute = els.filter((e) => {
        const b = bounds(e)
        const p = e.style.strokeWidth / 2 // render pads the cull by half the stroke
        return (
          b.minX - p <= view.x1 &&
          b.maxX + p >= view.x0 &&
          b.minY - p <= view.y1 &&
          b.maxY + p >= view.y0
        )
      }).length
      expect(brute).toBeGreaterThan(0)
      const { ctx } = canvas()
      const s = render(ctx, scene, camera, vp, platform, { index })
      expect(s.drawn).toBe(brute)
      expect(s.culled).toBe(5000 - brute)
      expect(render(ctx, scene, camera, vp, platform).drawn).toBe(brute)
    })
  }
})

describe('culling of strokes and bound arrows', () => {
  const boundArrow = (x: number, y: number) =>
    shape('arrow', 'arrow', {
      x,
      y,
      data: {
        kind: 'arrow',
        start: { id: 'a', fx: 1, fy: 0.5 },
        end: { id: 'b', fx: 0, fy: 0.5 },
        points: [
          [0, 0],
          [10, 0],
        ],
      },
    })
  const targets = (x: number) => [
    shape('a', 'rect', { x, y: 50, w: 40, h: 40 }),
    shape('b', 'rect', { x: x + 200, y: 50, w: 40, h: 40 }),
  ]
  const run = (els: Element[], withIndex: boolean) => {
    const index = new SpatialIndex()
    index.load(els)
    const { ctx } = canvas()
    return render(
      ctx,
      createScene(els),
      cam,
      vp,
      platform,
      withIndex ? { index } : {},
    )
  }

  for (const withIndex of [false, true]) {
    it(`draws a bound arrow whose stored points are off-screen (index ${withIndex})`, () => {
      const els = [...targets(20), boundArrow(5000, 5000)]
      expect(run(els, withIndex).drawn).toBe(3)
    })

    it(`culls a bound arrow whose routed path is off-screen (index ${withIndex})`, () => {
      const els = [...targets(3000), boundArrow(100, 70)]
      expect(run(els, withIndex).drawn).toBe(0)
    })
  }

  it('keeps a shape whose stroke reaches into the view at zoom 20', () => {
    // viewport is 30 world units wide at zoom 20; the stroke (width 10) reaches 5 units left of x
    const near = shape('n', 'rect', {
      x: 33,
      y: 1,
      w: 5,
      h: 5,
      style: { ...mk('s').style, strokeWidth: 10 },
    })
    const far = { ...near, id: 'f', x: 36 }
    const { ctx } = canvas()
    const z = { x: 0, y: 0, zoom: 20 }
    expect(render(ctx, createScene([near]), z, vp, platform).drawn).toBe(1)
    expect(render(ctx, createScene([far]), z, vp, platform).drawn).toBe(0)
  })
})

describe('camera', () => {
  const dvp = { width: 800, height: 600, dpr: 2 }
  it('screenToWorld inverts worldToScreen', () => {
    const c = { x: 123, y: -45, zoom: 2.5 }
    const p = { x: 17.5, y: 99 }
    const q = screenToWorld(worldToScreen(p, c, dvp), c, dvp)
    expect(q.x).toBeCloseTo(p.x, 9)
    expect(q.y).toBeCloseTo(p.y, 9)
  })

  it('zoomAt keeps the world point under the cursor fixed', () => {
    const c = { x: 50, y: 20, zoom: 1 }
    const s = { x: 300, y: 200 }
    const before = screenToWorld(s, c, dvp)
    const z = zoomAt(c, s, 1.7)
    expect(z.zoom).toBeCloseTo(1.7, 9)
    const after = screenToWorld(s, z, dvp)
    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
  })

  it('zoomAt ignores non-finite and non-positive factors', () => {
    const c = { x: 1, y: 2, zoom: 3 }
    for (const f of [Number.NaN, Number.POSITIVE_INFINITY, 0, -2])
      expect(zoomAt(c, { x: 5, y: 5 }, f)).toBe(c)
  })

  it('zoomBucket is 2^ceil(log2 zoom)', () => {
    expect([0.3, 1, 3, 20].map(zoomBucket)).toEqual([0.5, 1, 4, 32])
  })

  it('zoomAt clamps at both limits and stays anchored', () => {
    const s = { x: 120, y: 80 }
    const c = { x: 10, y: 10, zoom: 1 }
    const hi = zoomAt(c, s, 1000)
    const lo = zoomAt(c, s, 0.00001)
    expect(hi.zoom).toBe(ZOOM_MAX)
    expect(lo.zoom).toBe(ZOOM_MIN)
    for (const z of [hi, lo]) {
      const a = screenToWorld(s, c, dvp)
      const b = screenToWorld(s, z, dvp)
      expect(b.x).toBeCloseTo(a.x, 9)
      expect(b.y).toBeCloseTo(a.y, 9)
    }
  })
})

describe('RenderCache', () => {
  it('dispose closes every bitmap', () => {
    const cache = new RenderCache()
    let open = 0
    const bmp = () => {
      open++
      return { close: () => void open-- }
    }
    cache.set(1, 'a', 0, bmp())
    cache.set(1, 'b', 0, bmp())
    cache.set(2, 'a', 0, bmp())
    cache.set(1, 'a', 1, bmp()) // replaces (and closes) the v0 bitmap
    expect(open).toBe(3)
    expect(cache.get(1, 'a', 1)).toBeDefined()
    expect(cache.get(1, 'a', 0)).toBeUndefined()
    cache.dispose()
    expect(open).toBe(0)
    expect(cache.get(1, 'b', 0)).toBeUndefined()
  })

  it('bytes is the sum of the held entries', () => {
    const cache = new RenderCache(250)
    const b = { close() {} }
    cache.set(1, 'a', 0, b, 100)
    cache.set(1, 'b', 0, b, 100)
    expect(cache.bytes).toBe(200)
    cache.set(1, 'a', 1, b, 50) // replaces a
    expect(cache.bytes).toBe(150)
    cache.set(1, 'c', 0, b, 200) // over the cap: the oldest are closed
    expect(cache.bytes).toBeLessThanOrEqual(250)
    cache.dispose()
    expect(cache.bytes).toBe(0)
  })

  it('text is cached as an ImageBitmap when the canvas can freeze one, and closed with the cache', () => {
    const frozen = { closed: 0, close: () => void frozen.closed++ }
    const p: Platform = {
      ...platform,
      createCanvas: (w, h) =>
        Object.assign(createCanvas(w, h), {
          transferToImageBitmap: () => frozen,
        }) as unknown as ReturnType<Platform['createCanvas']>,
    }
    const drawn: unknown[] = []
    const ctx = new Proxy(
      {},
      {
        get: (_, k) =>
          k === 'drawImage' ? (img: unknown) => drawn.push(img) : () => {},
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D
    const el = {
      ...mk('t', { w: 60, h: 20 }),
      type: 'text',
      data: { text: 'hi', size: 16, align: 'left', dir: 'ltr' },
    } as Element
    const cache = new RenderCache()
    for (let i = 0; i < 2; i++)
      render(ctx, createScene([el]), cam, vp, p, { cache })
    expect(drawn).toEqual([frozen, frozen]) // the second frame is a cache hit
    cache.dispose()
    expect(frozen.closed).toBe(1)
  })
})

describe('bound arrowheads', () => {
  it('draw along the routed path even when the stored points are stale', () => {
    const base = nodePlatform()
    const calls: string[] = []
    const rec: typeof platform = {
      ...base,
      createPath2D: () => {
        const p = base.createPath2D()
        for (const m of ['moveTo', 'lineTo'] as const) {
          const orig = p[m].bind(p)
          p[m] = (x: number, y: number) => {
            calls.push(`${m} ${x.toFixed(3)} ${y.toFixed(3)}`)
            orig(x, y)
          }
        }
        return p
      },
    }
    const arrow = mk('ar', {
      x: 100,
      y: 30,
      w: 200,
      h: 0,
      data: {
        kind: 'arrow',
        points: [
          [0, 0],
          [200, 0], // stale: the routed end is (300, 230)
        ],
        start: { id: 'a', fx: 1, fy: 0.5 },
        end: { id: 'b', fx: 0, fy: 0.5 },
      },
    })
    const scene = createScene([
      shape('a', 'rect', { w: 100, h: 60 }),
      shape('b', 'rect', { x: 300, y: 200, w: 100, h: 60 }),
      arrow,
    ])
    render(canvas().ctx, scene, cam, vp, rec)
    const a = Math.atan2(200, 200)
    const wing = (d: number) =>
      `lineTo ${(300 + 12 * Math.cos(a + d)).toFixed(3)} ${(230 + 12 * Math.sin(a + d)).toFixed(3)}`
    expect(calls).toContain('lineTo 300.000 230.000')
    expect(calls).toContain(wing(2.6))
    expect(calls).toContain(wing(-2.6))
  })
})

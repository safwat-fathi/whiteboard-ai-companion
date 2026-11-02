import { createCanvas, loadImage } from '@napi-rs/canvas'
import { describe, expect, it, vi } from 'vitest'
import { fixViewBox, renderMath } from '../../math/src/index'
import { createNodeMathProvider, rasterizeSvgNode } from '../../math/src/node'
import equations from '../../math/test/fixtures/equations.json'
import { matchesGolden } from '../test/matchesGolden'
import { bounds, fitMath } from './geometry'
import { SpatialIndex } from './index'
import { nodePlatform, registerBundledFonts } from './node'
import type {
  ImageProvider,
  MathEntry,
  MathProvider,
  Platform,
} from './platform'
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

describe('draw order', () => {
  // Closed shapes and lines are collected separately; they must still interleave by z, whatever order the Map holds them in.
  it.each([false, true])(
    'follows z, not insertion order, across closed shapes and lines (index %s)',
    (withIndex) => {
      const at = (
        id: string,
        kind: ShapeData['kind'],
        z: string,
        stroke: string,
      ) =>
        shape(id, kind, {
          z,
          x: 20,
          y: 20,
          style: { ...mk('s').style, stroke },
          ...(kind === 'line'
            ? {
                data: {
                  kind,
                  points: [
                    [0, 0],
                    [50, 50],
                  ],
                },
              }
            : {}),
        } as MkOpts)
      const els = [
        at('d', 'line', 'a3', '#000004'),
        at('b', 'line', 'a1', '#000002'),
        at('c', 'rect', 'a2', '#000003'),
        at('a', 'rect', 'a0', '#000001'),
      ] // Map order d, b, c, a
      const index = new SpatialIndex()
      index.load(els)
      const { ctx } = canvas()
      const seen: unknown[] = []
      const stroke = ctx.stroke.bind(ctx) as (...a: unknown[]) => void
      ctx.stroke = ((...a: unknown[]) => {
        seen.push(ctx.strokeStyle)
        stroke(...a)
      }) as typeof ctx.stroke
      render(
        ctx,
        createScene(els),
        cam,
        vp,
        platform,
        withIndex ? { index } : {},
      )
      expect(seen).toEqual(['#000001', '#000002', '#000003', '#000004'])
    },
  )
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

function mathEl(
  id: string,
  over: Partial<Element & { type: 'math' }> = {},
): Element {
  const base = mk(id, { x: 20, y: 20, w: 120, h: 60 })
  return {
    ...base,
    type: 'math',
    ...over,
    data: {
      latex: '\\frac{a}{b}',
      display: true,
      size: 28,
      ...(over.data ?? {}),
    },
  } as Element
}

function nonWhitePixels(c: ReturnType<typeof canvas>['c']): number {
  const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let count = 0
  for (let i = 0; i < data.length; i += 4) {
    if (
      (data[i] ?? 255) < 250 ||
      (data[i + 1] ?? 255) < 250 ||
      (data[i + 2] ?? 255) < 250
    )
      count++
  }
  return count
}

describe('math rendering', () => {
  registerBundledFonts()

  it('draws placeholder on miss and calls request once across 10 frames', () => {
    const request = vi.fn()
    const provider: MathProvider = {
      peek: () => undefined,
      request,
    }
    const p: Platform = { ...platform, math: provider }
    const scene = createScene([mathEl('m1')])
    const { c, ctx } = canvas()
    for (let i = 0; i < 10; i++) {
      render(ctx, scene, cam, vp, p)
    }
    expect(request).toHaveBeenCalledTimes(1)
    expect(nonWhitePixels(c)).toBeGreaterThan(20)
  })

  it('draws ready result and hits RenderCache on second frame without calling bitmapFor again', () => {
    const bmpCanvas = createCanvas(120, 60)
    const bctx = bmpCanvas.getContext('2d')
    bctx.fillStyle = '#1e1e1e'
    bctx.fillRect(10, 10, 100, 40)
    let closed = 0
    const bitmapFor = vi.fn(() =>
      Object.assign(bmpCanvas as unknown as CanvasImageSource, {
        close: () => void closed++,
      }),
    )
    const entry: MathEntry = {
      ok: true,
      width: 4,
      height: 1.5,
      depth: 0.5,
      bitmapFor,
      paths: () => null,
    }
    const provider: MathProvider = {
      peek: () => entry,
      request: vi.fn(),
    }
    const p: Platform = { ...platform, math: provider }
    const cache = new RenderCache()
    const scene = createScene([mathEl('m1')])
    const { c, ctx } = canvas()
    render(ctx, scene, cam, vp, p, { cache })
    render(ctx, scene, cam, vp, p, { cache })
    expect(bitmapFor).toHaveBeenCalledTimes(1)
    expect(nonWhitePixels(c)).toBeGreaterThan(500)
    cache.dispose()
    expect(closed).toBe(1)
  })

  it('does not draw a stale result after element deletion or v change', () => {
    const entries = new Map<string, MathEntry>()
    let triggerReady: (() => void) | undefined
    const oldBmp = vi.fn()
    const newBmp = vi.fn(() => {
      const bc = createCanvas(80, 40)
      bc.getContext('2d').fillRect(0, 0, 80, 40)
      return bc as unknown as CanvasImageSource
    })
    const provider: MathProvider = {
      peek: (latex) => entries.get(latex),
      request: (_latex, _display, _color, onReady) => {
        triggerReady = onReady
      },
    }
    const p: Platform = { ...platform, math: provider }
    const el = mathEl('m1', {
      data: { latex: 'old', display: true, size: 28 },
    })
    const scene = createScene([el])
    const { c, ctx } = canvas()
    render(ctx, scene, cam, vp, p)
    // Delete m1 before old finishes
    scene.els.delete('m1')
    entries.set('old', {
      ok: true,
      width: 2,
      height: 1,
      depth: 0,
      bitmapFor: oldBmp,
      paths: () => null,
    })
    triggerReady?.()
    render(ctx, scene, cam, vp, p)
    expect(oldBmp).not.toHaveBeenCalled()
    expect(nonWhitePixels(c)).toBe(0)

    // Now test v / latex change before old finishes
    const elV2 = mathEl('m2', {
      v: 2,
      data: { latex: 'new', display: true, size: 28 },
    })
    entries.set('new', {
      ok: true,
      width: 2,
      height: 1,
      depth: 0,
      bitmapFor: newBmp,
      paths: () => null,
    })
    scene.els.set('m2', elV2)
    render(ctx, scene, cam, vp, p)
    expect(oldBmp).not.toHaveBeenCalled()
    expect(newBmp).toHaveBeenCalledTimes(1)
  })

  it('draws red monospace source when result is {ok: false}', () => {
    const provider: MathProvider = {
      peek: () => ({ ok: false, error: 'Undefined control sequence \\nope' }),
      request: vi.fn(),
    }
    const p: Platform = { ...platform, math: provider }
    const scene = createScene([
      mathEl('err', {
        w: 180,
        h: 50,
        data: { latex: '\\nope + 1', display: true, size: 28 },
      }),
    ])
    const { c, ctx } = canvas()
    render(ctx, scene, cam, vp, p)
    const data = c.getContext('2d').getImageData(20, 20, 180, 50).data
    let redPixels = 0
    for (let i = 0; i < data.length; i += 4) {
      if (
        (data[i] ?? 0) > 180 &&
        (data[i + 1] ?? 255) < 100 &&
        (data[i + 2] ?? 255) < 100
      )
        redPixels++
    }
    expect(redPixels).toBeGreaterThan(20)
  })

  it('uses paths() when bitmap exceeds 4096 px, and falls back to upscaled capped bitmap when paths() is null', () => {
    const bitmapFor = vi.fn((pxPerEm: number) => {
      const s = Math.max(1, Math.ceil(10 * pxPerEm))
      const bc = createCanvas(s, s)
      const g = bc.getContext('2d')
      g.fillStyle = '#1e1e1e'
      g.fillRect(0, 0, s, s)
      return bc as unknown as CanvasImageSource
    })
    const pathsSpy = vi.fn(() => ({
      viewBox: [0, 0, 1000, 1000] as [number, number, number, number],
      items: [
        {
          d: 'M 10 10 L 990 10 L 990 990 L 10 990 Z',
          m: [1, 0, 0, 1, 0, 0] as [
            number,
            number,
            number,
            number,
            number,
            number,
          ],
          fill: '#1e1e1e',
        },
      ],
    }))
    const entryWithPaths: MathEntry = {
      ok: true,
      width: 10,
      height: 8,
      depth: 2,
      bitmapFor,
      paths: pathsSpy,
    }
    // At zoom 20, w=300 -> 6000 px > 4096
    const bigEl = mathEl('big', {
      x: 0,
      y: 0,
      w: 300,
      h: 300,
      data: { latex: 'X', display: true, size: 30 },
    })
    const highZoom: Camera = { x: 0, y: 0, zoom: 20 }
    const { c: c1, ctx: ctx1 } = canvas()
    render(ctx1, createScene([bigEl]), highZoom, vp, {
      ...platform,
      math: { peek: () => entryWithPaths, request: vi.fn() },
    })
    expect(pathsSpy).toHaveBeenCalled()
    expect(bitmapFor).not.toHaveBeenCalled()
    expect(nonWhitePixels(c1)).toBeGreaterThan(1000)

    // Fallback when paths() returns null
    const entryNoPaths: MathEntry = {
      ...entryWithPaths,
      paths: () => null,
    }
    const { c: c2, ctx: ctx2 } = canvas()
    render(ctx2, createScene([bigEl]), highZoom, vp, {
      ...platform,
      math: { peek: () => entryNoPaths, request: vi.fn() },
    })
    expect(bitmapFor).toHaveBeenCalledTimes(1)
    const calledPxPerEm = bitmapFor.mock.calls[0]?.[0] ?? 0
    expect(calledPxPerEm * 10).toBeLessThanOrEqual(4096)
    expect(nonWhitePixels(c2)).toBeGreaterThan(1000)
  })

  it('applies rotation and opacity to math elements', () => {
    const bmpCanvas = createCanvas(100, 40)
    const g = bmpCanvas.getContext('2d')
    g.fillStyle = '#000000'
    g.fillRect(0, 0, 100, 40)
    const provider: MathProvider = {
      peek: () => ({
        ok: true,
        width: 5,
        height: 1.5,
        depth: 0.5,
        bitmapFor: () => bmpCanvas as unknown as CanvasImageSource,
        paths: () => null,
      }),
      request: vi.fn(),
    }
    const p: Platform = { ...platform, math: provider }
    const el = mathEl('rot', {
      x: 100,
      y: 100,
      w: 100,
      h: 40,
      rotation: Math.PI / 2,
      style: { ...mk('s').style, opacity: 0.5 },
    })
    const { c, ctx } = canvas(300, 300)
    render(ctx, createScene([el]), cam, { width: 300, height: 300, dpr: 1 }, p)
    // Centre is (150, 120); rotated 90 deg, top of rotated box is at (150, 75), which was outside unrotated [100..140] in Y
    const px = c.getContext('2d').getImageData(150, 75, 1, 1).data
    // With 0.5 opacity black on white, channel value is ~127
    expect(px[0]).toBeGreaterThan(90)
    expect(px[0]).toBeLessThan(170)
  })

  it('renders 5 equations across zooms 0.05, 1, 4, 20 matching Node reference within tolerance', async () => {
    const subset = equations.slice(0, 5)
    for (const eq of subset) {
      await renderMath(eq.latex, { display: true, color: '#1e1e1e' })
    }
    const provider = createNodeMathProvider()
    const p: Platform = { ...platform, math: provider }

    for (const eq of subset) {
      const res = await renderMath(eq.latex, {
        display: true,
        color: '#1e1e1e',
      })
      expect(res.ok).toBe(true)
      if (!res.ok) continue

      for (const zoom of [0.05, 1, 4, 20]) {
        const size = 28
        const { w, h } = fitMath(res, size)
        const el = mathEl(String(eq.id), {
          x: 0,
          y: 0,
          w,
          h,
          data: { latex: eq.latex, display: true, size },
        })
        const outW = Math.max(8, Math.ceil(w * zoom))
        const outH = Math.max(8, Math.ceil(h * zoom))
        const { c, ctx } = canvas(outW, outH)
        const cache = new RenderCache()
        render(
          ctx,
          createScene([el]),
          { x: 0, y: 0, zoom },
          { width: outW, height: outH, dpr: 1 },
          p,
          { cache },
        )
        expect(nonWhitePixels(c)).toBeGreaterThan(0)

        // Compare at zoom 1 and 4 against direct SVG rasterisation
        if (zoom === 1 || zoom === 4) {
          const refSvg = await rasterizeSvgNode(
            fixViewBox(res.svg, size * zoom).svg,
            outW,
            outH,
          )
          const refCanvas = createCanvas(outW, outH)
          const rctx = refCanvas.getContext('2d')
          rctx.fillStyle = '#fff'
          rctx.fillRect(0, 0, outW, outH)
          const img = await loadImage(refSvg.toBuffer('image/png'))
          rctx.drawImage(img, 0, 0, w * zoom, h * zoom)

          const a = c.getContext('2d').getImageData(0, 0, outW, outH).data
          const b = rctx.getImageData(0, 0, outW, outH).data
          let diff = 0
          const total = outW * outH
          for (let i = 0; i < a.length; i += 4) {
            if (
              Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 32 ||
              Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) > 32 ||
              Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)) > 32
            ) {
              diff++
            }
          }
          // The render is pixel-exact (crisp). This reference is a resampled
          // raster of a rounded-up bitmap, so it is softer; allow for edge
          // differences. Fidelity against the committed goldens is gated in
          // e2e/math-parity.spec.ts (<= 1.5%).
          expect(diff / total).toBeLessThanOrEqual(0.05)
        }
        cache.dispose()
      }
    }
  })
})

const BLOB_A = 'a'.repeat(64)

function imageEl(
  id: string,
  over: Partial<Element & { type: 'image' }> = {},
): Element {
  const base = mk(id, { x: 0, y: 0, w: 200, h: 200 })
  return {
    ...base,
    type: 'image',
    ...over,
    data: {
      blobId: BLOB_A,
      naturalW: 200,
      naturalH: 200,
      ...(over.data ?? {}),
    },
  } as Element
}

function fourColorImage(w = 200, h = 200) {
  const c = createCanvas(w, h)
  const g = c.getContext('2d')
  const hw = w / 2
  const hh = h / 2
  // Top-left: red, Top-right: green, Bottom-left: blue, Bottom-right: yellow
  g.fillStyle = '#ff0000'
  g.fillRect(0, 0, hw, hh)
  g.fillStyle = '#00ff00'
  g.fillRect(hw, 0, hw, hh)
  g.fillStyle = '#0000ff'
  g.fillRect(0, hh, hw, hh)
  g.fillStyle = '#ffff00'
  g.fillRect(hw, hh, hw, hh)
  return c
}

describe('image rendering and RenderCache tiers', () => {
  it('honours crop rect pixel-exact on a 4-colour test image', () => {
    const src = fourColorImage(200, 200)
    const provider: ImageProvider = {
      peek: () => ({
        bitmap: src as unknown as CanvasImageSource,
        w: 200,
        h: 200,
      }),
      request: vi.fn(),
    }
    const p: Platform = { ...platform, images: provider }
    // Crop to bottom-right quadrant (yellow: #ffff00)
    const el = imageEl('im1', {
      x: 10,
      y: 10,
      w: 100,
      h: 100,
      data: {
        blobId: BLOB_A,
        naturalW: 200,
        naturalH: 200,
        crop: { x: 100, y: 100, w: 100, h: 100 },
      },
    })
    const { c, ctx } = canvas(200, 200)
    render(ctx, createScene([el]), cam, { width: 200, height: 200, dpr: 1 }, p)
    const px = c.getContext('2d').getImageData(50, 50, 1, 1).data
    expect([px[0], px[1], px[2]]).toEqual([255, 255, 0])
  })

  it('zoom 0.05 draws a <= 1/16 bucket copy, zoom 20 draws the original, and duplicates share one cache entry', () => {
    const src = fourColorImage(256, 256)
    const provider: ImageProvider = {
      peek: () => ({
        bitmap: src as unknown as CanvasImageSource,
        w: 256,
        h: 256,
      }),
      request: vi.fn(),
    }
    let createdCanvases = 0
    const p: Platform = {
      ...platform,
      images: provider,
      createCanvas(w, h) {
        createdCanvases++
        return platform.createCanvas(w, h)
      },
    }
    const cache = new RenderCache()
    const el1 = imageEl('i1', {
      x: 0,
      y: 0,
      w: 256,
      h: 256,
      data: { blobId: BLOB_A, naturalW: 256, naturalH: 256 },
    })
    const el2 = imageEl('i2', {
      x: 300,
      y: 0,
      w: 256,
      h: 256,
      z: 'a1',
      data: { blobId: BLOB_A, naturalW: 256, naturalH: 256 },
    })
    const { ctx } = canvas()
    // At zoom 0.05, ratio = 0.05 -> bucket = 1/16 (0.0625) -> 16x16 bucket bitmap = 1024 bytes
    render(ctx, createScene([el1, el2]), { x: 0, y: 0, zoom: 0.05 }, vp, p, {
      cache,
    })
    expect(createdCanvases).toBe(1) // shared between el1 and el2
    expect(cache.bytes).toBe(16 * 16 * 4)

    // At zoom 20, draws original directly without creating a new bucket canvas
    render(ctx, createScene([el1]), { x: 0, y: 0, zoom: 20 }, vp, p, { cache })
    expect(createdCanvases).toBe(1)
    cache.dispose()
  })

  it('evicts original tier before bucket tier, and does not retain or evict when single entry exceeds cap', () => {
    const cache = new RenderCache(300)
    const closed: string[] = []
    const mkBmp = (name: string) => ({
      close: () => void closed.push(name),
    })

    // Add a bucket entry first (older in insertion order) and an original entry second (newer)
    cache.set(0.5, 'bucket-1', 0, mkBmp('bucket-1'), 100, 'bucket')
    cache.set(1, 'orig-1', 0, mkBmp('orig-1'), 150, 'original')
    expect(cache.bytes).toBe(250)

    // Adding bucket-2 (100 bytes) exceeds 300 cap -> must evict orig-1 first even though bucket-1 is older
    cache.set(0.5, 'bucket-2', 0, mkBmp('bucket-2'), 100, 'bucket')
    expect(closed).toEqual(['orig-1'])
    expect(cache.get(0.5, 'bucket-1', 0)).toBeDefined()
    expect(cache.get(0.5, 'bucket-2', 0)).toBeDefined()
    expect(cache.bytes).toBe(200)

    // An entry larger than the cap (500 > 300) is not retained and does not evict bucket-1 or bucket-2
    cache.set(1, 'huge', 0, mkBmp('huge'), 500, 'bucket')
    expect(cache.get(1, 'huge', 0)).toBeUndefined()
    expect(cache.get(0.5, 'bucket-1', 0)).toBeDefined()
    expect(cache.get(0.5, 'bucket-2', 0)).toBeDefined()
    expect(cache.bytes).toBe(200)
    expect(cache.cap).toBe(300)
  })

  it('draws labelled placeholder for missing blob and plain placeholder with single request for undefined', () => {
    const request = vi.fn()
    let state: 'missing' | undefined
    const provider: ImageProvider = {
      peek: () => state,
      request,
    }
    const p: Platform = { ...platform, images: provider }
    const el = imageEl('im', { x: 20, y: 20, w: 160, h: 80 })
    const { c: c1, ctx: ctx1 } = canvas()
    for (let i = 0; i < 5; i++) {
      render(ctx1, createScene([el]), cam, vp, p)
    }
    expect(request).toHaveBeenCalledTimes(1)
    const plainPixels = nonWhitePixels(c1)
    expect(plainPixels).toBeGreaterThan(20)

    state = 'missing'
    const { c: c2, ctx: ctx2 } = canvas()
    expect(() => render(ctx2, createScene([el]), cam, vp, p)).not.toThrow()
    const interiorDark = (cv: ReturnType<typeof canvas>['c']) => {
      const d = cv.getContext('2d').getImageData(30, 30, 140, 60).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) {
        if ((d[i] ?? 255) < 150) n++
      }
      return n
    }
    expect(interiorDark(c1)).toBe(0)
    expect(interiorDark(c2)).toBeGreaterThan(20)
  })
})

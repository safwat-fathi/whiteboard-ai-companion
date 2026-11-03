import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { bounds, hitTest, type Rect } from './geometry'
import {
  inkReach,
  quantiseStroke,
  rdp,
  strokeOutline,
  strokePolygon,
} from './ink'
import { nodePlatform } from './node'
import { DEFAULT_STYLE, type Element, FreehandDataSchema } from './schema'
import { scribble } from './test-utils'

type Pt = [number, number]
const platform = nodePlatform()

// mulberry32: a seeded generator, so the fuzz below is the same on every run
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** The stroke's outline vertices in world space (rotated about the box centre, like render does). */
function inkExtent(el: Element & { type: 'freehand' }): Rect {
  const { x, y, w, h, rotation: a, data, style } = el
  const abs = data.points.map(([px, py]) => [x + px, y + py] as Pt)
  const poly = strokePolygon(abs, data.pressure, {
    size: style.strokeWidth,
    smoothing: data.smoothing,
    highlighter: data.highlighter,
  })
  const cx = x + w / 2
  const cy = y + h / 2
  const r: Rect = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  }
  for (const [px, py] of poly) {
    const dx = px - cx
    const dy = py - cy
    const wx = cx + dx * Math.cos(a) - dy * Math.sin(a)
    const wy = cy + dx * Math.sin(a) + dy * Math.cos(a)
    r.minX = Math.min(r.minX, wx)
    r.minY = Math.min(r.minY, wy)
    r.maxX = Math.max(r.maxX, wx)
    r.maxY = Math.max(r.maxY, wy)
  }
  return r
}

const wave = (n: number, amp: number, step = 4): Pt[] =>
  Array.from({ length: n }, (_, i) => [i * step, amp * Math.sin(i * 0.4)])

const asFreehand = (e: Element) => e as Element & { type: 'freehand' }

describe('inkReach', () => {
  it('is 0.75 of the width for a pen (full pressure) and 0.5 for the highlighter', () => {
    const s = { ...DEFAULT_STYLE, strokeWidth: 20 }
    expect(inkReach({ style: s, data: { highlighter: false } })).toBe(15)
    expect(inkReach({ style: s, data: { highlighter: true } })).toBe(10)
  })
})

describe('the ink stays inside bounds()', () => {
  // The finding: perfect-freehand's radius is size * (0.5 + thinning * (pressure - 0.5)), so a pen at full pressure
  // draws 1.5 x the stored width, past the old `strokeWidth / 2` pad.
  const cases: [string, Element][] = [
    [
      'full-pressure pen',
      scribble('a', wave(40, 30), Array(40).fill(1), {
        style: { ...DEFAULT_STYLE, strokeWidth: 20 },
      }),
    ],
    [
      'simulated-pressure pen, slow (dense points)',
      scribble('b', wave(300, 30, 0.3), undefined, {
        style: { ...DEFAULT_STYLE, strokeWidth: 20 },
      }),
    ],
    [
      'simulated-pressure pen, fast (sparse points)',
      scribble('c', wave(12, 30, 40), undefined, {
        style: { ...DEFAULT_STYLE, strokeWidth: 20 },
      }),
    ],
    [
      'highlighter',
      scribble(
        'd',
        wave(40, 30),
        undefined,
        {
          style: { ...DEFAULT_STYLE, strokeWidth: 18, opacity: 0.45 },
        },
        { highlighter: true },
      ),
    ],
    [
      'a tap at full pressure',
      scribble('e', [[50, 50]], [1], {
        style: { ...DEFAULT_STYLE, strokeWidth: 20 },
      }),
    ],
    [
      'a tap with simulated pressure',
      scribble('f', [[50, 50]], undefined, {
        style: { ...DEFAULT_STYLE, strokeWidth: 20 },
      }),
    ],
    [
      'two points',
      scribble(
        'g',
        [
          [0, 0],
          [30, 5],
        ],
        [1, 1],
        {
          style: { ...DEFAULT_STYLE, strokeWidth: 20 },
        },
      ),
    ],
    [
      'a rotated pen',
      scribble('h', wave(40, 30), Array(40).fill(1), {
        rotation: 0.7,
        style: { ...DEFAULT_STYLE, strokeWidth: 20 },
      }),
    ],
    [
      'a width of 100',
      scribble('i', wave(40, 30), Array(40).fill(1), {
        style: { ...DEFAULT_STYLE, strokeWidth: 100 },
      }),
    ],
  ]
  for (const [name, el] of cases)
    it(`holds for ${name}`, () => {
      const ink = inkExtent(asFreehand(el))
      const b = bounds(el)
      const eps = 1e-6
      expect(ink.minX).toBeGreaterThanOrEqual(b.minX - eps)
      expect(ink.minY).toBeGreaterThanOrEqual(b.minY - eps)
      expect(ink.maxX).toBeLessThanOrEqual(b.maxX + eps)
      expect(ink.maxY).toBeLessThanOrEqual(b.maxY + eps)
    })

  it('a full-pressure pen reaches well past half the stored width (why the pad is 0.75)', () => {
    const el = asFreehand(
      scribble(
        'a',
        [
          [0, 0],
          [100, 0],
        ],
        [1, 1],
        {
          style: { ...DEFAULT_STYLE, strokeWidth: 20 },
        },
      ),
    )
    const ink = inkExtent(el)
    expect(ink.maxY).toBeGreaterThan(12) // 10 would be strokeWidth / 2
    expect(ink.maxY).toBeLessThanOrEqual(15 + 1e-6)
  })

  it('holds for 300 seeded random strokes of any width, pressure, point count and rotation', () => {
    const rand = rng(7)
    for (let n = 0; n < 300; n++) {
      const count = 1 + Math.floor(rand() * 60)
      const abs: Pt[] = Array.from({ length: count }, () => [
        rand() * 400,
        rand() * 300,
      ])
      const mode = rand()
      const pressure =
        mode < 0.3
          ? undefined
          : abs.map(() => (mode < 0.6 ? 1 : Math.round(rand() * 100) / 100))
      const el = scribble(
        `r${n}`,
        abs,
        pressure,
        {
          rotation: rand() < 0.5 ? 0 : rand() * 6,
          style: { ...DEFAULT_STYLE, strokeWidth: 1 + rand() * 99 },
        },
        { highlighter: rand() < 0.2, smoothing: rand() },
      )
      const ink = inkExtent(asFreehand(el))
      const b = bounds(el)
      const eps = 1e-6
      const ok =
        ink.minX >= b.minX - eps &&
        ink.minY >= b.minY - eps &&
        ink.maxX <= b.maxX + eps &&
        ink.maxY <= b.maxY + eps
      if (!ok)
        throw new Error(
          `stroke ${n} overflows its bounds: ${JSON.stringify({ ink, b })}`,
        )
    }
  })

  it('hitTest reaches the fat part of the ink', () => {
    const el = scribble(
      'a',
      [
        [0, 0],
        [100, 0],
      ],
      [1, 1],
      {
        x: 0,
        y: 50,
        style: { ...DEFAULT_STYLE, strokeWidth: 20 },
      },
    )
    // 13 world units below the line: inside the full-pressure ink (radius 15), outside strokeWidth / 2
    expect(hitTest(el, { x: 50, y: 50 + 13 }, 0)).toBe(true)
    expect(hitTest(el, { x: 50, y: 50 + 16 }, 0)).toBe(false)
  })
})

describe('strokeOutline', () => {
  const paint = (path: Path2D) => {
    const c = createCanvas(80, 80)
    const ctx = c.getContext('2d') as unknown as CanvasRenderingContext2D
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, 80, 80)
    ctx.fillStyle = '#000'
    ctx.fill(path)
    const d = ctx.getImageData(0, 0, 80, 80).data
    let n = 0
    let sx = 0
    let sy = 0
    for (let i = 0; i < d.length; i += 4)
      if ((d[i] as number) < 128) {
        n++
        sx += (i / 4) % 80
        sy += Math.floor(i / 4 / 80)
      }
    return {
      n,
      cx: sx / (n || 1) + 0.5,
      cy: sy / (n || 1) + 0.5,
      at: (x: number, y: number) => d[(y * 80 + x) * 4] as number,
    }
  }
  const opts = { size: 10, smoothing: 0.5, highlighter: false }

  it('a one-point tap is a dot centred on the point (not a capsule pushed to point + 1)', () => {
    const { n, cx, cy } = paint(strokeOutline([[40, 40]], [1], opts, platform))
    expect(n).toBeGreaterThan(100) // radius 7.5: about 177 px
    expect(cx).toBeCloseTo(40, 0)
    expect(cy).toBeCloseTo(40, 0)
    const sim = paint(strokeOutline([[40, 40]], undefined, opts, platform))
    expect(sim.n).toBeGreaterThan(20)
    expect(sim.cx).toBeCloseTo(40, 0)
    expect(sim.cy).toBeCloseTo(40, 0)
  })

  it('a stroke fills from end to end, and the stored last point is where the ink ends', () => {
    const { n, at } = paint(
      strokeOutline(
        [
          [10, 40],
          [70, 40],
        ],
        [0.5, 0.5],
        opts,
        platform,
      ),
    )
    // 60 long, 10 wide, plus two round caps: about 60 * 10 + pi * 25
    expect(n).toBeGreaterThan(600)
    expect(n).toBeLessThan(760)
    expect(at(74, 40)).toBeLessThan(128) // the cap reaches 5 past the last point
    expect(at(76, 40)).toBeGreaterThan(128)
  })

  it('a two-point stroke keeps the pressure of both ends (a straight line is two points after RDP)', () => {
    // perfect-freehand interpolates a 2-point input itself and drops the pressure of every point but the first
    const thick = (pressure: number[]) => {
      const c = createCanvas(120, 80)
      const ctx = c.getContext('2d') as unknown as CanvasRenderingContext2D
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, 120, 80)
      ctx.fillStyle = '#000'
      ctx.fill(
        strokeOutline(
          [
            [10, 40],
            [110, 40],
          ],
          pressure,
          { ...opts, size: 20 },
          platform,
        ),
      )
      const col = (x: number) => {
        let n = 0
        for (let y = 0; y < 80; y++)
          if ((ctx.getImageData(x, y, 1, 1).data[0] as number) < 128) n++
        return n
      }
      return { left: col(30), mid: col(60), right: col(90) }
    }
    const full = thick([1, 1])
    expect(full.left).toBeGreaterThanOrEqual(29) // radius 0.75 * 20 = 15
    expect(full.mid).toBeGreaterThanOrEqual(29)
    expect(full.right).toBeGreaterThanOrEqual(29)
    const light = thick([0.1, 0.1])
    expect(light.mid).toBeLessThanOrEqual(12) // radius 0.3 * 20 = 6
    const ramp = thick([0.1, 1])
    expect(ramp.left).toBeLessThan(ramp.mid)
    expect(ramp.mid).toBeLessThan(ramp.right)
  })

  it('a live stroke (last: false) trails the pointer; a stored one (default) does not', () => {
    const pts: Pt[] = [
      [10, 40],
      [40, 40],
      [70, 40],
    ]
    const stored = strokePolygon(pts, undefined, opts)
    const live = strokePolygon(pts, undefined, { ...opts, last: false })
    const maxX = (p: Pt[]) => Math.max(...p.map(([x]) => x))
    expect(maxX(stored)).toBeGreaterThan(maxX(live))
  })

  it('draws nothing for size 0, an empty stroke or non-finite input, and never throws', () => {
    expect(
      paint(strokeOutline([[40, 40]], [1], { ...opts, size: 0 }, platform)).n,
    ).toBe(0)
    expect(paint(strokeOutline([], undefined, opts, platform)).n).toBe(0)
    expect(
      paint(
        strokeOutline(
          [
            [Number.NaN, 4],
            [9, 9],
          ],
          undefined,
          opts,
          platform,
        ),
      ).n,
    ).toBe(0)
  })

  it('tolerates a pressure array of the wrong length', () => {
    const pts: Pt[] = [
      [10, 40],
      [40, 40],
      [70, 40],
    ]
    expect(paint(strokeOutline(pts, [1], opts, platform)).n).toBeGreaterThan(
      100,
    )
    expect(
      paint(strokeOutline(pts, [1, 1, 1, 1, 1], opts, platform)).n,
    ).toBeGreaterThan(100)
  })

  it('the highlighter has a constant width whatever the pressure', () => {
    const pts: Pt[] = [
      [10, 40],
      [40, 40],
      [70, 40],
    ]
    const hl = { ...opts, highlighter: true }
    const a = paint(strokeOutline(pts, [0, 0, 0], hl, platform))
    const b = paint(strokeOutline(pts, [1, 1, 1], hl, platform))
    expect(a.n).toBe(b.n)
  })
})

describe('rdp', () => {
  it('collapses collinear points to the two ends', () => {
    const pts: Pt[] = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      [10, 10],
    ]
    expect(rdp(pts, 0.1)).toEqual([
      [0, 0],
      [10, 10],
    ])
  })

  it('keeps both ends, in order, and returns the same point objects', () => {
    const pts: Pt[] = [
      [0, 0],
      [5, 4],
      [10, 0],
      [15, 4],
      [20, 0],
    ]
    const out = rdp(pts, 1)
    expect(out[0]).toBe(pts[0])
    expect(out[out.length - 1]).toBe(pts[4])
    expect(out).toEqual(pts)
  })

  it('leaves one, two and zero points alone', () => {
    expect(rdp([], 1)).toEqual([])
    expect(rdp([[1, 2]], 1)).toEqual([[1, 2]])
    expect(
      rdp(
        [
          [1, 2],
          [3, 4],
        ],
        1,
      ),
    ).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('a closed loop (first equals last) keeps its far point instead of dividing by zero', () => {
    const loop: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ]
    const out = rdp(loop, 0.5)
    expect(out.length).toBeGreaterThanOrEqual(3)
    expect(out.flat().every(Number.isFinite)).toBe(true)
  })

  it('keeps a point that is exactly eps away out, and one beyond it in', () => {
    expect(
      rdp(
        [
          [0, 0],
          [5, 1],
          [10, 0],
        ],
        1,
      ),
    ).toHaveLength(2)
    expect(
      rdp(
        [
          [0, 0],
          [5, 1.01],
          [10, 0],
        ],
        1,
      ),
    ).toHaveLength(3)
  })

  it('carries extra coordinates (pressure) along with the points it keeps', () => {
    const pts: [number, number, number][] = [
      [0, 0, 0.1],
      [5, 0, 0.2],
      [10, 0, 0.3],
      [10, 8, 0.4],
    ]
    expect(rdp(pts, 0.5)).toEqual([
      [0, 0, 0.1],
      [10, 0, 0.3],
      [10, 8, 0.4],
    ])
  })

  it('every dropped point is within eps of the simplified polyline (seeded fuzz)', () => {
    const rand = rng(11)
    for (let n = 0; n < 50; n++) {
      const pts: Pt[] = Array.from({ length: 200 }, (_, i) => [
        i * 2 + rand() * 3,
        50 * Math.sin(i / 9) + rand() * 4,
      ])
      const eps = 0.5 + rand() * 3
      const out = rdp(pts, eps)
      for (const p of pts) {
        let d = Infinity
        for (let i = 0; i < out.length - 1; i++) {
          const [ax, ay] = out[i] as Pt
          const [bx, by] = out[i + 1] as Pt
          const dx = bx - ax
          const dy = by - ay
          const l2 = dx * dx + dy * dy
          const t = l2
            ? Math.max(
                0,
                Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2),
              )
            : 0
          d = Math.min(d, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy))
        }
        expect(d).toBeLessThanOrEqual(eps + 1e-9)
      }
    }
  })

  it('handles 10,000 zigzag points (the worst case for recursion) quickly', () => {
    const pts: Pt[] = Array.from({ length: 10_000 }, (_, i) => [
      i,
      i % 2 ? 5 : 0,
    ])
    const t = performance.now()
    const out = rdp(pts, 1)
    expect(out).toHaveLength(10_000)
    expect(performance.now() - t).toBeLessThan(1000)
  })
})

describe('quantiseStroke', () => {
  it('rounds points to 0.1 and pressure to 0.01, with no float noise or -0', () => {
    const q = quantiseStroke(
      [
        [10.04, 20.06],
        [10.34, 20.06],
        [9.96, 19.99],
      ],
      [0.123456, 1, 0.005],
    )
    expect(q.points.flat()).toSatisfy((v: number[]) =>
      v.every(
        (n) => Object.is(n, Math.round(n * 10) / 10) && !Object.is(n, -0),
      ),
    )
    expect(q.pressure).toEqual([0.12, 1, 0.01])
    expect(q.x).toBe(10)
    expect(q.y).toBe(20)
  })

  it('returns the tight box and points relative to it', () => {
    const q = quantiseStroke(
      [
        [100.3, 50],
        [140.7, 90.2],
        [120, 70],
      ],
      undefined,
    )
    expect(q).toEqual({
      x: 100.3,
      y: 50,
      w: 40.4,
      h: 40.2,
      points: [
        [0, 0],
        [40.4, 40.2],
        [19.7, 20],
      ],
      pressure: undefined,
    })
  })

  it('a tap is a zero-size box with one point at the origin', () => {
    expect(quantiseStroke([[3.14, 2.72]], [0.5])).toEqual({
      x: 3.1,
      y: 2.7,
      w: 0,
      h: 0,
      points: [[0, 0]],
      pressure: [0.5],
    })
  })

  it('clamps pressure to 0..1 and builds data that FreehandDataSchema accepts', () => {
    const q = quantiseStroke(
      [
        [0, 0],
        [10, 10],
      ],
      [-0.2, 1.4],
    )
    expect(q.pressure).toEqual([0, 1])
    expect(
      FreehandDataSchema.safeParse({
        points: q.points,
        pressure: q.pressure,
        smoothing: 0.5,
        highlighter: false,
      }).success,
    ).toBe(true)
  })

  it('the box is tight after rounding: x + w is the largest absolute point', () => {
    const rand = rng(3)
    for (let n = 0; n < 100; n++) {
      const abs: Pt[] = Array.from(
        { length: 1 + Math.floor(rand() * 30) },
        () => [rand() * 1000 - 500, rand() * 1000 - 500],
      )
      const q = quantiseStroke(abs, undefined)
      expect(Math.min(...q.points.map(([px]) => px))).toBe(0)
      expect(Math.min(...q.points.map(([, py]) => py))).toBe(0)
      expect(Math.max(...q.points.map(([px]) => px))).toBe(q.w)
      expect(Math.max(...q.points.map(([, py]) => py))).toBe(q.h)
    }
  })

  it('passes NaN through so the schema can reject it by name', () => {
    const q = quantiseStroke([[Number.NaN, 0]], [Number.NaN])
    expect(
      FreehandDataSchema.safeParse({
        points: q.points,
        pressure: q.pressure,
        smoothing: 0.5,
        highlighter: false,
      }).success,
    ).toBe(false)
  })
})

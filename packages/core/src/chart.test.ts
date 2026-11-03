import { describe, expect, it } from 'vitest'
import {
  CHART_PALETTE,
  type ChartLayout,
  type ChartPrim,
  formatTick,
  layoutChart,
  niceTicks,
} from './chart'
import type { ChartData } from './schema'

// 5 px per character at size 10: deterministic, so a test can compute where a label ends.
const measure = (text: string, size: number) => text.length * size * 0.5

const data = (d: Partial<ChartData> = {}): ChartData => ({
  kind: 'bar',
  categories: ['A', 'B', 'C'],
  series: [{ name: 'Sales', values: [3, 5, 2] }],
  ...d,
})
const lay = (d: Partial<ChartData> = {}, w = 480, h = 320) =>
  layoutChart(data(d), w, h, { measure })
const of = <R extends string>(l: ChartLayout, role: R) =>
  l.prims.filter((p) => p.role === role)
const rects = (l: ChartLayout, role: string) =>
  of(l, role) as Extract<ChartPrim, { k: 'rect' }>[]
const texts = (l: ChartLayout, role: string) =>
  of(l, role) as Extract<ChartPrim, { k: 'text' }>[]

/** Every number in a layout is finite: NaN and Infinity never reach a canvas. */
function allFinite(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every(allFinite)
  if (v && typeof v === 'object') return Object.values(v).every(allFinite)
  return true
}

describe('niceTicks', () => {
  it('rounds a range to steps of 1, 2 or 5 times a power of ten', () => {
    expect(niceTicks(0, 97)).toEqual([0, 20, 40, 60, 80, 100])
    expect(niceTicks(-3, 7)).toEqual([-4, -2, 0, 2, 4, 6, 8])
    expect(niceTicks(0, 1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1])
  })
  it('gives a range to a single value, and to nothing', () => {
    expect(niceTicks(0, 0)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1])
    expect(niceTicks(5, 5)).toEqual([0, 1, 2, 3, 4, 5])
    expect(niceTicks(-5, -5)).toEqual([-5, -4, -3, -2, -1, 0])
    expect(niceTicks(Number.NaN, 3)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1])
  })
  it('keeps float noise out of the ticks', () => {
    for (const t of niceTicks(0, 0.3)) expect(String(t).length).toBeLessThan(6)
  })
})

describe('formatTick', () => {
  it('writes big numbers compactly and small steps with their decimals', () => {
    expect(formatTick(1e12, 2e11)).toBe('1T')
    expect(formatTick(2e11, 2e11)).toBe('200B')
    expect(formatTick(1_500_000, 5e5)).toBe('1.5M')
    expect(formatTick(20, 20)).toBe('20')
    expect(formatTick(0.25, 0.05)).toBe('0.25')
    expect(formatTick(-4, 2)).toBe('-4')
    expect(formatTick(0, 2)).toBe('0')
  })
})

describe('bar chart', () => {
  it('draws one bar per value with heights in proportion', () => {
    const l = lay()
    const bars = rects(l, 'bar')
    expect(bars).toHaveLength(3)
    const [a, b, c] = bars as [
      (typeof bars)[0],
      (typeof bars)[0],
      (typeof bars)[0],
    ]
    expect(b.h / a.h).toBeCloseTo(5 / 3, 6)
    expect(c.h / a.h).toBeCloseTo(2 / 3, 6)
    // all stand on the baseline, in the series colour
    for (const r of bars) {
      expect(r.y + r.h).toBeCloseTo(l.zeroY as number, 6)
      expect(r.fill).toBe(CHART_PALETTE[0])
    }
  })
  it('puts bars of several series side by side and gives each a legend entry', () => {
    const l = lay({
      series: [
        { name: 'North', values: [1, 2, 3] },
        { name: 'South', values: [3, 2, 1] },
      ],
    })
    const bars = rects(l, 'bar')
    expect(bars).toHaveLength(6)
    // bars come series by series: [3] is the second series in the first category, right beside [0]
    expect(bars[3]?.x).toBeCloseTo(
      (bars[0]?.x as number) + (bars[0]?.w as number),
      6,
    )
    expect(bars[0]?.fill).toBe(CHART_PALETTE[0])
    expect(bars[3]?.fill).toBe(CHART_PALETTE[1])
    expect(texts(l, 'legend').map((t) => t.text)).toEqual(['North', 'South'])
  })
  it('has no legend for a single series', () => {
    expect(texts(lay(), 'legend')).toEqual([])
  })
  it('stacks series so each bar starts where the one below ends and the total is the sum', () => {
    const l = lay({
      stacked: true,
      series: [
        { name: 'a', values: [1, 2, 3] },
        { name: 'b', values: [4, 5, 6] },
      ],
    })
    const bars = rects(l, 'bar')
    expect(bars).toHaveLength(6)
    const [a0, a1, , b0, b1] = [
      bars[0],
      bars[1],
      bars[2],
      bars[3],
      bars[4],
    ] as (typeof bars)[0][]
    expect((b0?.y as number) + (b0?.h as number)).toBeCloseTo(
      a0?.y as number,
      6,
    ) // b sits on a
    expect((b0?.h as number) / (a0?.h as number)).toBeCloseTo(4, 6)
    expect(
      ((a1?.h as number) + (b1?.h as number)) / (a0?.h as number),
    ).toBeCloseTo(7, 6) // 2 + 5 against 1
    expect(a0?.x).toBe(b0?.x) // one column
  })
  it('hangs a negative bar below the baseline, in proportion', () => {
    const l = lay({
      categories: ['A', 'B'],
      series: [{ name: 's', values: [-4, 2] }],
    })
    const [neg, pos] = rects(l, 'bar') as [
      ChartPrim & { k: 'rect' },
      ChartPrim & { k: 'rect' },
    ]
    expect(neg.y).toBeCloseTo(l.zeroY as number, 6)
    expect(pos.y + pos.h).toBeCloseTo(l.zeroY as number, 6)
    expect(neg.h / pos.h).toBeCloseTo(2, 6)
  })
  it('draws axes and a unit scale for all-zero data, with nothing non-finite', () => {
    const l = lay({ series: [{ name: 's', values: [0, 0, 0] }] })
    expect(rects(l, 'bar')).toEqual([])
    expect(of(l, 'axis').length).toBeGreaterThan(0)
    expect(texts(l, 'tick').map((t) => t.text)).toContain('1')
    expect(allFinite(l)).toBe(true)
  })
  it('writes huge values compactly on the axis', () => {
    const l = lay({
      categories: ['A'],
      series: [{ name: 's', values: [1e12] }],
    })
    expect(texts(l, 'tick').map((t) => t.text)).toContain('1T')
    expect(allFinite(l)).toBe(true)
  })
  it('truncates a category label that does not fit its slot, with an ellipsis', () => {
    const l = lay({
      categories: [
        'A very long category name that cannot fit its slot',
        'B',
        'C',
      ],
    })
    const [first] = texts(l, 'category')
    expect(first?.text.endsWith('…')).toBe(true)
    expect(first?.text.length).toBeLessThan(51)
    const slot = (l.plot.w as number) / 3
    expect(measure(first?.text ?? '', first?.size ?? 0)).toBeLessThanOrEqual(
      slot,
    )
  })
  it('puts the title on top and the axis titles beside the axes', () => {
    const l = lay({ title: 'Sales', xLabel: 'Quarter', yLabel: 'Units' })
    expect(texts(l, 'title').map((t) => t.text)).toEqual(['Sales'])
    expect(texts(l, 'xLabel').map((t) => t.text)).toEqual(['Quarter'])
    const y = texts(l, 'yLabel')[0]
    expect(y?.text).toBe('Units')
    expect(y?.rotate).toBeCloseTo(-Math.PI / 2, 6)
  })
  it('uses the custom palette when one is given', () => {
    const l = lay({ palette: ['#112233'] })
    expect(rects(l, 'bar')[0]?.fill).toBe('#112233')
  })
})

describe('line and area charts', () => {
  const two = [
    { name: 'a', values: [1, 4, 2] },
    { name: 'b', values: [2, 3, 5] },
  ]
  it('joins the points of a series, in category order, with a dot on each', () => {
    const l = lay({ kind: 'line', series: two })
    const lines = of(l, 'line') as Extract<ChartPrim, { k: 'poly' }>[]
    expect(lines).toHaveLength(2)
    expect(lines[0]?.pts).toHaveLength(3)
    const xs = lines[0]?.pts.map((p) => p[0]) as number[]
    expect(xs[0]).toBeLessThan(xs[1] as number)
    expect(xs[1]).toBeLessThan(xs[2] as number)
    expect(of(l, 'point')).toHaveLength(6)
  })
  it('a single category draws its dot and no line', () => {
    const l = lay({
      kind: 'line',
      categories: ['A'],
      series: [{ name: 's', values: [3] }],
    })
    expect(of(l, 'line')).toEqual([])
    expect(of(l, 'point')).toHaveLength(1)
    expect(allFinite(l)).toBe(true)
  })
  it('an area closes down to the baseline', () => {
    const l = lay({ kind: 'area', series: [two[0] as (typeof two)[0]] })
    const [fill] = of(l, 'area') as Extract<ChartPrim, { k: 'poly' }>[]
    expect(fill?.closed).toBe(true)
    const ys = fill?.pts.map((p) => p[1]) as number[]
    expect(
      ys.filter((y) => Math.abs(y - (l.zeroY as number)) < 1e-6),
    ).toHaveLength(2)
  })
  it('stacked areas sit on each other', () => {
    const l = lay({ kind: 'area', stacked: true, series: two })
    const [a, b] = of(l, 'area') as Extract<ChartPrim, { k: 'poly' }>[]
    // the top edge of a is the bottom edge of b: b's polygon contains a's top points
    for (const p of a?.pts.slice(0, 3) ?? [])
      expect(b?.pts.some((q) => Math.abs(q[1] - p[1]) < 1e-6)).toBe(true)
  })
})

describe('pie and donut', () => {
  const pie = (d: Partial<ChartData> = {}) =>
    lay({
      kind: 'pie',
      categories: ['A', 'B', 'C'],
      series: [{ name: 's', values: [1, 2, 1] }],
      ...d,
    })
  const arcs = (l: ChartLayout) =>
    of(l, 'slice') as Extract<ChartPrim, { k: 'arc' }>[]
  it('slice angles add up to a full turn, start at the top and follow the values', () => {
    const s = arcs(pie())
    expect(s).toHaveLength(3)
    expect(s[0]?.a0).toBeCloseTo(-Math.PI / 2, 9)
    const sweep = s.map((a) => a.a1 - a.a0)
    expect(sweep.reduce((x, y) => x + y, 0)).toBeCloseTo(2 * Math.PI, 9)
    expect(sweep[1]).toBeCloseTo(2 * (sweep[0] as number), 9)
    expect(s[1]?.a0).toBeCloseTo(s[0]?.a1 as number, 9)
  })
  it('a pie is solid and a donut has a hole', () => {
    for (const a of arcs(pie())) expect(a.r0).toBe(0)
    for (const a of arcs(pie({ kind: 'donut' }))) {
      expect(a.r0).toBeGreaterThan(0)
      expect(a.r0).toBeLessThan(a.r1)
    }
  })
  it('lists each slice in the legend with its share', () => {
    expect(texts(pie(), 'legend').map((t) => t.text)).toEqual([
      'A 25%',
      'B 50%',
      'C 25%',
    ])
  })
  it('negative values count as nothing; an empty or all-zero pie is one grey ring, not NaN', () => {
    const neg = arcs(pie({ series: [{ name: 's', values: [3, -1, 1] }] }))
    expect(neg[1]?.a1).toBeCloseTo(neg[1]?.a0 as number, 9)
    const zero = pie({ series: [{ name: 's', values: [0, 0, 0] }] })
    expect(arcs(zero)).toHaveLength(1)
    expect(allFinite(zero)).toBe(true)
    expect(texts(zero, 'empty').map((t) => t.text)).toEqual(['No data'])
  })
})

describe('scatter', () => {
  it('places each point by its own x, linearly, and its y by value', () => {
    const l = lay({
      kind: 'scatter',
      categories: [],
      series: [{ name: 's', values: [1, 2, 4], xs: [10, 20, 30] }],
    })
    const pts = of(l, 'point') as Extract<ChartPrim, { k: 'dot' }>[]
    expect(pts).toHaveLength(3)
    const [p0, p1, p2] = pts as [
      (typeof pts)[0],
      (typeof pts)[0],
      (typeof pts)[0],
    ]
    expect(p1.x - p0.x).toBeCloseTo(p2.x - p1.x, 6)
    expect(p2.y).toBeLessThan(p0.y) // larger value, higher on the page
    expect(texts(l, 'tick').length).toBeGreaterThan(4) // both axes are numbered
  })
})

describe('no data and tiny boxes', () => {
  it('draws the frame and says so when there is nothing to draw', () => {
    for (const kind of [
      'bar',
      'line',
      'area',
      'pie',
      'donut',
      'scatter',
    ] as const) {
      const l = lay({
        kind,
        categories: [],
        series:
          kind === 'pie' || kind === 'donut' ? [{ name: 's', values: [] }] : [],
      })
      expect(texts(l, 'empty').map((t) => t.text)).toEqual(['No data'])
      expect(allFinite(l)).toBe(true)
    }
  })
  it('stays finite in a box too small for its labels', () => {
    for (const [w, h] of [
      [10, 10],
      [60, 40],
      [480, 20],
    ] as const) {
      const l = lay(
        { title: 'Sales by quarter', xLabel: 'Quarter', yLabel: 'Units' },
        w,
        h,
      )
      expect(allFinite(l)).toBe(true)
      expect(l.plot.w).toBeGreaterThanOrEqual(1)
      expect(l.plot.h).toBeGreaterThanOrEqual(1)
    }
  })
  it('keeps every text inside the box', () => {
    const l = lay({
      title: 'Sales by quarter',
      xLabel: 'Quarter',
      yLabel: 'Units',
    })
    for (const t of of(l, 'title').concat(of(l, 'xLabel')) as Extract<
      ChartPrim,
      { k: 'text' }
    >[]) {
      const half = measure(t.text, t.size) / 2
      expect(t.x - half).toBeGreaterThanOrEqual(0)
      expect(t.x + half).toBeLessThanOrEqual(480)
    }
  })
})

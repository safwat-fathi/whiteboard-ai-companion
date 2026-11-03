import type { ChartData } from './schema'

// In-house chart layout (R8): a pure function from data and a box to drawing primitives. render.ts paints the primitives
// into a cached bitmap, the same code in the browser and on the server. No chart library, by design.

/** Okabe-Ito: eight colours that stay apart for most kinds of colour blindness. */
export const CHART_PALETTE = [
  '#0072b2',
  '#e69f00',
  '#009e73',
  '#d55e00',
  '#56b4e9',
  '#cc79a7',
  '#f0e442',
  '#000000',
]

export type ChartPrim =
  | {
      k: 'rect'
      role: string
      x: number
      y: number
      w: number
      h: number
      fill: string
    }
  | {
      k: 'line'
      role: string
      x1: number
      y1: number
      x2: number
      y2: number
      stroke: string
      width: number
    }
  | {
      k: 'poly'
      role: string
      pts: [number, number][]
      closed: boolean
      fill?: string
      stroke?: string
      width?: number
    }
  | {
      k: 'arc'
      role: string
      cx: number
      cy: number
      r0: number
      r1: number
      a0: number
      a1: number
      fill: string
    }
  | {
      k: 'dot'
      role: string
      x: number
      y: number
      r: number
      fill: string
    }
  | {
      k: 'text'
      role: string
      /** The text's horizontal anchor and its vertical centre. */
      x: number
      y: number
      text: string
      size: number
      align: 'left' | 'center' | 'right'
      fill: string
      /** Radians about (x, y). */
      rotate?: number
    }

export type ChartLayout = {
  prims: ChartPrim[]
  /** The plotting area (the circle's bounding square for a pie). */
  plot: { x: number; y: number; w: number; h: number }
  /** Where the value 0 sits, for charts with a value axis. */
  zeroY?: number
}

export type Measure = (text: string, size: number) => number
const estimate: Measure = (text, size) => text.length * size * 0.55

const GRID = '#d9dde3'
const MUTED = '#5b6470'
const PAD = 8
const TICK = 11
const LEGEND = 11
const TITLE = 16
const ROW = 16
const MAX_LEGEND_ROWS = 3
const fin = (n: number, d = 0) => (Number.isFinite(n) ? n : d)

/** About `count` round tick values covering [min, max]: steps of 1, 2 or 5 times a power of ten. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  let lo = Math.min(min, max)
  let hi = Math.max(min, max)
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0
    hi = 1
  } else if (lo === hi) {
    if (lo === 0) hi = 1
    else if (lo > 0) lo = 0
    else hi = 0
  }
  const raw = (hi - lo) / Math.max(count - 1, 1)
  const exp = Math.floor(Math.log10(raw))
  const f = raw / 10 ** exp
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * 10 ** exp
  const first = Math.floor(lo / step + 1e-9)
  const last = Math.ceil(hi / step - 1e-9)
  const out: number[] = []
  for (let i = first; i <= last; i++)
    out.push(Number((i * step).toPrecision(12)) + 0)
  return out.length >= 2 ? out : [out[0] ?? 0, (out[0] ?? 0) + step]
}

const trim = (n: number, digits: number) => String(Number(n.toFixed(digits)))

/** A tick value as short text: 1.5M, 200B, 0.25. `step` is the gap between ticks, which sets the decimals. */
export function formatTick(v: number, step: number): string {
  const a = Math.abs(v)
  if (a >= 1e12) return `${trim(v / 1e12, 2)}T`
  if (a >= 1e9) return `${trim(v / 1e9, 2)}B`
  if (a >= 1e6) return `${trim(v / 1e6, 2)}M`
  const decimals =
    step > 0 && step < 1 ? Math.min(6, Math.ceil(-Math.log10(step))) : 0
  return trim(v, decimals)
}

/** `text` cut to fit `maxW` with an ellipsis; empty when even the ellipsis does not fit. */
function fit(text: string, size: number, maxW: number, measure: Measure) {
  if (maxW <= 0) return ''
  if (measure(text, size) <= maxW) return text
  let s = text
  while (s.length > 0 && measure(`${s}…`, size) > maxW) s = s.slice(0, -1)
  return s.length > 0 ? `${s}…` : ''
}

export function layoutChart(
  d: ChartData,
  w: number,
  h: number,
  o: { measure?: Measure; ink?: string } = {},
): ChartLayout {
  const measure = o.measure ?? estimate
  const ink = o.ink ?? '#1e1e1e'
  const palette = d.palette?.length ? d.palette : CHART_PALETTE
  const color = (i: number) => palette[i % palette.length] as string
  const prims: ChartPrim[] = []
  const text = (
    role: string,
    x: number,
    y: number,
    s: string,
    size: number,
    align: 'left' | 'center' | 'right' = 'center',
    fill = ink,
    rotate?: number,
  ) => {
    if (s)
      prims.push({
        k: 'text',
        role,
        x,
        y,
        text: s,
        size,
        align,
        fill,
        ...(rotate !== undefined && { rotate }),
      })
  }
  const pie = d.kind === 'pie' || d.kind === 'donut'

  // Pie shares, and the legend: one entry per series, or per slice for a pie.
  const slices = pie
    ? (d.series[0]?.values ?? []).map((v) => Math.max(fin(v), 0))
    : []
  const total = slices.reduce((a, b) => a + b, 0)
  const legendItems = pie
    ? d.categories.map((c, i) =>
        total > 0 ? `${c} ${Math.round(((slices[i] ?? 0) / total) * 100)}%` : c,
      )
    : d.series.length > 1
      ? d.series.map((s) => s.name)
      : []
  const rows: { x: number; i: number; label: string }[][] = []
  {
    let row: { x: number; i: number; label: string }[] = []
    let x = 0
    legendItems.forEach((label, i) => {
      const lw = 14 + measure(label, LEGEND) + 14
      if (row.length && x + lw > w - 2 * PAD) {
        rows.push(row)
        row = []
        x = 0
      }
      row.push({ x, i, label })
      x += lw
    })
    if (row.length) rows.push(row)
    rows.length = Math.min(rows.length, MAX_LEGEND_ROWS) // ponytail: entries past three rows are not drawn
  }
  const legendH = rows.length * ROW

  const top = (d.title ? 30 : PAD) + 4
  const bottomReserve = PAD + legendH + (d.xLabel ? 16 : 0) + (pie ? 0 : 18)
  const bottom = Math.max(h - bottomReserve, top + 1)

  // Axis and value scale (not for a pie).
  const n = d.categories.length
  let ticks: number[] = []
  let xTicks: number[] = []
  let left = PAD + (d.yLabel ? 16 : 0)
  let right = w - 12
  const vals = d.series.flatMap((s) => s.values.filter(Number.isFinite))
  const hasData = pie ? total > 0 : vals.length > 0
  const cum: number[][] = []
  let lo = 0
  let hi = 0
  if (!pie) {
    if (d.stacked && d.kind === 'bar') {
      for (let i = 0; i < n; i++) {
        let p = 0
        let q = 0
        for (const s of d.series) {
          const v = fin(s.values[i] ?? 0)
          if (v >= 0) p += v
          else q += v
        }
        hi = Math.max(hi, p)
        lo = Math.min(lo, q)
      }
    } else if (d.stacked && d.kind === 'area') {
      const run = new Array<number>(n).fill(0)
      for (const s of d.series) {
        for (let i = 0; i < n; i++)
          run[i] = (run[i] as number) + fin(s.values[i] ?? 0)
        cum.push([...run])
      }
      for (const c of cum)
        for (const v of c) {
          hi = Math.max(hi, v)
          lo = Math.min(lo, v)
        }
    } else if (d.kind === 'line' || d.kind === 'scatter') {
      lo = vals.length ? Math.min(...vals) : 0
      hi = vals.length ? Math.max(...vals) : 0
    } else {
      lo = Math.min(0, ...vals)
      hi = Math.max(0, ...vals)
    }
    ticks = niceTicks(lo, hi)
    const step = (ticks[1] as number) - (ticks[0] as number)
    left +=
      Math.max(...ticks.map((t) => measure(formatTick(t, step), TICK))) + 6
    if (d.kind === 'scatter') {
      const xs = d.series.flatMap((s) => (s.xs ?? []).filter(Number.isFinite))
      xTicks = niceTicks(
        xs.length ? Math.min(...xs) : 0,
        xs.length ? Math.max(...xs) : 0,
      )
    }
  }
  right = Math.max(right, left + 1)
  const plot = { x: left, y: top, w: right - left, h: bottom - top }

  let zeroY: number | undefined
  if (!pie) {
    const t0 = ticks[0] as number
    const t1 = ticks[ticks.length - 1] as number
    const yOf = (v: number) => plot.y + plot.h - ((v - t0) / (t1 - t0)) * plot.h
    zeroY = yOf(Math.min(Math.max(0, t0), t1))
    const step = (ticks[1] as number) - t0
    const slot = plot.w / Math.max(n, 1)
    const xAt = (i: number) => plot.x + slot * (i + 0.5)
    const sx = (v: number) => {
      const a = xTicks[0] as number
      const b = xTicks[xTicks.length - 1] as number
      return plot.x + ((v - a) / (b - a)) * plot.w
    }

    for (const t of ticks) {
      const y = yOf(t)
      prims.push({
        k: 'line',
        role: 'grid',
        x1: plot.x,
        y1: y,
        x2: plot.x + plot.w,
        y2: y,
        stroke: GRID,
        width: 1,
      })
      text('tick', plot.x - 6, y, formatTick(t, step), TICK, 'right', MUTED)
    }
    if (d.kind === 'scatter') {
      const xs = (xTicks[1] as number) - (xTicks[0] as number)
      for (const t of xTicks) {
        const x = sx(t)
        prims.push({
          k: 'line',
          role: 'grid',
          x1: x,
          y1: plot.y,
          x2: x,
          y2: plot.y + plot.h,
          stroke: GRID,
          width: 1,
        })
        text(
          'tick',
          x,
          plot.y + plot.h + 11,
          formatTick(t, xs),
          TICK,
          'center',
          MUTED,
        )
      }
    }

    if (d.kind === 'bar') {
      const gw = slot * 0.72
      const bw = d.stacked ? gw : gw / Math.max(d.series.length, 1)
      const pos = new Array<number>(n).fill(0)
      const neg = new Array<number>(n).fill(0)
      d.series.forEach((s, si) => {
        for (let i = 0; i < n; i++) {
          const v = fin(s.values[i] ?? 0)
          let from = 0
          if (d.stacked) from = v >= 0 ? (pos[i] as number) : (neg[i] as number)
          const to = from + v
          if (d.stacked) {
            if (v >= 0) pos[i] = to
            else neg[i] = to
          }
          const y1 = yOf(Math.max(from, to))
          const hh = yOf(Math.min(from, to)) - y1
          if (hh > 0.01)
            prims.push({
              k: 'rect',
              role: 'bar',
              x:
                plot.x + slot * i + (slot - gw) / 2 + (d.stacked ? 0 : si * bw),
              y: y1,
              w: bw,
              h: hh,
              fill: color(si),
            })
        }
      })
    } else if (d.kind === 'line' || d.kind === 'area') {
      d.series.forEach((s, si) => {
        const tops = s.values
          .slice(0, n)
          .map((v, i): [number, number] => [
            xAt(i),
            yOf(d.stacked && d.kind === 'area' ? (cum[si]?.[i] ?? 0) : fin(v)),
          ])
        if (d.kind === 'area' && tops.length > 1) {
          const bases: [number, number][] =
            d.stacked && si > 0
              ? tops
                  .map(
                    (_, i) =>
                      [xAt(i), yOf(cum[si - 1]?.[i] ?? 0)] as [number, number],
                  )
                  .reverse()
              : [
                  [xAt(tops.length - 1), zeroY as number],
                  [xAt(0), zeroY as number],
                ]
          prims.push({
            k: 'poly',
            role: 'area',
            pts: [...tops, ...bases],
            closed: true,
            fill: `${color(si)}59`,
          })
        }
        if (tops.length > 1)
          prims.push({
            k: 'poly',
            role: 'line',
            pts: tops,
            closed: false,
            stroke: color(si),
            width: 2.5,
          })
        if (d.kind === 'line')
          for (const [x, y] of tops)
            prims.push({
              k: 'dot',
              role: 'point',
              x,
              y,
              r: 3.5,
              fill: color(si),
            })
      })
    } else if (d.kind === 'scatter') {
      d.series.forEach((s, si) => {
        s.values.forEach((v, i) => {
          prims.push({
            k: 'dot',
            role: 'point',
            x: sx(fin(s.xs?.[i] ?? 0)),
            y: yOf(fin(v)),
            r: 4,
            fill: color(si),
          })
        })
      })
    }

    // axes over the data, then the category names
    prims.push({
      k: 'line',
      role: 'axis',
      x1: plot.x,
      y1: plot.y,
      x2: plot.x,
      y2: plot.y + plot.h,
      stroke: ink,
      width: 1.25,
    })
    prims.push({
      k: 'line',
      role: 'axis',
      x1: plot.x,
      y1: zeroY,
      x2: plot.x + plot.w,
      y2: zeroY,
      stroke: ink,
      width: 1.25,
    })
    if (d.kind !== 'scatter' && n > 0) {
      const longest = Math.max(...d.categories.map((c) => measure(c, TICK)))
      const every = Math.max(1, Math.ceil(Math.min(longest, 70) / slot))
      d.categories.forEach((c, i) => {
        if (i % every === 0)
          text(
            'category',
            xAt(i),
            plot.y + plot.h + 11,
            fit(c, TICK, every * slot - 4, measure),
            TICK,
            'center',
            MUTED,
          )
      })
    }
  } else {
    const cx = plot.x + plot.w / 2
    const cy = plot.y + plot.h / 2
    const r = Math.max(Math.min(plot.w, plot.h) / 2 - 4, 1)
    const r0 = d.kind === 'donut' ? r * 0.55 : 0
    plot.x = cx - r
    plot.y = cy - r
    plot.w = 2 * r
    plot.h = 2 * r
    if (total > 0) {
      let a = -Math.PI / 2
      slices.forEach((v, i) => {
        const sweep = (v / total) * 2 * Math.PI
        prims.push({
          k: 'arc',
          role: 'slice',
          cx,
          cy,
          r0,
          r1: r,
          a0: a,
          a1: a + sweep,
          fill: color(i),
        })
        a += sweep
      })
    } else
      prims.push({
        k: 'arc',
        role: 'slice',
        cx,
        cy,
        r0: r0 || 0,
        r1: r,
        a0: -Math.PI / 2,
        a1: (3 * Math.PI) / 2,
        fill: GRID,
      })
  }

  if (!hasData)
    text(
      'empty',
      plot.x + plot.w / 2,
      plot.y + plot.h / 2,
      'No data',
      13,
      'center',
      MUTED,
    )

  rows.forEach((row, k) => {
    const rowW =
      (row.at(-1)?.x ?? 0) + 14 + measure(row.at(-1)?.label ?? '', LEGEND)
    const x0 = Math.max((w - rowW) / 2, PAD)
    const y = h - PAD - (rows.length - k) * ROW + ROW / 2
    for (const it of row) {
      prims.push({
        k: 'rect',
        role: 'legendSwatch',
        x: x0 + it.x,
        y: y - 5,
        w: 10,
        h: 10,
        fill: color(it.i),
      })
      text(
        'legend',
        x0 + it.x + 14,
        y,
        fit(it.label, LEGEND, w - 2 * PAD - 14, measure),
        LEGEND,
        'left',
      )
    }
  })
  if (d.title)
    text('title', w / 2, 16, fit(d.title, TITLE, w - 2 * PAD, measure), TITLE)
  if (d.xLabel)
    text(
      'xLabel',
      plot.x + plot.w / 2,
      h - PAD - legendH - 6,
      fit(d.xLabel, TICK, w - 2 * PAD, measure),
      TICK,
      'center',
      MUTED,
    )
  if (d.yLabel)
    text(
      'yLabel',
      PAD + 6,
      plot.y + plot.h / 2,
      fit(d.yLabel, TICK, Math.max(plot.h, 0), measure),
      TICK,
      'center',
      MUTED,
      -Math.PI / 2,
    )

  return { prims, plot, ...(zeroY !== undefined && { zeroY }) }
}

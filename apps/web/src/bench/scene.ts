import {
  bounds,
  DEFAULT_STYLE,
  type Element,
  layoutText,
  type Platform,
  quantiseStroke,
  type Rect,
  zBetween,
} from '@whiteboard/core'

// S1's seeded scene (spikes/s1-canvas/web/scene.ts) restricted to the M1 element types, re-weighted to 5,000:
// 2,100 shapes + 600 lines/arrows + 2,300 text. No DOM at module scope: Platform is injected.
const MIX = { shape: 2100, line: 600, text: 2300 }
const INK = [
  '#1e1e1e',
  '#e03131',
  '#2f9e44',
  '#1971c2',
  '#f08c00',
  '#6741d9',
  '#0c8599',
  '#c2255c',
]
const FILL = ['#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99', '#d0bfff']
const KINDS = ['rect', 'ellipse', 'diamond', 'triangle'] as const
const SYLLABLES =
  'ka lo mi ren to sa vi ne tor que lin dar fo pel mu chi ga sto ber ix'.split(
    ' ',
  )
const ARABIC_LETTERS = [...'ابتثجحخدذرزسشصضطظعغفقكلمنهوي']

function rng(seed: number) {
  // mulberry32
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Elements are packed into `world` with every bounding box inside it (document the coverage with `describeScene`). */
export function makeScene(
  n: number,
  seed: number,
  world: { x: number; y: number; w: number; h: number },
  platform: Platform,
): Element[] {
  const r = rng(seed)
  const k = n / 5000
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))
  const between = (lo: number, hi: number) => lo + r() * (hi - lo)
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)] as T

  const types: (keyof typeof MIX)[] = []
  for (const [type, count] of Object.entries(MIX))
    for (let i = 0; i < count * k; i++) types.push(type as keyof typeof MIX)
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    const t = types[i] as keyof typeof MIX
    types[i] = types[j] as keyof typeof MIX
    types[j] = t
  }

  let shapes = 0
  let texts = 0
  let z: string | null = null
  const seen = new Set<string>()
  return types.map((type, i): Element => {
    z = zBetween(z, null)
    const base = {
      id: `b${seed}-${i}`,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      rotation: 0,
      z,
      style: {
        stroke: pick(INK),
        fill: null as string | null,
        strokeWidth: int(1, 3),
        opacity: 1,
        dash: 'solid' as const,
      },
      locked: false,
      author: { kind: 'human' as const, id: 'bench' },
      v: 0,
    }
    let el: Element
    if (type === 'shape') {
      if (r() < 0.5) base.style.fill = pick(FILL)
      el = {
        ...base,
        type: 'shape',
        w: between(10, 60),
        h: between(10, 60),
        data: { kind: pick(KINDS) },
      }
      if (shapes++ % 4 === 0) el.rotation = between(0.1, 2 * Math.PI - 0.1) // exactly 25% rotated
    } else if (type === 'line') {
      const w = between(12, 80)
      const h = between(12, 80)
      const flip = r() < 0.5
      el = {
        ...base,
        type: 'shape',
        w,
        h,
        data: {
          kind: r() < 0.5 ? 'arrow' : 'line',
          points: flip
            ? [
                [0, h],
                [w, 0],
              ]
            : [
                [0, 0],
                [w, h],
              ],
        },
      }
    } else {
      const arabic = texts++ % 5 < 2 // exactly 40% Arabic
      const word = () =>
        arabic
          ? Array.from({ length: int(3, 6) }, () => pick(ARABIC_LETTERS)).join(
              '',
            )
          : Array.from({ length: int(2, 3) }, () => pick(SYLLABLES)).join('')
      let text: string
      do text = Array.from({ length: int(1, 3) }, word).join(' ')
      while (seen.has(text)) // every string distinct: no flattering cache hits
      seen.add(text)
      el = {
        ...base,
        type: 'text',
        data: {
          text,
          size: int(12, 32),
          align: arabic ? 'right' : 'left',
          dir: arabic ? 'rtl' : 'ltr',
        },
      }
      const lay = layoutText(el, platform) // core invariant: the box is the layout
      el.w = lay.width
      el.h = lay.height
    }
    const b = bounds(el) // at (0, 0): translate so the whole box lies inside the world rect
    el.x = world.x - b.minX + r() * (world.w - (b.maxX - b.minX))
    el.y = world.y - b.minY + r() * (world.h - (b.maxY - b.minY))
    return el
  })
}

const area = (b: Rect) => (b.maxX - b.minX) * (b.maxY - b.minY)

// ---- M2 scenes: math, text and image grids (and the 10% math + image mix). The browser prepares what they need
// (MathJax metrics, imported image blobs) and passes it in, so this file stays free of DOM and providers.

type World = { x: number; y: number; w: number; h: number }
type Cell = { x: number; y: number; w: number; h: number }
export type MathMetrics = { width: number; height: number; depth: number }
export type BenchImage = { blobId: string; w: number; h: number }

/** Ten fixture-style equations; element i uses `mathLatex(i)`, so all 200 differ (no shared bitmap or layout). */
const EQUATIONS = [
  '\\frac{a+b}{c+d}',
  '\\sqrt{x^2+y^2}',
  '\\sum_{i=1}^{n} i=\\frac{n(n+1)}{2}',
  '\\int_0^\\infty e^{-x^2}\\,dx',
  '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}',
  'x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}',
  '\\lim_{x\\to 0}\\frac{\\sin x}{x}=1',
  '\\mathbb{N}\\subset\\mathbb{R}^n',
  '\\ce{2H2 + O2 -> 2H2O}',
  '\\boldsymbol{\\alpha}+\\boldsymbol{\\beta}',
]
export const mathLatex = (i: number) =>
  `${EQUATIONS[i % EQUATIONS.length]}+${i}`
export const MATH_SIZE = 12
const TEXT_SIZE = 14

function grid(n: number, world: World): Cell[] {
  const cols = Math.max(1, Math.round(Math.sqrt((n * world.w) / world.h)))
  const cw = world.w / cols
  const ch = world.h / Math.ceil(n / cols)
  return Array.from({ length: n }, (_, i) => ({
    x: world.x + (i % cols) * cw,
    y: world.y + Math.floor(i / cols) * ch,
    w: cw,
    h: ch,
  }))
}

function frame(id: string, z: string, cell: Cell) {
  return {
    id,
    ...cell,
    rotation: 0,
    z,
    style: {
      stroke: '#1e1e1e',
      fill: null as string | null,
      strokeWidth: 2,
      opacity: 1,
      dash: 'solid' as const,
    },
    locked: false,
    author: { kind: 'human' as const, id: 'bench' },
    v: 0,
  }
}

function mathEl(
  id: string,
  z: string,
  at: Cell,
  i: number,
  metrics: (latex: string) => MathMetrics,
): Element {
  const latex = mathLatex(i)
  const m = metrics(latex)
  return {
    ...frame(id, z, at),
    type: 'math',
    w: m.width * MATH_SIZE,
    h: (m.height + m.depth) * MATH_SIZE,
    data: { latex, display: true, size: MATH_SIZE },
  }
}

function imageEl(
  id: string,
  z: string,
  at: Cell,
  img: BenchImage,
  scale = 0.95,
): Element {
  const s = Math.min((at.w * scale) / img.w, (at.h * scale) / img.h)
  return {
    ...frame(id, z, at),
    type: 'image',
    w: img.w * s,
    h: img.h * s,
    data: { blobId: img.blobId, naturalW: img.w, naturalH: img.h },
  }
}

export function makeMathScene(
  n: number,
  world: World,
  metrics: (latex: string) => MathMetrics,
): Element[] {
  let z: string | null = null
  return grid(n, world).map((at, i) => {
    z = zBetween(z, null)
    return mathEl(`m${i}`, z, at, i, metrics)
  })
}

/** The baseline for makeMathScene: short distinct Latin strings of about the same box size. */
export function makeTextScene(
  n: number,
  world: World,
  platform: Platform,
): Element[] {
  let z: string | null = null
  return grid(n, world).map((at, i): Element => {
    z = zBetween(z, null)
    const word = (j: number) =>
      `${SYLLABLES[(i + j) % SYLLABLES.length]}${SYLLABLES[(i * 7 + j * 3) % SYLLABLES.length]}`
    const el: Element = {
      ...frame(`t${i}`, z, at),
      type: 'text',
      data: {
        text: `${word(0)} ${word(1)} ${i}`,
        size: TEXT_SIZE,
        align: 'left',
        dir: 'ltr',
      },
    }
    const lay = layoutText(el, platform)
    el.w = lay.width
    el.h = lay.height
    return el
  })
}

const CHART_KINDS = ['bar', 'line', 'area', 'pie', 'donut', 'scatter'] as const

/** The M6 chart baseline: n small charts (all six kinds, titled, two series where the kind takes them) in text200's grid. */
export function makeChartScene(n: number, world: World): Element[] {
  let z: string | null = null
  const categories = ['Q1', 'Q2', 'Q3', 'Q4']
  return grid(n, world).map((at, i): Element => {
    z = zBetween(z, null)
    const kind = CHART_KINDS[
      i % CHART_KINDS.length
    ] as (typeof CHART_KINDS)[number]
    const values = (k: number) =>
      categories.map((_, j) => ((i * 7 + j * 13 + k * 5) % 17) + 1)
    const one = kind === 'pie' || kind === 'donut'
    return {
      ...frame(`c${i}`, z, { ...at, w: 160, h: 110 }),
      type: 'chart',
      data:
        kind === 'scatter'
          ? {
              kind,
              title: `Chart ${i}`,
              categories: [],
              series: [0, 1].map((k) => ({
                name: `s${k}`,
                values: values(k),
                xs: [1, 2, 3, 4],
              })),
            }
          : {
              kind,
              title: `Chart ${i}`,
              categories,
              series: (one ? [0] : [0, 1]).map((k) => ({
                name: `s${k}`,
                values: values(k),
              })),
            },
    }
  })
}

export function makeImageScene(
  n: number,
  world: World,
  images: BenchImage[],
): Element[] {
  let z: string | null = null
  return grid(n, world).map((at, i) => {
    z = zBetween(z, null)
    return imageEl(`i${i}`, z, at, images[i % images.length] as BenchImage)
  })
}

/** The M1 scene with its last 10% replaced by 5% math and 5% images scattered over the same world. */
export function makeMixedScene(
  n: number,
  seed: number,
  world: World,
  platform: Platform,
  metrics: (latex: string) => MathMetrics,
  images: BenchImage[],
): Element[] {
  const base = makeScene(Math.round(n * 0.9), seed, world, platform)
  const r = rng(seed + 1000)
  const extra = Math.round(n * 0.05)
  let z = base.at(-1)?.z ?? null
  const at = (): Cell => ({
    x: world.x + r() * (world.w - 60),
    y: world.y + r() * (world.h - 60),
    w: 60,
    h: 40,
  })
  const out: Element[] = [...base]
  for (let i = 0; i < extra; i++) {
    z = zBetween(z, null)
    out.push(mathEl(`mm${i}`, z, at(), i, metrics))
    z = zBetween(z, null)
    out.push(
      imageEl(`mi${i}`, z, at(), images[i % images.length] as BenchImage, 1),
    )
  }
  return out
}

export const INK_STROKES = 500
export const INK_SHAPES = 1000
export const INK_POINTS = 100
/**
 * The M6 ink scene: 1,000 shapes and 500 freehand strokes of 100 points each, shuffled into one z order so ink lies both
 * under and over the shapes. Every tenth stroke is a highlighter (multiply); of the 450 pens, the 200 at odd stroke indexes carry pressure (a pen's), the rest none (a mouse's).
 * Strokes are wavy lines (a sine across a straight run, plus hand jitter), 40 to 160 units long, quantised the way the
 * pen tool commits them. Every bounding box (ink reach included) lies inside `world`.
 */
export function makeInkScene(world: World, seed = 1): Element[] {
  const r = rng(seed)
  const between = (lo: number, hi: number) => lo + r() * (hi - lo)
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)] as T

  const kinds = [
    ...Array<'shape'>(INK_SHAPES).fill('shape'),
    ...Array<'stroke'>(INK_STROKES).fill('stroke'),
  ]
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    const t = kinds[i] as 'shape' | 'stroke'
    kinds[i] = kinds[j] as 'shape' | 'stroke'
    kinds[j] = t
  }

  let z: string | null = null
  let shapes = 0
  let strokes = 0
  return kinds.map((kind, i): Element => {
    z = zBetween(z, null)
    const base = {
      id: `k${i}`,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      rotation: 0,
      z,
      locked: false,
      author: { kind: 'human' as const, id: 'bench' },
      v: 0,
    }
    let el: Element
    if (kind === 'shape') {
      el = {
        ...base,
        type: 'shape',
        w: between(10, 60),
        h: between(10, 60),
        rotation: shapes++ % 4 === 0 ? between(0.1, 2 * Math.PI - 0.1) : 0, // exactly 25% rotated
        style: {
          ...DEFAULT_STYLE,
          stroke: pick(INK),
          fill: r() < 0.5 ? pick(FILL) : null,
          strokeWidth: 1 + Math.floor(r() * 3),
        },
        data: { kind: pick(KINDS) },
      }
    } else {
      const k = strokes++
      const highlighter = k % 10 === 9
      const len = between(40, 160)
      const angle = between(0, 2 * Math.PI)
      const amp = between(3, 25)
      const freq = between(0.5, 3)
      const phase = between(0, 2 * Math.PI)
      const abs = Array.from({ length: INK_POINTS }, (_, j) => {
        const t = j / (INK_POINTS - 1)
        const off =
          amp * Math.sin(2 * Math.PI * freq * t + phase) + (r() - 0.5) * 0.6
        const along = len * t
        return [
          along * Math.cos(angle) - off * Math.sin(angle),
          along * Math.sin(angle) + off * Math.cos(angle),
        ] as [number, number]
      })
      const pressure =
        !highlighter && k % 2 === 1
          ? abs.map(
              (_, j) => 0.3 + 0.5 * Math.sin((Math.PI * j) / (INK_POINTS - 1)),
            )
          : undefined
      const q = quantiseStroke(abs, pressure)
      el = {
        ...base,
        type: 'freehand',
        x: q.x,
        y: q.y,
        w: q.w,
        h: q.h,
        style: {
          ...DEFAULT_STYLE,
          ...(highlighter
            ? { stroke: '#ffd400', strokeWidth: 18, opacity: 0.45 }
            : { stroke: pick(INK), strokeWidth: 3 }),
        },
        data: {
          points: q.points,
          ...(q.pressure ? { pressure: q.pressure } : {}),
          smoothing: 0.5,
          highlighter,
        },
      }
    }
    const b = bounds(el) // translate so the whole box, ink reach included, lies inside the world rect
    el.x += world.x - b.minX + r() * (world.w - (b.maxX - b.minX))
    el.y += world.y - b.minY + r() * (world.h - (b.maxY - b.minY))
    return el
  })
}

/** Counts for the mix, and how many times the bounding boxes cover the world rect. */
export function describeScene(els: Element[], world: { w: number; h: number }) {
  const shapes = els.filter(
    (e) =>
      e.type === 'shape' && e.data.kind !== 'line' && e.data.kind !== 'arrow',
  )
  const text = els.filter((e) => e.type === 'text')
  const ink = els.filter((e) => e.type === 'freehand')
  return {
    total: els.length,
    shapes: shapes.length,
    lines: els.length - shapes.length - text.length - ink.length,
    text: text.length,
    strokes: ink.length,
    highlighters: ink.filter((e) => e.type === 'freehand' && e.data.highlighter)
      .length,
    rotatedShapes: shapes.filter((e) => e.rotation !== 0).length,
    arabicText: text.filter((e) => e.type === 'text' && e.data.dir === 'rtl')
      .length,
    coverage: +(
      els.reduce((s, e) => s + area(bounds(e)), 0) /
      (world.w * world.h)
    ).toFixed(1),
  }
}

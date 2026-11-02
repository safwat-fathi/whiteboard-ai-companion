import {
  bounds,
  type Element,
  layoutText,
  type Platform,
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

/** Counts for the mix, and how many times the bounding boxes cover the world rect. */
export function describeScene(els: Element[], world: { w: number; h: number }) {
  const shapes = els.filter(
    (e) =>
      e.type === 'shape' && e.data.kind !== 'line' && e.data.kind !== 'arrow',
  )
  const text = els.filter((e) => e.type === 'text')
  return {
    total: els.length,
    shapes: shapes.length,
    lines: els.length - shapes.length - text.length,
    text: text.length,
    rotatedShapes: shapes.filter((e) => e.rotation !== 0).length,
    arabicText: text.filter((e) => e.type === 'text' && e.data.dir === 'rtl')
      .length,
    coverage: +(
      els.reduce((s, e) => s + area(bounds(e)), 0) /
      (world.w * world.h)
    ).toFixed(1),
  }
}

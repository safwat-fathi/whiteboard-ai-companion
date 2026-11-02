import { createCanvas } from '@napi-rs/canvas'
import { beforeAll, describe, expect, it } from 'vitest'
import { matchesGolden } from '../test/matchesGolden'
import { nodePlatform, registerBundledFonts } from './node'
import { FONT_STACK } from './platform'
import { RenderCache, render } from './render'
import { createScene } from './scene'
import type { Camera, Element, TextData } from './schema'
import { mk } from './test-utils'
import { layoutText, resolveDir } from './text'

const platform = nodePlatform()
beforeAll(registerBundledFonts)

type TextEl = Element & { type: 'text' }
const txt = (id: string, data: Partial<TextData>, p: Partial<Element> = {}) =>
  mk(id, {
    type: 'text',
    data: { text: '', size: 24, align: 'left', dir: 'auto', ...data },
    ...p,
  } as never) as TextEl

const TIGHT = { maxMeanDiff: 0.05, maxBigDiffRatio: 0.0005 }
const vp = { width: 600, height: 420, dpr: 1 }
const cam: Camera = { x: 0, y: 0, zoom: 1 }
const canvas = (w = vp.width, h = vp.height) => {
  const c = createCanvas(w, h)
  return { c, ctx: c.getContext('2d') as unknown as CanvasRenderingContext2D }
}

const AR40 = 'الرياضيات هي لغة العلوم وبدونها لا يمكن فهم الفيزياء'
const FAMILY = '👨‍👩‍👧‍👦'
const SHADDA = 'الطَّالِبُ' // lam, ta + shadda + fatha ...

describe('resolveDir', () => {
  it('uses the first strong character for auto', () => {
    expect(resolveDir('مرحبا hello', 'auto')).toBe('rtl')
    expect(resolveDir('hello مرحبا', 'auto')).toBe('ltr')
    expect(resolveDir('123', 'auto')).toBe('ltr')
    expect(resolveDir('', 'auto')).toBe('ltr')
    expect(resolveDir('٣٤ (שלום)', 'auto')).toBe('rtl')
  })
  it('honours an explicit dir', () => {
    expect(resolveDir('hello', 'rtl')).toBe('rtl')
    expect(resolveDir('مرحبا', 'ltr')).toBe('ltr')
  })
})

describe('layoutText', () => {
  it('wraps Arabic at maxWidth without losing text', () => {
    expect(AR40.length).toBeGreaterThanOrEqual(40)
    const l = layoutText(txt('a', { text: AR40, maxWidth: 200 }), platform)
    expect(l.lines.length).toBeGreaterThanOrEqual(2)
    for (const line of l.lines) {
      expect(line.width).toBeLessThanOrEqual(200)
      expect(line.dir).toBe('rtl')
    }
    expect(l.lines.map((x) => x.text).join(' ')).toBe(AR40)
    expect(l.height).toBeCloseTo(l.lines.length * 24 * 1.4)
  })

  const clusters = (s: string) =>
    [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)]
      .map((x) => x.segment)
      .filter((g) => g.trim())
  for (const [name, text] of [
    ['an emoji ZWJ sequence', `a ${FAMILY} b ${FAMILY}${FAMILY}`],
    ['an Arabic letter with shadda and fatha', SHADDA],
  ] as const) {
    it(`never splits ${name}`, () => {
      const l = layoutText(txt('c', { text, maxWidth: 5 }), platform)
      expect(l.lines.length).toBeGreaterThan(1)
      expect(l.lines.flatMap((x) => clusters(x.text))).toEqual(clusters(text))
    })
  }

  it('yields one line for empty and whitespace-only text', () => {
    for (const text of ['', '   ']) {
      const l = layoutText(txt('e', { text, maxWidth: 100 }), platform)
      expect(l.lines).toHaveLength(1)
      expect(l.height).toBeGreaterThan(0)
    }
  })

  it('splits paragraphs on newline and resolves dir per paragraph', () => {
    const l = layoutText(txt('p', { text: 'hello\nمرحبا' }), platform)
    expect(l.lines.map((x) => x.dir)).toEqual(['ltr', 'rtl'])
    expect(l.lines[1]?.y).toBeCloseTo(24 * 1.4)
  })

  it('places lines by visual align', () => {
    const at = (align: TextData['align']) =>
      layoutText(
        txt('x', { text: 'hi\nhello', maxWidth: 200, align }),
        platform,
      )
    const r = at('right').lines[0]
    expect(r && r.x + r.width).toBeCloseTo(200)
    expect(at('left').lines[0]?.x).toBe(0)
    const c = at('center').lines[0]
    expect(c && c.x * 2 + c.width).toBeCloseTo(200)
  })

  const lay = (text: string, maxWidth?: number) =>
    layoutText(txt('w', { text, maxWidth }), platform)

  it('breaks a long unbroken word by grapheme, within maxWidth', () => {
    const l = lay('abcdefghijklmnopqrstuvwxyz'.repeat(3), 100)
    expect(l.lines.length).toBeGreaterThan(2)
    for (const x of l.lines) expect(x.width).toBeLessThanOrEqual(100)
    expect(l.lines.map((x) => x.text).join('')).toBe(
      'abcdefghijklmnopqrstuvwxyz'.repeat(3),
    )
  })

  it('handles a 10,000-char single word quickly', () => {
    const word = 'a'.repeat(10_000)
    lay(word.slice(0, 300), 400) // warm-up
    const t = performance.now()
    const l = lay(word, 400)
    expect(performance.now() - t).toBeLessThan(1000)
    expect(l.lines.map((x) => x.text).join('')).toBe(word)
    for (const x of l.lines) expect(x.width).toBeLessThanOrEqual(400)
  })

  it('keeps leading whitespace, blank lines and a trailing newline', () => {
    expect(lay('  ab').lines[0]?.text).toBe('  ab')
    expect(lay('a\n\nb').lines.map((x) => x.text)).toEqual(['a', '', 'b'])
    expect(lay('a\n').lines.map((x) => x.text)).toEqual(['a', ''])
  })

  it('drops whitespace at a wrap boundary and treats NBSP as unbreakable', () => {
    const w = platform.measureText(`24px ${FONT_STACK}`, 'hellow') // wider than either word
    const l = lay('hello world', w + 1)
    expect(l.lines.map((x) => x.text)).toEqual(['hello', 'world'])
    expect(lay('hello\u00a0world', w + 1).lines.length).toBeGreaterThan(1)
    expect(lay('hello\u00a0world', w + 1).lines[0]?.text).not.toBe('hello')
  })

  it('memoises layout per element object', () => {
    let calls = 0
    const counting = {
      ...platform,
      measureText: (f: string, t: string) => {
        calls++
        return platform.measureText(f, t)
      },
    }
    const scene = createScene(goldenEls())
    const cache = new RenderCache()
    const { ctx } = canvas()
    render(ctx, scene, cam, vp, counting, { cache })
    const first = calls
    expect(first).toBeGreaterThan(0)
    render(ctx, scene, cam, vp, counting, { cache })
    expect(calls).toBe(first)
    cache.dispose()
  })

  it('evicts least recently used bitmaps over the byte cap and re-rasterises', () => {
    const els = ['a', 'b', 'c'].map((id, i) =>
      txt(id, { text: 'cap test' }, { x: 10, y: 10 + i * 40 }),
    )
    const scene = createScene(els)
    const cache = new RenderCache(6000) // each bitmap is a few thousand bytes
    const a = canvas()
    render(a.ctx, scene, cam, vp, platform, { cache })
    expect(cache.get(1, 'c', 0)).toBeDefined()
    expect(cache.get(1, 'a', 0)).toBeUndefined() // oldest evicted
    const b = canvas()
    render(b.ctx, scene, cam, vp, platform, { cache })
    expect(a.c.toBuffer('image/png').equals(b.c.toBuffer('image/png'))).toBe(
      true,
    )
    cache.dispose()
  })

  it('closes an evicted bitmap', () => {
    const cache = new RenderCache(10)
    let closed = 0
    const bm = () => ({ close: () => closed++ })
    cache.set(1, 'a', 0, bm(), 8)
    cache.set(1, 'b', 0, bm(), 8)
    expect(closed).toBe(1)
    expect(cache.get(1, 'a', 0)).toBeUndefined()
    cache.dispose()
    expect(closed).toBe(2)
  })

  it('lays out 10,000 characters in under 200 ms', () => {
    const text = `${'hello مرحبا world '.repeat(625)}`.slice(0, 10_000)
    layoutText(
      txt('warm', { text: text.slice(0, 500), maxWidth: 400 }),
      platform,
    )
    for (const maxWidth of [undefined, 400]) {
      const t = performance.now()
      layoutText(txt('big', { text, maxWidth }), platform)
      expect(performance.now() - t).toBeLessThan(200)
    }
  })
})

const goldenEls = (): Element[] => [
  txt('lat', { text: 'Hello, whiteboard 123' }, { x: 20, y: 10 }),
  txt('ar', { text: 'مَرْحَبًا بِكُمْ في الْعِلْمِ' }, { x: 20, y: 50 }),
  txt(
    'mix',
    { text: 'الجذر (square root) للعدد 16 يساوي 4' },
    { x: 20, y: 90 },
  ),
  txt('dig', { text: 'العدد ٣٫١٤١٥٩ في ٢٠٢٦' }, { x: 20, y: 130 }),
  txt(
    'wrap',
    { text: AR40, maxWidth: 260, align: 'right' },
    { x: 20, y: 180, w: 260, h: 130 },
  ),
  txt(
    'rtl',
    { text: 'محاذاة لليمين', align: 'right', maxWidth: 260 },
    { x: 320, y: 180, w: 260, h: 34 },
  ),
]

describe('text rendering', () => {
  it('matches the mixed text golden', async () => {
    const { c, ctx } = canvas()
    render(ctx, createScene(goldenEls()), cam, vp, platform)
    await matchesGolden(c, 'text-mixed', TIGHT)
  })

  it('matches the zoom 2 text golden', async () => {
    const { c, ctx } = canvas()
    render(
      ctx,
      createScene(goldenEls()),
      { x: 0, y: 40, zoom: 2 },
      vp,
      platform,
      {
        cache: new RenderCache(),
      },
    )
    await matchesGolden(c, 'text-mixed-zoom2', TIGHT)
  })

  it('draws text and counts it', () => {
    const { ctx } = canvas()
    expect(render(ctx, createScene(goldenEls()), cam, vp, platform).drawn).toBe(
      6,
    )
  })

  it('renders identical pixels twice, cached', () => {
    const scene = createScene(goldenEls())
    const cache = new RenderCache()
    const a = canvas()
    const b = canvas()
    render(a.ctx, scene, cam, vp, platform, { cache })
    render(b.ctx, scene, cam, vp, platform, { cache })
    const png = (x: ReturnType<typeof canvas>) => x.c.toBuffer('image/png')
    expect(png(a).equals(png(b))).toBe(true)
    cache.dispose()
  })

  it('caches per (zoom bucket, id, v) and dispose closes the bitmaps', () => {
    const el = txt('t', { text: 'cached' }, { x: 10, y: 10 })
    const cache = new RenderCache()
    const { ctx } = canvas()
    render(ctx, createScene([el]), { x: 0, y: 0, zoom: 1.5 }, vp, platform, {
      cache,
    })
    const bmp = cache.get<{ canvas: { width: number }; close(): void }>(
      2,
      't',
      0,
    )
    expect(bmp?.canvas.width).toBeGreaterThan(0)
    expect(cache.get(2, 't', 1)).toBeUndefined()
    cache.dispose()
    expect(bmp?.canvas.width).toBe(0)
    expect(cache.get(2, 't', 0)).toBeUndefined()
  })

  it('draws bitmaps over 4096 px a side directly instead of caching', () => {
    const el = txt('huge', { text: 'big', size: 600 }, { x: 0, y: 0 })
    const cache = new RenderCache()
    const { ctx } = canvas()
    // 600 px text at zoom 8 is far over 4096 px wide
    const stats = render(
      ctx,
      createScene([el]),
      { x: 0, y: 0, zoom: 8 },
      vp,
      platform,
      { cache },
    )
    expect(stats.drawn).toBe(1)
    expect(cache.get(8, 'huge', 0)).toBeUndefined()
    const small = txt('s', { text: 'big', size: 20 })
    render(ctx, createScene([small]), { x: 0, y: 0, zoom: 8 }, vp, platform, {
      cache,
    })
    expect(cache.get(8, 's', 0)).toBeDefined()
    cache.dispose()
  })
})

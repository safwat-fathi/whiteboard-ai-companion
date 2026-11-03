import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import {
  type BlobStore,
  coreTools,
  type Element,
  fitMath,
  layoutText,
} from '@whiteboard/core'
import { nodePlatform, registerBundledFonts } from '@whiteboard/core/node'
import { renderMath } from '@whiteboard/math'
import type Database from 'better-sqlite3'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDiskBlobStore } from './blobs'
import { createBlobsDb, openDatabase } from './db'
import { mapLimit, renderBoardPng } from './export'

const roots: string[] = []
const dbs: Database.Database[] = []
afterEach(() => {
  for (const d of dbs.splice(0)) if (d.open) d.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
const store = (): BlobStore => {
  const root = mkdtempSync(join(tmpdir(), 'wb-export-'))
  roots.push(root)
  const db = openDatabase({ dataDir: join(root, 'data') })
  dbs.push(db)
  return createDiskBlobStore({
    dataDir: join(root, 'data'),
    db: createBlobsDb(db),
  })
}

let n = 0
const frame = (id: string, x: number, y: number, w: number, h: number) => ({
  id,
  x,
  y,
  w,
  h,
  rotation: 0,
  z: `a${String(n++).padStart(6, '0')}`,
  style: {
    stroke: '#1e1e1e',
    fill: null as string | null,
    strokeWidth: 2,
    opacity: 1,
    dash: 'solid' as const,
  },
  locked: false,
  author: { kind: 'human' as const, id: 'owner' },
  v: 0,
})
const rect = (
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Element =>
  ({
    ...frame(id, x, y, w, h),
    type: 'shape',
    data: { kind: 'rect' },
  }) as Element
const platform = nodePlatform()
const textEl = (id: string, text: string, x: number, y: number): Element => {
  const el = {
    ...frame(id, x, y, 10, 10),
    type: 'text' as const,
    data: { text, size: 24, align: 'left' as const, dir: 'auto' as const },
  }
  const lay = layoutText(el as Parameters<typeof layoutText>[0], platform)
  return { ...el, w: lay.width, h: lay.height } as Element
}
const mathEl = async (
  id: string,
  latex: string,
  x: number,
  y: number,
): Promise<Element> => {
  const r = await renderMath(latex, { display: true, color: '#1e1e1e' })
  const { w, h } = r.ok ? fitMath(r, 28) : { w: 220, h: 40 }
  return {
    ...frame(id, x, y, w, h),
    type: 'math',
    data: { latex, display: true, size: 28 },
  } as Element
}
const imageEl = (id: string, blobId: string, x: number, y: number): Element =>
  ({
    ...frame(id, x, y, 120, 80),
    type: 'image',
    data: { blobId, naturalW: 60, naturalH: 40 },
  }) as Element

async function redPng(): Promise<Buffer> {
  const c = createCanvas(60, 40)
  const g = c.getContext('2d')
  g.fillStyle = '#ff0000'
  g.fillRect(0, 0, 60, 40)
  return c.encode('png')
}

type Px = { r: number; g: number; b: number }
async function pixels(png: Buffer) {
  const img = await loadImage(png)
  const c = createCanvas(img.width, img.height)
  const g = c.getContext('2d')
  g.drawImage(img, 0, 0)
  const d = g.getImageData(0, 0, img.width, img.height)
  return {
    width: img.width,
    height: img.height,
    at: (x: number, y: number): Px => ({
      r: d.data[(y * img.width + x) * 4] ?? 0,
      g: d.data[(y * img.width + x) * 4 + 1] ?? 0,
      b: d.data[(y * img.width + x) * 4 + 2] ?? 0,
    }),
    count(
      x0: number,
      y0: number,
      w: number,
      h: number,
      pred: (p: Px) => boolean,
    ) {
      let k = 0
      for (let y = y0; y < y0 + h; y++)
        for (let x = x0; x < x0 + w; x++) if (pred(this.at(x, y))) k++
      return k
    },
  }
}
const dark = (p: Px) => p.r < 90 && p.g < 90 && p.b < 90
const red = (p: Px) => p.r > 200 && p.g < 60 && p.b < 60
const nonWhite = (p: Px) => p.r < 250 || p.g < 250 || p.b < 250

beforeAll(() => registerBundledFonts())

describe('renderBoardPng', () => {
  it('draws every element type (shape, Arabic and Latin text, math, invalid math, image) at the requested size', async () => {
    const blobs = store()
    const id = await blobs.put(await redPng(), 'image/png')
    const scene = [
      rect('r', 20, 20, 160, 90),
      textEl('t-en', 'Hello world', 220, 30),
      textEl('t-ar', 'مرحبا بالعالم', 220, 80),
      await mathEl('m', '\\frac{a}{b}+\\sqrt{x}', 20, 140),
      await mathEl('bad', '\\frac{', 20, 220),
      imageEl('img', id, 300, 140),
    ]
    const png = await renderBoardPng(
      scene,
      { x: 0, y: 0, w: 480, h: 300 },
      480,
      { blobs },
    )
    const px = await pixels(png)
    expect([px.width, px.height]).toEqual([480, 300])
    expect(px.count(18, 18, 164, 94, dark)).toBeGreaterThan(100) // the rectangle's stroke
    expect(px.count(220, 28, 150, 40, dark)).toBeGreaterThan(80) // Latin text
    expect(px.count(220, 78, 150, 40, dark)).toBeGreaterThan(80) // Arabic text
    expect(px.count(20, 140, 120, 70, dark)).toBeGreaterThan(150) // math ink, not a dashed placeholder
    expect(px.count(20, 220, 220, 40, red)).toBeGreaterThan(20) // invalid LaTeX is drawn as red source
    expect(px.at(360, 180)).toEqual({ r: 255, g: 0, b: 0 }) // the image bytes came out of the blob store
  })

  it('renders MathJax itself: an equation nobody rendered first is drawn, not left as a placeholder', async () => {
    // Fixed size and a formula no other test renders, so the shared MathJax cache is cold for it.
    const fresh = {
      ...frame('fresh', 20, 20, 150, 60),
      type: 'math',
      data: {
        latex: '\\sum_{k=1}^{n} k^{3} \\cdot \\pi_{7}',
        display: true,
        size: 28,
      },
    } as Element
    const png = await renderBoardPng(
      [fresh],
      { x: 0, y: 0, w: 200, h: 100 },
      200,
      { blobs: store() },
    )
    const px = await pixels(png)
    expect(px.count(20, 20, 150, 60, dark)).toBeGreaterThan(150)
  })

  it('draws a placeholder instead of throwing when an image blob is missing', async () => {
    const blobs = store()
    const png = await renderBoardPng(
      [imageEl('img', 'f'.repeat(64), 20, 20)],
      { x: 0, y: 0, w: 200, h: 140 },
      200,
      { blobs },
    )
    const px = await pixels(png)
    expect(px.count(0, 0, 200, 140, nonWhite)).toBeGreaterThan(20)
    expect(px.count(0, 0, 200, 140, red)).toBe(0)
  })

  it('never decodes an image the upload rule would refuse: a real PNG over 8192 px is a placeholder', async () => {
    // 8193 x 4 is a genuine, tiny-to-decode PNG, so only the header check stands between it and the canvas.
    const wide = createCanvas(8193, 4)
    const g = wide.getContext('2d')
    g.fillStyle = '#ff0000'
    g.fillRect(0, 0, 8193, 4)
    const bytes = await wide.encode('png')
    const stub: BlobStore = {
      put: async () => '',
      has: async () => true,
      get: async () => ({ bytes: new Uint8Array(bytes), mime: 'image/png' }),
    }
    const png = await renderBoardPng(
      [imageEl('img', 'a'.repeat(64), 20, 20)],
      { x: 0, y: 0, w: 200, h: 140 },
      200,
      { blobs: stub },
    )
    const px = await pixels(png)
    expect(px.count(0, 0, 200, 140, red)).toBe(0)
    expect(px.count(0, 0, 200, 140, nonWhite)).toBeGreaterThan(20) // the placeholder
  })

  it('reads at most two blobs at a time however many images the board has', async () => {
    let running = 0
    let peak = 0
    const slow: BlobStore = {
      put: async () => '',
      has: async () => true,
      get: async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 15))
        running--
        return undefined
      },
    }
    const scene = Array.from({ length: 8 }, (_, i) =>
      imageEl(`i${i}`, String(i).repeat(64).slice(0, 64), 10 + i * 20, 10),
    )
    await renderBoardPng(scene, { x: 0, y: 0, w: 200, h: 60 }, 200, {
      blobs: slow,
    })
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThanOrEqual(2) // a literal, so raising the constant fails this test instead of moving it
  })

  it('renders an empty board as a blank image of the requested size', async () => {
    const px = await pixels(
      await renderBoardPng([], { x: 0, y: 0, w: 100, h: 50 }, 200, {
        blobs: store(),
      }),
    )
    expect([px.width, px.height]).toEqual([200, 100])
    expect(px.count(0, 0, 200, 100, nonWhite)).toBe(0)
  })

  it('follows the rect and width: scale and offset', async () => {
    const scene = [rect('r', 100, 100, 50, 50)]
    const a = await pixels(
      await renderBoardPng(scene, { x: 90, y: 90, w: 80, h: 80 }, 160, {
        blobs: store(),
      }),
    )
    expect([a.width, a.height]).toEqual([160, 160])
    expect(a.count(18, 18, 24, 24, dark)).toBeGreaterThan(40) // the rect's top-left corner is at (10,10) world => (20,20) px
    const off = await pixels(
      await renderBoardPng(scene, { x: 500, y: 500, w: 80, h: 80 }, 160, {
        blobs: store(),
      }),
    )
    expect(off.count(0, 0, 160, 160, nonWhite)).toBe(0)
  })

  it.each([
    ['width 4097', { x: 0, y: 0, w: 100, h: 100 }, 4097],
    ['width 15', { x: 0, y: 0, w: 100, h: 100 }, 15],
    ['width NaN', { x: 0, y: 0, w: 100, h: 100 }, Number.NaN],
    ['negative w', { x: 0, y: 0, w: -1, h: 100 }, 400],
    ['zero h', { x: 0, y: 0, w: 100, h: 0 }, 400],
    ['NaN h', { x: 0, y: 0, w: 100, h: Number.NaN }, 400],
    ['infinite x', { x: Number.POSITIVE_INFINITY, y: 0, w: 100, h: 100 }, 400],
    [
      'an extreme aspect (output height over 8192)',
      { x: 0, y: 0, w: 1, h: 1_000_000 },
      1024,
    ],
  ])('refuses %s with validation_failed', async (_n, rectArg, width) => {
    await expect(
      renderBoardPng([], rectArg, width, { blobs: store() }),
    ).rejects.toMatchObject({ code: 'validation_failed' })
  })

  it('renders a 100-element board in under two seconds', async () => {
    const scene = Array.from({ length: 100 }, (_, i) =>
      rect(`r${i}`, (i % 10) * 30, Math.floor(i / 10) * 30, 24, 24),
    )
    const t0 = performance.now()
    await renderBoardPng(scene, { x: 0, y: 0, w: 300, h: 300 }, 600, {
      blobs: store(),
    })
    expect(performance.now() - t0).toBeLessThan(2000)
  })

  it('two concurrent exports of different rects do not share state', async () => {
    const blobs = store()
    const scene = [rect('r', 10, 10, 60, 60), await mathEl('m', 'x^2', 100, 10)]
    const [a, b] = await Promise.all([
      renderBoardPng(scene, { x: 0, y: 0, w: 100, h: 100 }, 200, { blobs }),
      renderBoardPng(scene, { x: 90, y: 0, w: 200, h: 50 }, 400, { blobs }),
    ])
    const [pa, pb] = [await pixels(a), await pixels(b)]
    expect([pa.width, pa.height]).toEqual([200, 200])
    expect([pb.width, pb.height]).toEqual([400, 100])
    expect(pa.count(18, 18, 124, 124, dark)).toBeGreaterThan(100)
    expect(pb.count(0, 0, 400, 100, dark)).toBeGreaterThan(40) // the equation, not the rectangle
  })
})

describe('mapLimit', () => {
  it('runs every item, never more than the limit at once, and handles an empty list', async () => {
    let running = 0
    let peak = 0
    const seen: number[] = []
    await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      seen.push(n)
      running--
    })
    expect(peak).toBe(3)
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7])
    await mapLimit([], 3, async () => {
      throw new Error('never called')
    })
  })
})

describe('chart in the picture', () => {
  beforeAll(() => registerBundledFonts())
  it('draws the bars of a chart element in its series colour, as the browser does', async () => {
    const chart = {
      ...frame('chart', 10, 10, 300, 200),
      type: 'chart',
      data: {
        kind: 'bar',
        title: 'Sales',
        categories: ['A', 'B', 'C'],
        series: [{ name: 's', values: [3, 5, 2] }],
      },
    } as Element
    const png = await renderBoardPng(
      [chart],
      { x: 0, y: 0, w: 320, h: 220 },
      320,
      { blobs: store() },
    )
    const img = await loadImage(png)
    const c = createCanvas(img.width, img.height)
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    let blue = 0
    for (let i = 0; i < data.length; i += 4)
      if (
        Math.abs((data[i] as number) - 0) < 12 &&
        Math.abs((data[i + 1] as number) - 114) < 12 &&
        Math.abs((data[i + 2] as number) - 178) < 12
      )
        blue++
    expect(blue).toBeGreaterThan(1500) // three bars: far more than antialiasing noise
  })
})

describe('stroke in the picture', () => {
  beforeAll(() => registerBundledFonts())
  it('draws what draw_stroke made, in ink on white, where the stroke is', async () => {
    const tool = coreTools.find((t) => t.name === 'draw_stroke')
    if (!tool) throw new Error('no draw_stroke')
    const out = await tool.execute(
      tool.input.parse({
        points: [
          [0, 0],
          [100, 40],
          [200, 0],
        ],
        width: 8,
        placement: { x: 20, y: 30 },
      }),
      {
        scene: { els: new Map() },
        platform: nodePlatform(),
        turnId: 't',
        author: { kind: 'agent', id: 'tutor:t' },
        grantedIds: new Set(),
        selection: [],
        added: 0,
      },
    )
    if (out.kind !== 'write') throw new Error('not a write')
    const el = (out.batch.ops[0] as { el: Element }).el
    const png = await renderBoardPng(
      [el],
      { x: 0, y: 0, w: 240, h: 100 },
      240,
      { blobs: store() },
    )
    const img = await loadImage(png)
    const c = createCanvas(img.width, img.height)
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const dark = (x: number, y: number) =>
      (ctx.getImageData(x, y, 1, 1).data[0] as number) < 100
    // a pen tapers at its ends, so probe the quarter points of the two segments and the vertex between them
    expect(dark(70, 50)).toBe(true)
    expect(dark(120, 70)).toBe(true)
    expect(dark(170, 50)).toBe(true)
    expect(dark(120, 10)).toBe(false) // empty board above it stays white
  })
})

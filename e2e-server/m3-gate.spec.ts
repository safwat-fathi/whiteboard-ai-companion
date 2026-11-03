import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { decodePng, encodePng } from '../e2e/helpers/diff'
import { type RunningServer, startServer } from './helpers/server'

test.use({
  deviceScaleFactor: 1,
  viewport: { width: 1000, height: 800 },
})

type El = {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  style?: { fill?: string | null; stroke?: string }
  data: Record<string, unknown>
}

type W = {
  __editor?: {
    readOnly: boolean
    camera: { x: number; y: number; zoom: number }
    selection: Set<string>
    scene: { els: Map<string, El> }
    platform: { images?: { peek(id: string): unknown } }
    getSnapshot(): { elements: El[] }
    commit(batch: unknown): void
    invalidate(): void
  }
}

const ready = async (page: Page) => {
  await page.waitForFunction(
    () =>
      (window as unknown as W).__editor &&
      !(window as unknown as W).__editor?.readOnly,
  )
}

const alerts = (page: Page) =>
  page.locator('[aria-live="polite"] [role="alert"]')

const elements = (page: Page): Promise<El[]> =>
  page.evaluate(
    () => (window as unknown as W).__editor?.getSnapshot().elements ?? [],
  )

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from)
  await page.mouse.down()
  await page.mouse.move(...to, { steps: 8 })
  await page.mouse.up()
}

/** Press, drag through `pts`, release (real mouse input: pointerType 'mouse', no pressure). */
async function stroke(page: Page, pts: [number, number][]) {
  const [first, ...rest] = pts as [[number, number], ...[number, number][]]
  await page.mouse.move(...first)
  await page.mouse.down()
  for (const p of rest) await page.mouse.move(...p, { steps: 4 })
  await page.mouse.up()
}

type Box = { x: number; y: number; w: number; h: number }

/** The pixels of a PNG inside `r` (clamped to the picture), as an RGBA array and as a PNG, so two crops can be compared. */
function crop(png: Buffer, r: Box) {
  const img = decodePng(png)
  const x0 = Math.max(0, r.x)
  const y0 = Math.max(0, r.y)
  const w = Math.min(img.width, r.x + r.w) - x0
  const h = Math.min(img.height, r.y + r.h) - y0
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * img.width + x0) * 4
    rgba.set(img.data.subarray(from, from + w * 4), y * w * 4)
  }
  return { png: encodePng(w, h, rgba), rgba }
}

const countPixels = (
  rgba: Uint8Array,
  is: (r: number, g: number, b: number) => boolean,
) => {
  let n = 0
  for (let i = 0; i < rgba.length; i += 4)
    if (is(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0)) n++
  return n
}

async function typeText(page: Page, at: [number, number], text: string) {
  await page.keyboard.press('t')
  await page.mouse.click(...at)
  await expect(
    page.locator('textarea:not([aria-label="Message the tutor"])'),
  ).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Escape')
  await expect(
    page.locator('textarea:not([aria-label="Message the tutor"])'),
  ).toHaveCount(0)
}

async function typeMath(page: Page, at: [number, number], latex: string) {
  await page.keyboard.press('m')
  await page.mouse.click(...at)
  const box = page.getByLabel('LaTeX')
  await expect(box).toBeFocused()
  await box.fill(latex)
  await page.keyboard.press('ControlOrMeta+Enter')
}

const frames = (page: Page, n = 2) =>
  page.evaluate(
    (k) =>
      new Promise<void>((done) => {
        const f = (i: number) =>
          i <= 0 ? done() : requestAnimationFrame(() => f(i - 1))
        f(k)
      }),
    n,
  )

function comparePngBuffers(
  actualPng: Buffer,
  expectedPng: Buffer,
  channelThreshold = 24,
): {
  ratio: number
  differing: number
  total: number
  w: number
  h: number
  diffRgba: Uint8Array
} {
  const act = decodePng(actualPng)
  const exp = decodePng(expectedPng)
  const w = Math.min(act.width, exp.width)
  const h = Math.min(act.height, exp.height)
  let differing = 0
  const total = w * h
  const diffRgba = new Uint8Array(w * h * 4)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ai = (y * act.width + x) * 4
      const ei = (y * exp.width + x) * 4
      const di = (y * w + x) * 4
      let diff = false
      for (let k = 0; k < 4; k++) {
        if (
          Math.abs((act.data[ai + k] ?? 0) - (exp.data[ei + k] ?? 0)) >
          channelThreshold
        ) {
          diff = true
          break
        }
      }
      if (diff) {
        differing++
        diffRgba[di] = 255
        diffRgba[di + 1] = 0
        diffRgba[di + 2] = 0
        diffRgba[di + 3] = 255
      } else {
        const lum = Math.round(
          ((act.data[ai] ?? 255) +
            (act.data[ai + 1] ?? 255) +
            (act.data[ai + 2] ?? 255)) /
            3,
        )
        diffRgba[di] = lum
        diffRgba[di + 1] = lum
        diffRgba[di + 2] = lum
        diffRgba[di + 3] = 80
      }
    }
  }

  return {
    ratio: total === 0 ? 0 : differing / total,
    differing,
    total,
    w,
    h,
    diffRgba,
  }
}

test.describe
  .serial('M3 Gate', () => {
    let server: RunningServer
    let dataDir: string

    test.beforeAll(async () => {
      dataDir = mkdtempSync(join(tmpdir(), 'wb-m3-gate-'))
      server = await startServer({
        dataDir,
        port: 4201,
        publicOrigin: 'http://localhost:3201',
      })
    })

    test.afterAll(async () => {
      try {
        await server.stop()
      } finally {
        if (existsSync(dataDir)) {
          rmSync(dataDir, { recursive: true, force: true })
        }
      }
    })

    test('foreign Origin refused (POST and WS)', async () => {
      // POST /api/boards with foreign origin
      const postRes = await fetch('http://127.0.0.1:4201/api/boards', {
        method: 'POST',
        headers: {
          Origin: 'http://evil.test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Evil' }),
      })
      expect(postRes.status).toBe(403)

      // WS connection with foreign origin
      const wsStatus = await new Promise<number>((resolve) => {
        const req = http.request('http://127.0.0.1:4201/ws?boardId=b1', {
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            Origin: 'http://evil.test',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version': '13',
          },
        })
        req.on('response', (res) => resolve(res.statusCode ?? 0))
        req.on('error', () => resolve(0))
        req.end()
      })
      expect(wsStatus).toBe(403)
    })

    test('two tabs sync, concurrent edit converges, restart durability, image sync, server PNG parity', async ({
      context,
    }) => {
      const errors: string[] = []
      context.on('console', (m) => {
        if (
          m.type() === 'error' &&
          !m.text().includes('ERR_CONNECTION_REFUSED')
        ) {
          errors.push(`console: ${m.text()}`)
        }
      })
      context.on('weberror', (e) => errors.push(`uncaught: ${e.error()}`))

      // 1. Two pages in one context are both editable (no lock)
      let pageA = await context.newPage()
      let pageB = await context.newPage()

      await pageA.goto('/')
      await ready(pageA)
      await pageB.goto('/')
      await ready(pageB)

      expect(await alerts(pageA).count()).toBe(0)
      expect(await alerts(pageB).count()).toBe(0)

      // A draws a rectangle, B sees it
      await pageA.keyboard.press('r')
      await drag(pageA, [100, 100], [250, 200])
      await expect.poll(async () => (await elements(pageA)).length).toBe(1)
      await expect.poll(async () => (await elements(pageB)).length).toBe(1)

      const rectA = (await elements(pageA))[0]
      expect(rectA).toBeDefined()
      if (!rectA) throw new Error('missing rect')

      // B moves it, A sees the move
      await pageB.keyboard.press('v')
      await pageB.mouse.click(175, 150)
      await drag(pageB, [175, 150], [225, 150])
      await expect
        .poll(async () => (await elements(pageA))[0]?.x)
        .toBe(rectA.x + 50)
      expect((await elements(pageB))[0]?.x).toBe(rectA.x + 50)

      // Concurrent same-field edit converges
      await Promise.all([
        pageA.evaluate((id) => {
          const ed = (window as unknown as W).__editor
          ed?.commit({
            batchId: 'race-a',
            label: 'Fill A',
            ops: [{ op: 'patch', id, set: { 'style.fill': '#ff0000' } }],
          })
        }, rectA.id),
        pageB.evaluate((id) => {
          const ed = (window as unknown as W).__editor
          ed?.commit({
            batchId: 'race-b',
            label: 'Fill B',
            ops: [{ op: 'patch', id, set: { 'style.fill': '#0000ff' } }],
          })
        }, rectA.id),
      ])

      await expect
        .poll(async () => {
          const fA = (await elements(pageA))[0]?.style?.fill
          const fB = (await elements(pageB))[0]?.style?.fill
          return fA && fB && fA === fB
        })
        .toBe(true)

      // 2. Restart keeps the board
      await server.stop()
      await expect(alerts(pageA)).toContainText(
        'Offline: changes are not saved',
      )

      // Draw while offline
      await pageA.keyboard.press('r')
      await drag(pageA, [300, 100], [450, 200])
      expect((await elements(pageA)).length).toBe(2)

      // Restart server on same dataDir
      server = await startServer({
        dataDir,
        port: 4201,
        publicOrigin: 'http://localhost:3201',
      })
      await expect(alerts(pageA)).toHaveCount(0)
      await expect.poll(async () => (await elements(pageB)).length).toBe(2)

      // Both reload to identical board
      await pageA.reload()
      await ready(pageA)
      await pageB.reload()
      await ready(pageB)

      const elsA = await elements(pageA)
      const elsB = await elements(pageB)
      expect(
        elsA.map(
          ({ v: _v, ...e }) => e as Omit<El, 'v'> & Record<string, unknown>,
        ),
      ).toEqual(
        elsB.map(
          ({ v: _v, ...e }) => e as Omit<El, 'v'> & Record<string, unknown>,
        ),
      )

      // Kill and restart with no client, reload, board is preserved
      await pageA.close()
      await pageB.close()
      await server.stop()
      server = await startServer({
        dataDir,
        port: 4201,
        publicOrigin: 'http://localhost:3201',
      })

      pageA = await context.newPage()
      await pageA.goto('/')
      await ready(pageA)
      expect((await elements(pageA)).length).toBe(2)

      pageB = await context.newPage()
      await pageB.goto('/')
      await ready(pageB)

      // 3. Drop a PNG image in A, B shows it, reload shows it
      await pageA.evaluate(async () => {
        const c = document.createElement('canvas')
        c.width = 120
        c.height = 120
        const g = c.getContext('2d') as CanvasRenderingContext2D
        g.fillStyle = '#1e3a8a'
        g.fillRect(0, 0, 120, 120)
        g.fillStyle = '#ffffff'
        g.fillRect(20, 20, 80, 80)
        const blob = await new Promise<Blob>((res, rej) =>
          c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'),
        )
        const dt = new DataTransfer()
        dt.items.add(new File([blob], 'square.png', { type: 'image/png' }))
        const host = document.querySelector('canvas')
          ?.parentElement as HTMLElement
        host.dispatchEvent(
          new DragEvent('drop', {
            dataTransfer: dt,
            clientX: 550,
            clientY: 200,
          }),
        )
      })

      await expect
        .poll(
          async () =>
            (await elements(pageA)).filter((e) => e.type === 'image').length,
        )
        .toBe(1)
      await expect
        .poll(
          async () =>
            (await elements(pageB)).filter((e) => e.type === 'image').length,
        )
        .toBe(1)

      // Wait for image blob to be decoded in B
      await pageB.waitForFunction(() => {
        const ed = (window as unknown as W).__editor
        const img = [...(ed?.scene.els.values() ?? [])].find(
          (e) => e.type === 'image',
        )
        const blobId = img?.data?.blobId as string | undefined
        return blobId && ed?.platform.images?.peek(blobId)
      })

      await pageB.reload()
      await ready(pageB)
      expect(
        (await elements(pageB)).filter((e) => e.type === 'image').length,
      ).toBe(1)

      // 4. Server PNG vs browser screenshot within 1.5% differing pixels
      // Add Arabic text, Latin text, and a math element to the board
      await typeText(pageA, [100, 300], 'مرحبا')
      await typeText(pageA, [250, 300], 'Hello')
      await typeMath(pageA, [400, 300], 'x^2 + y^2 = z^2')

      // Ink: a pen stroke below the text and a highlight across the Latin word (the camera is still at the origin at zoom 1,
      // so world and screen coordinates agree), so the picture compares freehand and the highlighter's multiply too
      const hello = (await elements(pageA)).find(
        (e) => e.data.text === 'Hello',
      ) as El
      const mid = hello.y + hello.h / 2
      await pageA.keyboard.press('p')
      await stroke(pageA, [
        [100, 400],
        [190, 360],
        [280, 430],
        [370, 370],
        [460, 420],
      ])
      await pageA.keyboard.press('Shift+P')
      await stroke(pageA, [
        [hello.x - 15, mid],
        [hello.x + hello.w / 2, mid + 2],
        [hello.x + hello.w + 15, mid],
      ])
      await pageA.keyboard.press('v')
      // the strokes were drawn at screen coordinates: check the committed boxes landed where meant (the highlight spans the
      // word's width and sits within its height), or the picture would compare ink that marks nothing
      const strokes = (await elements(pageA)).filter(
        (e) => e.type === 'freehand',
      )
      const wave = strokes.find((e) => !e.data.highlighter) as El
      const hl = strokes.find((e) => e.data.highlighter) as El
      expect(strokes).toHaveLength(2)
      expect(hl.x).toBeLessThan(hello.x)
      expect(hl.x + hl.w).toBeGreaterThan(hello.x + hello.w)
      expect(hl.y).toBeLessThan(hello.y + hello.h)
      expect(hl.y + hl.h).toBeGreaterThan(hello.y)

      await expect
        .poll(
          async () =>
            (await elements(pageB)).filter((e) => e.type === 'math').length,
        )
        .toBe(1)
      await expect
        .poll(
          async () =>
            (await elements(pageB)).filter((e) => e.type === 'freehand').length,
        )
        .toBe(2)
      // Settle rendering
      await pageA.waitForTimeout(500)

      const boardInfo = await pageA.evaluate(() => {
        const ed = (window as unknown as W).__editor
        const id = localStorage.getItem('whiteboard:boardId')
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const el of ed?.scene.els.values() ?? []) {
          minX = Math.min(minX, el.x)
          minY = Math.min(minY, el.y)
          maxX = Math.max(maxX, el.x + el.w)
          maxY = Math.max(maxY, el.y + el.h)
        }
        const pad = 24
        return {
          boardId: id,
          rect: {
            x: Math.floor(minX - pad),
            y: Math.floor(minY - pad),
            w: Math.ceil(maxX - minX + 2 * pad),
            h: Math.ceil(maxY - minY + 2 * pad),
          },
        }
      })

      const targetWidth = 800
      const targetHeight = Math.round(
        (targetWidth * boardInfo.rect.h) / boardInfo.rect.w,
      )

      await pageA.setViewportSize({
        width: Math.max(1000, targetWidth + 420), // the board is the viewport minus the tutor dock (up to 380 px)
        height: Math.max(800, targetHeight + 100),
      })

      await pageA.evaluate(
        ({ rect, width }) => {
          const ed = (window as unknown as W).__editor
          if (!ed) return
          ed.selection.clear()
          ed.camera = { x: rect.x, y: rect.y, zoom: width / rect.w }
          ed.invalidate()
        },
        { rect: boardInfo.rect, width: targetWidth },
      )
      await frames(pageA, 5)

      // the top bar floats over the board's top-left corner; the parity check compares the drawing only.
      // display, not visibility: the bar has `transition-all`, which animates visibility for 150 ms, so it was still drawn in the screenshot
      await pageA.addStyleTag({
        content: 'header { display: none !important }',
      })
      const browserScreenshot = await pageA.screenshot({
        clip: { x: 0, y: 0, width: targetWidth, height: targetHeight },
      })

      const exportUrl = `http://127.0.0.1:4201/api/boards/${boardInfo.boardId}/export.png?x=${boardInfo.rect.x}&y=${boardInfo.rect.y}&w=${boardInfo.rect.w}&h=${boardInfo.rect.h}&width=${targetWidth}`
      const exportRes = await fetch(exportUrl)
      expect(exportRes.status).toBe(200)
      const serverExport = Buffer.from(await exportRes.arrayBuffer())

      const diffResult = comparePngBuffers(browserScreenshot, serverExport, 24)
      test.info().annotations.push({
        type: 'parity',
        description: `${(diffResult.ratio * 100).toFixed(3)}% of ${diffResult.total} px differ`,
      })
      if (diffResult.ratio > 0.015) {
        const outDir = resolve(process.cwd(), 'test-results')
        mkdirSync(outDir, { recursive: true })
        writeFileSync(resolve(outDir, 'gate-browser.png'), browserScreenshot)
        writeFileSync(resolve(outDir, 'gate-server.png'), serverExport)
        writeFileSync(
          resolve(outDir, 'gate-diff.png'),
          encodePng(diffResult.w, diffResult.h, diffResult.diffRgba),
        )
      }

      expect(diffResult.ratio).toBeLessThanOrEqual(0.015)

      // The ink is under 1% of that picture, so a server that drew none would still pass it. Compare tight crops of the same
      // pixels of both pictures (same scale, same origin) where the ink is a large share: the wave, and the highlight's two
      // tails (the band beyond the word, no glyphs). Each crop must also be one a blank picture fails, and the server's copy
      // must hold the ink's colour. The band over "Hello" is not compared by ratio (glyph edges differ between Chrome and
      // @napi-rs/canvas by 3% even without ink, as in the Arabic word); instead the glyph cores must stay dark under it,
      // which multiply does and plain alpha (a red channel of about 131) does not.
      const zoom = targetWidth / boardInfo.rect.w
      const PAD = 12 // world units: more than the widest ink reach (the highlighter's 9) plus anti-aliasing
      const px = (x0: number, y0: number, x1: number, y1: number): Box => {
        const x = Math.floor((x0 - boardInfo.rect.x) * zoom)
        const y = Math.floor((y0 - boardInfo.rect.y) * zoom)
        return {
          x,
          y,
          w: Math.ceil((x1 - boardInfo.rect.x) * zoom) - x,
          h: Math.ceil((y1 - boardInfo.rect.y) * zoom) - y,
        }
      }
      const top = hl.y - PAD
      const bottom = hl.y + hl.h + PAD
      const isDark = (r: number, g: number, b: number) =>
        r < 60 && g < 60 && b < 60
      const isYellow = (r: number, g: number, b: number) =>
        r > 230 && g > 215 && g < 250 && b > 100 && b < 190 // #ffd400 at 0.45 on white is (255, 235, 140)
      const regions: [
        string,
        Box,
        (r: number, g: number, b: number) => boolean,
        number,
      ][] = [
        [
          'wave',
          px(
            wave.x - PAD,
            wave.y - PAD,
            wave.x + wave.w + PAD,
            wave.y + wave.h + PAD,
          ),
          isDark,
          400,
        ],
        [
          'highlight left tail',
          px(hl.x - PAD, top, hello.x, bottom),
          isYellow,
          150,
        ],
        [
          'highlight right tail',
          px(hello.x + hello.w, top, hl.x + hl.w + PAD, bottom),
          isYellow,
          150,
        ],
      ]
      for (const [name, r, isInk, least] of regions) {
        const mine = crop(browserScreenshot, r)
        const theirs = crop(serverExport, r)
        const sub = comparePngBuffers(mine.png, theirs.png, 24)
        const blank = comparePngBuffers(
          mine.png,
          encodePng(sub.w, sub.h, new Uint8Array(sub.w * sub.h * 4).fill(255)),
          24,
        ) // what a server that drew nothing would score
        const served = countPixels(theirs.rgba, isInk)
        test.info().annotations.push({
          type: `parity ${name}`,
          description: `${(sub.ratio * 100).toFixed(3)}% of ${sub.total} px differ (a blank picture: ${(blank.ratio * 100).toFixed(1)}%), ${served} ink-coloured px in the server's crop`,
        })
        expect(sub.ratio, name).toBeLessThanOrEqual(0.015)
        expect(blank.ratio, name).toBeGreaterThan(0.015) // a server that drew no ink would fail this crop
        expect(served, name).toBeGreaterThan(least)
      }
      const under = px(hello.x, top, hello.x + hello.w, bottom)
      const darkMine = countPixels(crop(browserScreenshot, under).rgba, isDark)
      const darkServer = countPixels(crop(serverExport, under).rgba, isDark)
      test.info().annotations.push({
        type: 'parity multiply',
        description: `dark glyph-core px under the highlight: ${darkMine} in the browser, ${darkServer} on the server`,
      })
      expect(darkMine).toBeGreaterThan(100) // the glyphs are there to be darkened
      expect(darkServer).toBeGreaterThan(0.6 * darkMine)

      // 5. No console errors on any page
      expect(errors).toEqual([])

      await pageA.close()
      await pageB.close()
    })
  })

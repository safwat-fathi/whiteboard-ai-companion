import { expect, type Page, test } from '@playwright/test'

// M2 acceptance script (ROADMAP M2 gate, plan Task 12): real pointer and keyboard input; `window.__editor` (dev builds)
// is read for assertions, and used only for the camera (zoom sweep, flyTo) where there is no gesture to script.
type El = {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  data: {
    latex?: string
    blobId?: string
    naturalW?: number
    naturalH?: number
    crop?: { x: number; y: number; w: number; h: number }
  }
}
type Ed = {
  getSnapshot(): { elements: El[] }
  camera: { x: number; y: number; zoom: number }
  cacheBytes: number
  cacheCap: number
  readOnly: boolean
  platform: {
    images?: {
      peek(id: string): unknown
      request(id: string, cb: () => void): void
    }
  }
  flyTo(
    target: string[],
    opts?: { duration?: number },
  ): Promise<'done' | 'cancelled'>
  pulse(target: string[]): void
  invalidate(): void
}
type W = { __editor?: Ed }

const ready = (page: Page) =>
  page.waitForFunction(() => (window as unknown as W).__editor)
const elements = (page: Page) =>
  page.evaluate(
    () => (window as unknown as W).__editor?.getSnapshot().elements ?? [],
  )
const btn = (page: Page, name: string) => page.getByRole('button', { name })
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

/** Autosave is debounced: wait until the stored board is what the editor holds, then it is safe to reload. */
const saved = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<boolean>((resolve, reject) => {
            const open = indexedDB.open('whiteboard')
            open.onerror = () => reject(open.error)
            open.onsuccess = () => {
              const db = open.result
              const get = db
                .transaction('boards')
                .objectStore('boards')
                .get('local')
              get.onerror = () => reject(get.error)
              get.onsuccess = () => {
                db.close()
                const snap = (window as unknown as W).__editor?.getSnapshot()
                resolve(
                  !!snap &&
                    !!get.result &&
                    JSON.stringify(get.result.elements) ===
                      JSON.stringify(snap.elements),
                )
              }
            }
          }),
      ),
    )
    .toBe(true)

/** Math tool: click at `at`, type `latex`, return once the live preview has had its say. */
async function typeMath(page: Page, at: [number, number], latex: string) {
  await page.keyboard.press('m')
  await page.mouse.click(...at)
  const box = page.getByLabel('LaTeX')
  await expect(box).toBeFocused()
  await box.fill(latex)
  await expect(page.getByTestId('math-editor')).toBeVisible()
}

test('M2 gate: LaTeX with live preview, hostile input, image drop, crop, zoom, reload, undo, second tab, flyTo', async ({
  page,
  context,
}) => {
  const errors: string[] = []
  const requests: string[] = []
  context.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  context.on('weberror', (e) => errors.push(`uncaught: ${e.error()}`))
  page.on('request', (r) => requests.push(r.url()))

  await page.goto('/')
  await ready(page)
  await expect(btn(page, 'Select')).toBeEnabled()

  // 1. A valid equation: the preview draws, there is no error, Cmd/Ctrl+Enter commits one element.
  await typeMath(page, [200, 160], '\\frac{a}{b} + \\ce{H2O}')
  await expect(page.getByTestId('math-error')).toHaveText('')
  await expect(page.getByTestId('math-preview')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.getByTestId('math-editor')).toHaveCount(0)
  let els = await elements(page)
  expect(els.map((e) => e.type)).toEqual(['math'])
  expect(els[0]?.data.latex).toBe('\\frac{a}{b} + \\ce{H2O}')
  expect(els[0]?.w).toBeGreaterThan(0)
  expect(els[0]?.h).toBeGreaterThan(0)

  // 2. Invalid LaTeX shows MathJax's message live and still commits (the student keeps what they typed).
  await typeMath(page, [200, 360], '\\frac{')
  await expect(page.getByTestId('math-error')).not.toHaveText('')
  await page.keyboard.press('ControlOrMeta+Enter')
  els = await elements(page)
  expect(els.filter((e) => e.type === 'math')).toHaveLength(2)
  expect(els[1]?.data.latex).toBe('\\frac{')

  // 3. Hostile LaTeX is an error, never a link, and causes no request outside this origin.
  await typeMath(page, [700, 80], '\\href{javascript:alert(1)}{x}')
  await expect(page.getByTestId('math-error')).not.toHaveText('')
  await page.keyboard.press('ControlOrMeta+Enter')
  expect(
    await page.evaluate(
      () => document.querySelectorAll('a[href], [xlink\\:href]').length,
    ),
  ).toBe(0)
  const origin = new URL(page.url()).origin
  expect(
    requests.filter(
      (u) =>
        !u.startsWith(origin) &&
        !u.startsWith('data:') &&
        !u.startsWith('blob:'),
    ),
  ).toEqual([])
  expect((await elements(page)).filter((e) => e.type === 'math')).toHaveLength(
    3,
  )

  // 4. Drop a generated 1,200 x 800 PNG with a real DataTransfer on the board.
  await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 1200
    c.height = 800
    const g = c.getContext('2d') as CanvasRenderingContext2D
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 12; x++) {
        g.fillStyle = (x + y) % 2 ? '#ffffff' : '#1e3a8a'
        g.fillRect(x * 100, y * 100, 100, 100)
      }
    const blob = await new Promise<Blob>((res, rej) =>
      c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'),
    )
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'checker.png', { type: 'image/png' }))
    const host = document.querySelector('canvas')?.parentElement as HTMLElement
    host.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: dt,
        clientX: 600,
        clientY: 300, // high enough that the crop handles clear the floating toolbar (y > 636)
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await expect
    .poll(
      async () =>
        (await elements(page)).filter((e) => e.type === 'image').length,
    )
    .toBe(1)
  const img = (await elements(page)).find((e) => e.type === 'image') as El
  expect([img.data.naturalW, img.data.naturalH]).toEqual([1200, 800])

  // 5. Crop to the top-left quarter: double-click the image, drag the bottom-right handle to its centre, Enter.
  const toScreen = async (wx: number, wy: number) =>
    page.evaluate(
      ([x, y]) => {
        const cam = (window as unknown as W).__editor?.camera as Ed['camera']
        const r = document
          .querySelector('canvas')
          ?.getBoundingClientRect() as DOMRect
        return [r.left + (x - cam.x) * cam.zoom, r.top + (y - cam.y) * cam.zoom]
      },
      [wx, wy],
    ) as Promise<[number, number]>
  const [cx, cy] = await toScreen(img.x + img.w / 2, img.y + img.h / 2)
  await page.mouse.dblclick(cx, cy)
  await frames(page)
  const [hx, hy] = await toScreen(img.x + img.w, img.y + img.h) // the bottom-right (se) handle
  await page.mouse.move(hx, hy)
  await page.mouse.down()
  await page.mouse.move(cx, cy, { steps: 8 })
  await page.mouse.up()
  await page.keyboard.press('Enter')
  const cropped = (await elements(page)).find((e) => e.type === 'image') as El
  expect(cropped.data.crop).toBeTruthy()
  expect(cropped.data.crop?.x).toBe(0)
  expect(cropped.data.crop?.y).toBe(0)
  expect(cropped.data.crop?.w).toBeGreaterThan(550)
  expect(cropped.data.crop?.w).toBeLessThan(650)
  expect(cropped.data.crop?.h).toBeGreaterThan(350)
  expect(cropped.data.crop?.h).toBeLessThan(450)

  // 6. Zoom 0.05, 1, 4 and 20: nothing throws and the cache stays inside its cap. (Crispness itself: e2e/crisp.spec.ts.)
  for (const zoom of [0.05, 1, 4, 20]) {
    await page.evaluate((z) => {
      const ed = (window as unknown as W).__editor as Ed
      ed.camera = { x: 0, y: 0, zoom: z }
      ed.invalidate()
    }, zoom)
    await frames(page)
    const { bytes, cap } = await page.evaluate(() => {
      const ed = (window as unknown as W).__editor as Ed
      return { bytes: ed.cacheBytes, cap: ed.cacheCap }
    })
    expect(bytes, `zoom ${zoom}`).toBeLessThanOrEqual(cap)
  }
  await page.evaluate(() => {
    const ed = (window as unknown as W).__editor as Ed
    ed.camera = { x: 0, y: 0, zoom: 1 }
    ed.invalidate()
  })

  // 7. Reload: both kinds are back, and the image bytes are (the blob is in IndexedDB, the bitmap decodes).
  await saved(page)
  const before = await elements(page)
  await page.reload()
  await ready(page)
  await expect(btn(page, 'Select')).toBeEnabled()
  expect(await elements(page)).toEqual(before)
  await expect
    .poll(() =>
      page.evaluate(
        (blobId) =>
          new Promise<boolean>((resolve) => {
            const ed = (window as unknown as W).__editor as Ed
            const images = ed.platform.images
            const probe = () => {
              const e = images?.peek(blobId)
              if (e === undefined) return images?.request(blobId, probe)
              resolve(typeof e === 'object')
            }
            probe()
          }),
        img.data.blobId as string,
      ),
    )
    .toBe(true)

  // 8. Undo three times (crop, image, hostile equation), redo once (the image).
  const count = async () => (await elements(page)).length
  expect(await count()).toBe(4)
  await page.keyboard.press('ControlOrMeta+z')
  expect(
    (await elements(page)).find((e) => e.type === 'image')?.data.crop,
  ).toBeUndefined()
  await page.keyboard.press('ControlOrMeta+z')
  expect(await count()).toBe(3)
  await page.keyboard.press('ControlOrMeta+z')
  expect(await count()).toBe(2)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  expect(await count()).toBe(3)

  // 9. A second tab is read-only and still renders what the board holds.
  await saved(page)
  const second = await context.newPage()
  await second.goto('/')
  await expect(
    second.getByText('Open in another tab (read-only)'),
  ).toBeVisible()
  await ready(second)
  expect((await elements(second)).length).toBe(3)
  expect(
    await second.evaluate(() => (window as unknown as W).__editor?.readOnly),
  ).toBe(true)
  await second.close()

  // 10. flyTo a far element resolves 'done' with the target in view; pulse draws without an error.
  const target = (await elements(page)).find((e) => e.type === 'math') as El
  await page.evaluate(() => {
    const ed = (window as unknown as W).__editor as Ed
    ed.camera = { x: 100000, y: 100000, zoom: 1 }
    ed.invalidate()
  })
  const result = await page.evaluate(
    (id) => (window as unknown as W).__editor?.flyTo([id], { duration: 400 }),
    target.id,
  )
  expect(result).toBe('done')
  const cam = await page.evaluate(
    () => (window as unknown as W).__editor?.camera as Ed['camera'],
  )
  expect(Math.abs(cam.x - target.x)).toBeLessThan(2000)
  await page.evaluate(
    (id) => (window as unknown as W).__editor?.pulse([id]),
    target.id,
  )
  await frames(page, 6)

  expect(errors).toEqual([])
})

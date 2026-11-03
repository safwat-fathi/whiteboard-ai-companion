import { expect, type Page, test } from '@playwright/test'

// M6 ink script: real mouse input only (pointerType 'mouse', no pressure, so the pen uses simulated pressure).
// `window.__editor` (dev builds) is read for assertions, never written.
type El = {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  z: string
  v: number
  style: { stroke: string; strokeWidth: number; opacity: number }
  data: {
    text?: string
    points?: [number, number][]
    pressure?: number[]
    highlighter?: boolean
  }
}
type W = {
  __editor?: {
    getSnapshot(): { elements: El[]; undo: unknown }
    camera: { x: number; y: number; zoom: number }
    host: HTMLElement
  }
}

const ready = (page: Page) =>
  page.waitForFunction(() => (window as unknown as W).__editor)
const elements = (page: Page): Promise<El[]> =>
  page.evaluate(
    () => (window as unknown as W).__editor?.getSnapshot().elements ?? [],
  )
// exact: "Pen" is also a substring of the Next dev overlay's "Open Next.js Dev Tools"
const btn = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true })

/** Autosave is debounced: wait until the stored record (IndexedDB) is the editor's current board and undo history. */
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
                const rec = get.result
                resolve(
                  !!snap &&
                    !!rec &&
                    JSON.stringify(rec.elements) ===
                      JSON.stringify(snap.elements) &&
                    JSON.stringify(rec.undo) === JSON.stringify(snap.undo),
                )
              }
            }
          }),
      ),
    )
    .toBe(true)

/** True when the overlay canvas (the live stroke preview) holds any painted pixel. */
const overlayInked = (page: Page) =>
  page.evaluate(() => {
    const c = (window as unknown as W).__editor?.host.querySelectorAll(
      'canvas',
    )[1] as HTMLCanvasElement
    const { data } = (
      c.getContext('2d') as CanvasRenderingContext2D
    ).getImageData(0, 0, c.width, c.height)
    for (let i = 3; i < data.length; i += 4) if (data[i]) return true
    return false
  })

/** Screen position of a world point under the editor's current camera. */
const screen = (page: Page, p: { x: number; y: number }) =>
  page.evaluate(({ x, y }) => {
    const ed = (window as unknown as W).__editor
    if (!ed) throw new Error('no editor')
    const r = ed.host.getBoundingClientRect()
    const { camera: c } = ed
    return [r.left + (x - c.x) * c.zoom, r.top + (y - c.y) * c.zoom] as [
      number,
      number,
    ]
  }, p)

/** Press, drag through `pts` (each leg in 4 mouse moves), release. Calls `held` while the button is down. */
async function stroke(
  page: Page,
  pts: [number, number][],
  held?: () => Promise<void>,
) {
  const [first, ...rest] = pts as [[number, number], ...[number, number][]]
  await page.mouse.move(...first)
  await page.mouse.down()
  for (const p of rest) await page.mouse.move(...p, { steps: 4 })
  await held?.()
  await page.mouse.up()
}

async function typeText(page: Page, at: [number, number], text: string) {
  await page.keyboard.press('t')
  await page.mouse.click(...at)
  await expect(page.locator('textarea')).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Escape') // commits
  await expect(page.locator('textarea')).toHaveCount(0)
}

test('M6 ink: draw, undo, redo, reload, highlight over text, erase, reload, second tab read-only', async ({
  page,
  context,
}) => {
  const errors: string[] = []
  context.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  context.on('weberror', (e) => errors.push(`uncaught: ${e.error()}`))

  await page.goto('/')
  await ready(page)
  await expect(btn(page, 'Pen')).toBeEnabled() // the toolbar is live once the board has loaded

  // 1. Pen by key: a wave, drawn live on the overlay and committed as one freehand on release.
  await page.keyboard.press('p')
  await expect(btn(page, 'Pen')).toHaveAttribute('aria-pressed', 'true')
  await stroke(
    page,
    [
      [200, 200],
      [260, 160],
      [320, 240],
      [380, 170],
      [440, 230],
      [500, 190],
    ],
    async () => {
      expect(await elements(page)).toHaveLength(0) // nothing is committed while the button is down
      await expect.poll(() => overlayInked(page)).toBe(true)
    },
  )
  await expect.poll(() => overlayInked(page)).toBe(false)
  const [pen] = await elements(page)
  expect(await elements(page)).toHaveLength(1)
  expect(pen?.type).toBe('freehand')
  expect(pen?.data.highlighter).toBe(false)
  expect(pen?.data.pressure).toBeUndefined() // a mouse reports no pressure: simulated
  expect(pen?.data.points?.length).toBeGreaterThan(2)
  expect(pen?.style).toMatchObject({ stroke: '#1e1e1e', strokeWidth: 3 })
  expect(pen?.w).toBeGreaterThan(250) // the box is the stroke's tight box
  await expect(btn(page, 'Pen')).toHaveAttribute('aria-pressed', 'true') // the tool stays active for the next stroke

  // 2. Undo removes it, redo brings back the same element.
  await page.keyboard.press('ControlOrMeta+z')
  expect(await elements(page)).toHaveLength(0)
  await btn(page, 'Redo').click()
  expect(await elements(page)).toEqual([pen])

  // 3. Reload: the stroke persists, byte for byte.
  await saved(page)
  await page.reload()
  await ready(page)
  await expect.poll(() => elements(page)).toEqual([pen])

  // 4. Latin text, then a highlight over it from the toolbar's shortcut (Shift+P); the stroke runs past the text on both sides.
  await typeText(page, [200, 400], 'Hello ink')
  const text = (await elements(page)).find((e) => e.type === 'text') as El
  expect(text.data.text).toBe('Hello ink')
  await page.keyboard.press('Shift+P')
  await expect(btn(page, 'Highlighter')).toHaveAttribute('aria-pressed', 'true')
  await expect(btn(page, 'Pen')).toHaveAttribute('aria-pressed', 'false')
  const midY = text.y + text.h / 2
  await stroke(page, [
    await screen(page, { x: text.x - 40, y: midY }),
    await screen(page, { x: text.x + text.w / 2, y: midY + 2 }),
    await screen(page, { x: text.x + text.w + 20, y: midY }),
  ])
  const after = await elements(page)
  expect(after.map((e) => e.type)).toEqual(['freehand', 'text', 'freehand'])
  const hl = after[2] as El
  expect(hl.data.highlighter).toBe(true)
  expect(hl.style).toMatchObject({
    stroke: '#ffd400',
    strokeWidth: 18,
    opacity: 0.45,
  })
  expect(hl.z > text.z).toBe(true) // above the text it marks
  expect(hl.x).toBeLessThan(text.x)
  expect(hl.x + hl.w).toBeGreaterThan(text.x + text.w)
  expect(after[1]).toEqual(text) // the text is untouched

  // 5. Erase it: a short drag across the highlight's left tail, clear of the text box, removes only the highlight.
  await page.keyboard.press('e')
  await expect(btn(page, 'Eraser')).toHaveAttribute('aria-pressed', 'true')
  const tailX = text.x - 28
  expect(tailX).toBeGreaterThan(hl.x + 3)
  await stroke(page, [
    await screen(page, { x: tailX, y: midY - 25 }),
    await screen(page, { x: tailX, y: midY + 25 }),
  ])
  await expect.poll(async () => (await elements(page)).length).toBe(2)
  const kept = await elements(page)
  expect(kept.map((e) => e.id)).toEqual([pen?.id, text.id])
  expect(kept).toEqual([pen, text])

  // 6. Reload: the erase persisted too.
  await saved(page)
  await page.reload()
  await ready(page)
  await expect.poll(() => elements(page)).toEqual([pen, text])

  // 7. A second tab in the same browser opens read-only: it cannot draw, and the first tab's board stays as it was.
  const second = await context.newPage()
  await second.goto('/')
  await expect(
    second.getByText('Open in another tab (read-only)'),
  ).toBeVisible()
  await expect(btn(second, 'Pen')).toBeDisabled()
  await ready(second)
  await second.keyboard.press('p')
  await stroke(second, [
    [250, 500],
    [350, 540],
    [450, 500],
  ])
  expect(
    (await elements(second)).filter((e) => e.type === 'freehand'),
  ).toHaveLength(1)
  expect(await elements(page)).toEqual([pen, text])
  await expect(page.getByText('Open in another tab')).toHaveCount(0)

  expect(errors).toEqual([])
})

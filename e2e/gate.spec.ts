import { expect, type Page, test } from '@playwright/test'

// M1 acceptance script: real pointer and keyboard input only. `window.__editor` (dev builds) is read for assertions, never written.
type El = {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  data: {
    kind?: string
    text?: string
    points?: [number, number][]
    start?: { id: string; fx: number; fy: number }
    end?: { id: string; fx: number; fy: number }
  }
}
type W = {
  __editor?: {
    getSnapshot(): { elements: El[]; undo: unknown }
  }
}

const ready = (page: Page) =>
  page.waitForFunction(() => (window as unknown as W).__editor)
const elements = (page: Page) =>
  page.evaluate(
    () => (window as unknown as W).__editor?.getSnapshot().elements ?? [],
  )
const btn = (page: Page, name: string) => page.getByRole('button', { name })

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

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from)
  await page.mouse.down()
  await page.mouse.move(...to, { steps: 8 })
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

/** World position of an arrow end, as the editor stored it. */
const tip = (arrow: El, end: 'start' | 'end'): [number, number] => {
  const p = arrow.data.points ?? []
  const [x, y] = (end === 'start' ? p[0] : p.at(-1)) ?? [Number.NaN, 0]
  return [arrow.x + x, arrow.y + y]
}

test('M1 gate: draw, bind, type Arabic and Latin, undo, reload, second tab', async ({
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
  await expect(btn(page, 'Rectangle')).toBeEnabled() // the toolbar is live once the board has loaded

  // Two shapes: a rectangle by key, an ellipse from the toolbar.
  await page.keyboard.press('r')
  await expect(btn(page, 'Rectangle')).toHaveAttribute('aria-pressed', 'true')
  await drag(page, [150, 150], [310, 250])
  await expect(btn(page, 'Select')).toHaveAttribute('aria-pressed', 'true') // the shape tool hands over to select
  await btn(page, 'Ellipse').click()
  await expect(btn(page, 'Ellipse')).toHaveAttribute('aria-pressed', 'true')
  expect(
    await page.evaluate(() => document.activeElement === document.body),
  ).toBe(true) // the toolbar does not take focus
  await drag(page, [600, 150], [760, 250])
  const [rect, ellipse] = await elements(page)
  expect([rect?.data.kind, ellipse?.data.kind]).toEqual(['rect', 'ellipse'])

  // An arrow from inside the rectangle to inside the ellipse binds both ends.
  await btn(page, 'Arrow').click()
  await drag(page, [280, 200], [680, 200])
  const arrow0 = (await elements(page)).find((e) => e.data.kind === 'arrow')
  expect(arrow0?.data.start?.id).toBe(rect?.id)
  expect(arrow0?.data.end?.id).toBe(ellipse?.id)

  // Arabic, then Latin.
  await typeText(page, [200, 450], 'مرحبا بالعالم')
  await typeText(page, [700, 450], 'Hello world')
  expect(
    (await elements(page))
      .filter((e) => e.type === 'text')
      .map((e) => e.data.text),
  ).toEqual(['مرحبا بالعالم', 'Hello world'])

  // Move the rectangle: the arrow's bound end follows, the other end stays.
  await page.keyboard.press('v')
  await drag(page, [170, 235], [170, 335])
  const moved = await elements(page)
  const rect1 = moved.find((e) => e.id === rect?.id) as El
  const arrow1 = moved.find((e) => e.data.kind === 'arrow') as El
  expect(rect1.y - (rect?.y ?? 0)).toBeCloseTo(100, 5)
  const s = arrow1.data.start as NonNullable<El['data']['start']>
  const [sx, sy] = tip(arrow1, 'start')
  expect(sx).toBeCloseTo(rect1.x + s.fx * rect1.w, 5)
  expect(sy).toBeCloseTo(rect1.y + s.fy * rect1.h, 5)
  expect(sy - tip(arrow0 as El, 'start')[1]).toBeCloseTo(100, 5)
  const [ex0, ey0] = tip(arrow0 as El, 'end')
  const [ex1, ey1] = tip(arrow1, 'end')
  expect(ex1).toBeCloseTo(ex0, 5)
  expect(ey1).toBeCloseTo(ey0, 5)
  expect(arrow1.data.start?.id).toBe(rect?.id)
  expect(arrow1.data.end?.id).toBe(ellipse?.id)

  // Undo twice (toolbar, then the shortcut), redo once (toolbar).
  await btn(page, 'Undo').click() // the move
  expect((await elements(page)).find((e) => e.id === rect?.id)?.y).toBe(rect?.y)
  await page.keyboard.press('ControlOrMeta+z') // the Latin text
  expect(await elements(page)).toHaveLength(4)
  await btn(page, 'Redo').click()
  const before = await elements(page)
  expect(before).toHaveLength(5)

  // Reload: the saved scene, with its history, comes back.
  await saved(page)
  await page.reload()
  await ready(page)
  await expect.poll(() => elements(page)).toEqual(before)
  const after = await elements(page)
  expect(after.map((e) => e.data.text).filter(Boolean)).toEqual([
    'مرحبا بالعالم',
    'Hello world',
  ])
  const arrow2 = after.find((e) => e.data.kind === 'arrow')
  expect([arrow2?.data.start?.id, arrow2?.data.end?.id]).toEqual([
    rect?.id,
    ellipse?.id,
  ])
  await btn(page, 'Undo').click()
  expect(await elements(page)).toHaveLength(4)

  // A second tab in the same browser opens read-only.
  await saved(page)
  const second = await context.newPage()
  await second.goto('/')
  await expect(
    second.getByText('Open in another tab (read-only)'),
  ).toBeVisible()
  await expect(btn(second, 'Rectangle')).toBeDisabled()
  await expect(page.getByText('Open in another tab')).toHaveCount(0)

  expect(errors).toEqual([])
})

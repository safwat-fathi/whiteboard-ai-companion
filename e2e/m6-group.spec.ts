import { expect, type Page, test } from '@playwright/test'

// M6 group, resize and snap with real pointer and keyboard input. `window.__editor` (dev builds) is read, never written.
type El = {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  parentId?: string
}
type W = {
  __editor?: {
    getSnapshot(): { elements: El[]; undo: unknown }
    selection: Set<string>
  }
}
const ready = (page: Page) =>
  page.waitForFunction(() => (window as unknown as W).__editor)
const elements = (page: Page): Promise<El[]> =>
  page.evaluate(
    () => (window as unknown as W).__editor?.getSnapshot().elements ?? [],
  )
const selected = (page: Page) =>
  page.evaluate(() =>
    [...((window as unknown as W).__editor?.selection ?? [])].sort(),
  )
const rects = async (page: Page) =>
  (await elements(page))
    .filter((e) => e.type === 'shape')
    .sort((a, b) => a.x - b.x)
const btn = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true })

async function drag(
  page: Page,
  from: [number, number],
  to: [number, number],
  opts: { alt?: boolean } = {},
) {
  await page.mouse.move(...from)
  if (opts.alt) await page.keyboard.down('Alt')
  await page.mouse.down()
  await page.mouse.move(...to, { steps: 8 })
  await page.mouse.up()
  if (opts.alt) await page.keyboard.up('Alt')
}
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
              get.onerror = () => reject(get.error)
            }
          }),
      ),
    )
    .toBe(true)

test('M6 group: Ctrl+G, select as one, move, resize, snap, Alt, ungroup, reload', async ({
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
  await expect(btn(page, 'Rectangle')).toBeEnabled()

  // two rectangles, far enough apart that nothing snaps while drawing them
  await page.keyboard.press('r')
  await drag(page, [150, 150], [250, 210])
  await page.keyboard.press('r')
  await drag(page, [400, 150], [500, 210])
  await page.keyboard.press('v')
  expect(await rects(page)).toHaveLength(2)

  // marquee both, Ctrl+G: one group, the selection stays the two
  await drag(page, [100, 100], [550, 260])
  expect(await selected(page)).toHaveLength(2)
  await page.keyboard.press('ControlOrMeta+g')
  const els = await elements(page)
  const group = els.find((e) => e.type === 'group') as El
  expect(group).toBeDefined()
  expect((await rects(page)).every((r) => r.parentId === group.id)).toBe(true)

  // click empty clears; click one member selects both
  await page.mouse.click(60, 600)
  expect(await selected(page)).toHaveLength(0)
  await page.mouse.click(200, 180)
  expect(await selected(page)).toHaveLength(2)

  // drag a member: both move together (a drag far from anything else, so no snap)
  const before = await rects(page)
  await drag(page, [200, 180], [230, 330])
  const moved = await rects(page)
  expect(moved.map((r) => r.y - (before[0] as El).y)).toEqual([150, 150])
  expect(moved[1]?.x).toBe((before[1]?.x as number) + 30)

  // resize the pair by its corner handle: both scale together, one undo takes it back
  const box = {
    x: moved[0]?.x as number,
    y: moved[0]?.y as number,
    r: (moved[1]?.x as number) + (moved[1]?.w as number),
    b: (moved[1]?.y as number) + (moved[1]?.h as number),
  }
  await drag(page, [box.r, box.b], [box.r + (box.r - box.x), box.b + 60])
  const grown = await rects(page)
  expect((grown[1]?.w as number) / (moved[1]?.w as number)).toBeCloseTo(2, 0)
  await page.keyboard.press('ControlOrMeta+z')
  expect((await rects(page))[1]?.w).toBe(moved[1]?.w)

  const first = (await rects(page))[0] as El
  // snap: a third rectangle dragged to 4 px from the first one's left edge lands on it, Alt leaves it at 4
  await page.keyboard.press('r')
  await drag(page, [100, 550], [160, 590])
  await page.keyboard.press('v')
  const third = (await rects(page)).find((r) => r.y > 500) as El
  const dx = first.x + 4 - third.x
  await drag(
    page,
    [third.x + 10, third.y + 10],
    [third.x + 10 + dx, third.y + 10],
  )
  expect((await elements(page)).find((e) => e.id === third.id)?.x).toBe(first.x)
  await drag(
    page,
    [first.x + 10, third.y + 10],
    [first.x + 10 + 4, third.y + 10],
    { alt: true },
  )
  expect((await elements(page)).find((e) => e.id === third.id)?.x).toBe(
    first.x + 4,
  )

  // it survives a reload; Ctrl+Shift+G ungroups
  await saved(page)
  await page.reload()
  await ready(page)
  expect((await elements(page)).some((e) => e.type === 'group')).toBe(true)
  await btn(page, 'Select').click()
  await page.mouse.click(first.x + 10, first.y + 20)
  expect((await selected(page)).length).toBe(2)
  await page.keyboard.press('ControlOrMeta+Shift+g')
  expect((await elements(page)).some((e) => e.type === 'group')).toBe(false)
  expect(errors).toEqual([])
})

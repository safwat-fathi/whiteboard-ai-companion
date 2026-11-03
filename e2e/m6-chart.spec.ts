import { expect, type Page, test } from '@playwright/test'

// M6 chart script: the C tool, a click, the data grid, Apply, the picture, undo, reload, double-click to reopen.
// Real pointer and keyboard input; `window.__editor` (dev builds) is read for assertions, never written.
type El = {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  data: {
    kind?: string
    title?: string
    categories?: string[]
    series?: { name: string; values: number[] }[]
  }
}
type W = {
  __editor?: {
    getSnapshot(): { elements: El[]; undo: unknown }
    host: HTMLElement
  }
}

const ready = (page: Page) =>
  page.waitForFunction(() => (window as unknown as W).__editor)
const elements = (page: Page): Promise<El[]> =>
  page.evaluate(
    () => (window as unknown as W).__editor?.getSnapshot().elements ?? [],
  )
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

/** How many pixels of the scene canvas are close to the first palette colour (#0072b2), the bars of series 1. */
const bluePixels = (page: Page) =>
  page.evaluate(() => {
    const c = (window as unknown as W).__editor?.host.querySelectorAll(
      'canvas',
    )[0] as HTMLCanvasElement
    const { data } = (
      c.getContext('2d') as CanvasRenderingContext2D
    ).getImageData(0, 0, c.width, c.height)
    let n = 0
    for (let i = 0; i < data.length; i += 4)
      if (
        Math.abs((data[i] as number) - 0) < 12 &&
        Math.abs((data[i + 1] as number) - 114) < 12 &&
        Math.abs((data[i + 2] as number) - 178) < 12
      )
        n++
    return n
  })

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Edit chart' })

test('M6 chart: add with C, edit the data grid, draw, undo, reload, reopen by double-click', async ({
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
  await expect(btn(page, 'Chart')).toBeEnabled()

  // 1. C then a click: one default bar chart centred on the click, its grid open, nothing blue yet needs the grid closed
  await page.keyboard.press('c')
  await expect(btn(page, 'Chart')).toHaveAttribute('aria-pressed', 'true')
  await page.mouse.click(520, 360)
  await expect(dialog(page)).toBeVisible()
  const [added] = await elements(page)
  expect(added?.type).toBe('chart')
  expect(added?.data).toMatchObject({
    kind: 'bar',
    categories: ['A', 'B', 'C'],
    series: [{ name: 'Series 1', values: [3, 5, 2] }],
  })
  expect(added?.w).toBe(480)
  expect(added?.h).toBe(320)
  await expect(btn(page, 'Select')).toHaveAttribute('aria-pressed', 'true')

  // 2. a non-number is refused where it is typed; a good edit applies in one step
  await dialog(page).getByLabel('Row 2 Series 1', { exact: true }).fill('abc')
  await dialog(page).getByRole('button', { name: 'Apply' }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('not a number')
  await dialog(page).getByLabel('Row 2 Series 1', { exact: true }).fill('9')
  await dialog(page).getByLabel('Title').fill('Sales')
  await dialog(page).getByRole('button', { name: 'Apply' }).click()
  await expect(dialog(page)).toHaveCount(0)
  const [edited] = await elements(page)
  expect(edited?.data).toMatchObject({
    title: 'Sales',
    series: [{ name: 'Series 1', values: [3, 9, 2] }],
  })
  await expect.poll(() => bluePixels(page)).toBeGreaterThan(2000) // the bars are on the canvas

  // 3. undo takes the edit back in one step (the chart stays), redo brings it again
  await page.keyboard.press('ControlOrMeta+z')
  const [undone] = await elements(page)
  expect(undone?.data.title).toBeUndefined()
  expect(undone?.data.series?.[0]?.values).toEqual([3, 5, 2])
  await page.keyboard.press('ControlOrMeta+Shift+z')
  expect((await elements(page))[0]?.data.title).toBe('Sales')

  // 4. it survives a reload
  await saved(page)
  await page.reload()
  await ready(page)
  await expect(btn(page, 'Chart')).toBeEnabled()
  const [again] = await elements(page)
  expect(again?.data).toMatchObject({
    title: 'Sales',
    series: [{ name: 'Series 1', values: [3, 9, 2] }],
  })
  await expect.poll(() => bluePixels(page)).toBeGreaterThan(2000)

  // 5. with the Select tool (a reload starts on Hand) a double-click reopens the grid; Escape closes it without a change
  await btn(page, 'Select').click()
  await page.mouse.dblclick(520, 360)
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByLabel('Title')).toHaveValue('Sales')
  await dialog(page).getByLabel('Title').press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  expect((await elements(page))[0]?.data.title).toBe('Sales')

  expect(errors).toEqual([])
})

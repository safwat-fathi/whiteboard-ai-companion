import { expect, type Page, test } from '@playwright/test'

type W = {
  __editor?: {
    scene: { els: Map<string, unknown> }
    commit(b: unknown): void
    undoOnce(): void
    getSnapshot(): { elements: unknown[] }
  }
}
const ready = (page: Page) =>
  page.waitForFunction(() => (window as unknown as W).__editor)
const elements = (page: Page) =>
  page.evaluate(
    () => (window as unknown as W).__editor?.getSnapshot().elements ?? [],
  )

// Each test gets a fresh browser context, so IndexedDB and locks start empty.
test('drawing survives a reload and undo still works', async ({ page }) => {
  await page.goto('/')
  await ready(page)
  await page.keyboard.press('r')
  await page.mouse.move(200, 200)
  await page.mouse.down()
  await page.mouse.move(300, 280, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.press('r')
  await page.mouse.move(400, 300)
  await page.mouse.down()
  await page.mouse.move(480, 380, { steps: 5 })
  await page.mouse.up()
  const before = await elements(page)
  expect(before).toHaveLength(2)

  await page.waitForTimeout(350) // commit debounce is 200 ms; a write started in pagehide is best-effort only
  await page.reload()
  await ready(page)
  await expect.poll(() => elements(page)).toEqual(before)
  await page.evaluate(() => (window as unknown as W).__editor?.undoOnce())
  expect(await elements(page)).toHaveLength(1)
})

test('a second tab opens read-only', async ({ page, context }) => {
  await page.goto('/')
  await ready(page)
  const second = await context.newPage()
  await second.goto('/')
  await expect(
    second.getByText('Open in another tab (read-only)'),
  ).toBeVisible()
  await expect(page.getByText('Open in another tab')).toHaveCount(0)
})

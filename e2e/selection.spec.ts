import { expect, type Page, test } from '@playwright/test'

type W = { __editor?: { selection: Set<string> } }

const selected = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__editor?.selection.size)

/** Largest alpha in a 7x7 CSS px window of the overlay canvas: non-zero means something is drawn there. */
const overlayInk = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([cx, cy]) => {
      const c = document.querySelectorAll('canvas')[1] as HTMLCanvasElement
      const s = c.width / c.clientWidth
      const px = c
        .getContext('2d')
        ?.getImageData(
          Math.round(((cx ?? 0) - 3) * s),
          Math.round(((cy ?? 0) - 3) * s),
          Math.round(7 * s),
          Math.round(7 * s),
        ).data
      return px ? Math.max(...px.filter((_, i) => i % 4 === 3)) : 0
    },
    [x, y],
  )

test('hovering an element shows the pointer cursor and a highlight; clicking selects it', async ({
  page,
}) => {
  await page.goto('/')
  await page.waitForFunction(() => (window as unknown as W).__editor)
  const board = page.locator('canvas').nth(1)

  // A rectangle by real input; the shape tool hands over to select with the new shape selected.
  await page.keyboard.press('r')
  await page.mouse.move(200, 200)
  await page.mouse.down()
  await page.mouse.move(400, 320, { steps: 8 })
  await page.mouse.up()
  expect(await selected(page)).toBe(1)
  await page.keyboard.press('Escape')
  expect(await selected(page)).toBe(0)

  // Hover: pointer cursor and a highlight just outside the left edge (x=200, highlight about 5 px out).
  await expect(board).toHaveCSS('cursor', 'auto')
  await page.mouse.move(300, 260)
  await expect(board).toHaveCSS('cursor', 'pointer')
  await expect.poll(() => overlayInk(page, 195, 260)).toBeGreaterThan(0)
  expect(await selected(page)).toBe(0) // hover never selects

  // Leaving clears it.
  await page.mouse.move(700, 500)
  await expect(board).toHaveCSS('cursor', 'auto')
  await expect.poll(() => overlayInk(page, 195, 260)).toBe(0)

  // Click selects: a solid highlight at the same place.
  await page.mouse.click(300, 260)
  expect(await selected(page)).toBe(1)
  await expect.poll(() => overlayInk(page, 195, 260)).toBeGreaterThan(200)

  // Clicking empty space deselects.
  await page.mouse.click(700, 500)
  expect(await selected(page)).toBe(0)
  await expect.poll(() => overlayInk(page, 195, 260)).toBe(0)
})

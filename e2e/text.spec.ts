import { expect, type Page, test } from '@playwright/test'

type W = {
  __editor?: {
    scene: { els: Map<string, { type: string; data: { text?: string } }> }
  }
}
const texts = (page: Page) =>
  page.evaluate(() =>
    [...((window as unknown as W).__editor?.scene.els.values() ?? [])]
      .filter((e) => e.type === 'text')
      .map((e) => e.data.text),
  )

/** The texts in the stored IndexedDB record (what a reload would load). */
const storedTexts = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<(string | undefined)[]>((resolve, reject) => {
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
            const els: { type: string; data: { text?: string } }[] =
              get.result?.elements ?? []
            resolve(
              els.filter((e) => e.type === 'text').map((e) => e.data.text),
            )
          }
        }
      }),
  )

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => (window as unknown as W).__editor)
  await page.keyboard.press('t')
  await page.mouse.click(300, 200)
  await expect(page.locator('textarea')).toBeFocused()
})

test('Arabic then Latin is committed in logical order', async ({ page }) => {
  await page.keyboard.type('مرحبا')
  await expect(page.locator('textarea')).toHaveAttribute('dir', 'rtl')
  await page.keyboard.type(' hello')
  expect(await texts(page)).toEqual([])
  await page.keyboard.press('Escape')
  expect(await texts(page)).toEqual(['مرحبا hello'])
  await expect(page.locator('textarea')).toHaveCount(0)
})

test('IME composition is not committed until it ends', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', {
    text: 'مر',
    selectionStart: 2,
    selectionEnd: 2,
  })
  await page.keyboard.press('Escape') // while composing, Esc cancels the IME, not the edit
  await expect(page.locator('textarea')).toHaveCount(1)
  expect(await texts(page)).toEqual([])
  await cdp.send('Input.insertText', { text: 'مرحبا' })
  expect(await texts(page)).toEqual([])
  await page.waitForTimeout(50) // compositionend grace tick
  await page.keyboard.press('Escape')
  expect(await texts(page)).toEqual(['مرحبا'])
})

test('typed text survives a reload with no Esc or blur', async ({ page }) => {
  await page.keyboard.type('مرحبا بالعالم')
  expect(await texts(page)).toEqual([]) // still a draft: the scene is untouched
  await expect.poll(() => storedTexts(page)).toEqual(['مرحبا بالعالم']) // the 200 ms autosave wrote the draft
  await page.reload()
  await page.waitForFunction(() => (window as unknown as W).__editor)
  await expect.poll(() => texts(page)).toEqual(['مرحبا بالعالم'])
  await expect(page.locator('textarea')).toHaveCount(0)
})

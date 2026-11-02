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

/** Writes `value` under the board key (the page has created the database by the time it is ready). */
const seed = (page: Page, value: unknown) =>
  page.evaluate(
    (v) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('whiteboard', 1)
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction('boards', 'readwrite')
          tx.objectStore('boards').put(v, 'local')
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      }),
    value,
  )
const storedKeys = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('whiteboard', 1)
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const req = db
            .transaction('boards')
            .objectStore('boards')
            .getAllKeys()
          req.onerror = () => reject(req.error)
          req.onsuccess = () => {
            db.close()
            resolve(req.result as string[])
          }
        }
      }),
  )

const GOOD = {
  id: 'a',
  type: 'shape',
  x: 100,
  y: 100,
  w: 80,
  h: 60,
  rotation: 0,
  z: 'a0',
  style: {
    stroke: '#111111',
    fill: null,
    strokeWidth: 2,
    opacity: 1,
    dash: 'solid',
  },
  locked: false,
  author: { kind: 'human', id: 'local' },
  v: 0,
  data: { kind: 'rect' },
}

test('a board from a newer version says plainly that changes are not saved', async ({
  page,
}) => {
  await page.goto('/')
  await ready(page)
  const stored = { version: 99, boardId: 'local', elements: [] }
  await seed(page, stored)
  await page.reload()
  await ready(page)
  const note = page.getByRole('alert').filter({ hasText: 'newer version' })
  await expect(note).toContainText('Changes are NOT being saved')
  await expect(
    note.getByRole('button', { name: 'Start empty and keep a backup copy' }),
  ).toBeVisible()
  await page.keyboard.press('r')
  await page.mouse.move(200, 200)
  await page.mouse.down()
  await page.mouse.move(300, 280, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(400) // past the 200 ms debounce: still nothing written
  expect(await storedKeys(page)).toEqual(['local'])
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const open = indexedDB.open('whiteboard', 1)
          open.onsuccess = () => {
            const req = open.result
              .transaction('boards')
              .objectStore('boards')
              .get('local')
            req.onsuccess = () => resolve(req.result)
          }
        }),
    ),
  ).toEqual(stored)
})

test('invalid elements are dropped with a notice and the stored board is kept as a backup', async ({
  page,
}) => {
  await page.goto('/')
  await ready(page)
  const stored = {
    version: 1,
    boardId: 'local',
    savedAt: 4242,
    elements: [GOOD, { id: 'broken' }],
    camera: { x: 0, y: 0, zoom: 1 },
    undo: { undo: [], redo: [], maxDepth: 200 },
  }
  await seed(page, stored)
  await page.reload()
  await ready(page)
  await expect(
    page.getByRole('status').filter({ hasText: '1 invalid elements' }),
  ).toContainText('backup')
  expect(await elements(page)).toHaveLength(1)
  const keys = await storedKeys(page)
  expect(keys.filter((k) => k.startsWith('local:backup:4242-'))).toHaveLength(1)
})

test('unavailable storage says changes are not saved and offers Retry', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      value: undefined,
      configurable: true,
    })
  })
  await page.goto('/')
  await ready(page)
  const note = page.getByRole('alert').filter({ hasText: 'storage' })
  await expect(note).toContainText(
    'Browser storage is unavailable. Changes are NOT being saved.',
  )
  const retry = note.getByRole('button', { name: 'Retry' })
  await Promise.all([page.waitForEvent('load'), retry.click()]) // Retry reloads the page
  await expect(
    page.getByRole('alert').filter({ hasText: 'storage' }),
  ).toBeVisible()
})

test('a malformed stored undo entry is dropped with a notice; the board and the good history load', async ({
  page,
}) => {
  await page.goto('/')
  await ready(page)
  const entry = {
    original: {
      batchId: 'o',
      label: 'Move',
      ops: [{ op: 'patch', id: 'a', set: { x: 100 } }],
    },
    inverse: {
      batchId: 'i',
      label: 'Undo Move',
      ops: [{ op: 'patch', id: 'a', set: { x: 60 } }],
    },
  }
  await seed(page, {
    version: 1,
    boardId: 'local',
    savedAt: 99,
    elements: [{ ...GOOD, x: 100 }],
    camera: { x: 0, y: 0, zoom: 1 },
    undo: { undo: [entry, { original: 1 }], redo: [], maxDepth: 200 },
  })
  await page.reload()
  await ready(page)
  await expect(
    page.getByRole('status').filter({ hasText: 'undo history' }),
  ).toContainText('backup')
  await page.keyboard.press('ControlOrMeta+z')
  expect(((await elements(page)) as { x: number }[])[0]?.x).toBe(60)
})

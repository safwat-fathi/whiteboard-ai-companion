import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { type RunningServer, startServer } from './helpers/server'

// M5 "Jump to AI" script (docs/plans/jump-to-ai.md "Tests"): AI work far from view with Follow off (arrow, Jump, Back),
// Follow on (the camera follows; the student taking the canvas turns it off), the past (reload, Activity tab, a moved or
// deleted element), the hover tag, deep links. The server runs with TUTOR_STUB=1 (scripted model).
const API = 'http://localhost:4201'
const WEB = 'http://localhost:3201'

test.describe.configure({ mode: 'serial' })

type El = {
  id: string
  x: number
  y: number
  w: number
  h: number
  author: { kind: string }
}
type W = {
  __editor?: {
    readOnly: boolean
    camera: { x: number; y: number; zoom: number }
    viewport: { width: number; height: number }
    commit(batch: unknown): void
    getSnapshot(): { elements: El[] }
    worldToClient(p: { x: number; y: number }): { x: number; y: number }
  }
}
const ready = (page: Page) =>
  page.waitForFunction(() => {
    const ed = (window as unknown as W).__editor
    return !!ed && !ed.readOnly
  })
const centre = (page: Page) =>
  page.evaluate(() => {
    const ed = (window as unknown as W).__editor as NonNullable<W['__editor']>
    return {
      x: ed.camera.x + ed.viewport.width / 2 / ed.camera.zoom,
      y: ed.camera.y + ed.viewport.height / 2 / ed.camera.zoom,
    }
  })
const aiEls = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as W).__editor
        ?.getSnapshot()
        .elements.filter((e) => e.author.kind === 'agent') ?? [],
  )
const near = async (page: Page, x: number, y: number, within = 700) =>
  expect
    .poll(async () => {
      const c = await centre(page)
      return Math.hypot(c.x - x, c.y - y) < within
    })
    .toBe(true)

let dataDir: string
let server: RunningServer
test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-m5j-'))
  server = await startServer({
    dataDir,
    env: { INGEST_STUB: '1', TUTOR_STUB: '1' },
  })
})
test.afterAll(async () => {
  await server.stop()
  rmSync(dataDir, { recursive: true, force: true })
})

test('jump to AI work: live, followed, past, hovered and by link', async ({
  page,
}) => {
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`)
  })
  await page.goto(WEB)
  await page.waitForURL(`${WEB}/boards/*`)
  await ready(page)
  const boardId = page.url().split('/boards/')[1] as string
  const dock = page.getByRole('complementary', { name: 'Tutor' })
  const composer = dock.getByRole('textbox', { name: 'Message the tutor' })
  const ask = async (text: string) => {
    await composer.fill(text)
    await composer.press('Enter')
  }
  await near(page, 450, 360, 600) // the camera starts at the origin

  // 1. Follow off: AI work lands far away. An arrow appears, the camera does not move, Jump goes there, Back returns.
  await ask('draw far one')
  const arrow = page.getByRole('button', {
    name: /The AI is working off screen/,
  })
  await expect(arrow).toBeVisible({ timeout: 30_000 })
  await expect(arrow).toContainText('AI · 1 new')
  expect(
    Math.hypot((await centre(page)).x - 450, (await centre(page)).y - 360),
  ).toBeLessThan(600) // not moved
  await expect(page.getByRole('button', { name: 'Jump to AI' })).toBeVisible() // pinned while the turn runs
  await arrow.click()
  await near(page, 6100, 4050)
  await expect(page.getByRole('button', { name: '↩ Back' })).toBeVisible()
  await page.getByRole('button', { name: '↩ Back' }).click()
  await near(page, 450, 360, 600)
  await expect(dock.getByRole('button', { name: 'Send' })).toBeVisible({
    timeout: 30_000,
  }) // the turn ends: the arrow goes
  await expect(arrow).toBeHidden()

  // 2. Follow on: the camera goes to the new work by itself; taking the canvas turns Follow off
  const follow = page.getByRole('switch', { name: 'Follow AI' })
  await follow.check()
  await ask('follow me')
  await near(page, -4900, 350)
  await expect(dock.getByRole('button', { name: 'Send' })).toBeVisible({
    timeout: 30_000,
  })
  await page.mouse.move(400, 400)
  await page.mouse.wheel(0, 120)
  await expect(follow).not.toBeChecked()
  await expect(
    page.getByText('Follow AI off (you moved the canvas)'),
  ).toBeVisible()

  // 3. The past: reload, open the Activity tab, Locate a turn; a moved element is followed, a deleted one leaves a ghost
  await page.reload()
  await ready(page)
  await dock.getByRole('tab', { name: 'Activity' }).click()
  const rows = dock
    .getByRole('list', { name: "The tutor's work" })
    .locator('> li')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('follow me')
  await rows.nth(1).getByRole('button', { name: 'Locate turn' }).click()
  await near(page, 6100, 4050)
  const far = (await aiEls(page)).find((e) => e.x === 6000) as El
  await page.evaluate(
    (id) =>
      (window as unknown as W).__editor?.commit({
        batchId: 'move',
        label: 'Move',
        ops: [{ op: 'patch', id, set: { x: 1000, y: 1200 } }],
      }),
    far.id,
  )
  await rows.nth(1).getByRole('button', { name: 'Locate turn' }).click()
  await near(page, 1100, 1250) // it follows the element to where the student put it
  await page.evaluate(
    (id) =>
      (window as unknown as W).__editor?.commit({
        batchId: 'del',
        label: 'Delete',
        ops: [{ op: 'remove', id }],
      }),
    far.id,
  )
  await rows.nth(1).getByRole('button', { name: 'Locate turn' }).click()
  await expect(page.getByText('removed', { exact: true })).toBeVisible() // a ghost frame where it was drawn
  await near(page, 6100, 4050)

  // 4. Hovering something the AI drew says so, and leads back to the chat
  const followed = (await aiEls(page)).find((e) => e.x === -5000) as El
  await rows.first().getByRole('button', { name: 'Locate turn' }).click()
  await near(page, -4900, 350)
  const at = await page.evaluate((id) => {
    const ed = (window as unknown as W).__editor as NonNullable<W['__editor']>
    const el = ed.getSnapshot().elements.find((e) => e.id === id) as El
    return ed.worldToClient({ x: el.x + el.w / 2, y: el.y + el.h / 2 })
  }, followed.id)
  await page.mouse.move(at.x - 5, at.y)
  await page.mouse.move(at.x, at.y)
  const tag = page.getByRole('group', { name: 'Made by the AI' })
  await expect(tag).toContainText('AI · follow me')
  await tag.getByRole('button', { name: 'Show in chat' }).click()
  await expect(dock.getByRole('tab', { name: 'Chat' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(dock.locator('article[data-turn]').first()).toBeVisible()

  // 5. Deep links land on the work after a reload
  const turns = (
    await (
      await page.request.get(`${API}/api/boards/${boardId}/activity`)
    ).json()
  ).turns as { turnId: string; batches: { batchId: string }[] }[]
  await page.goto(`${WEB}/boards/${boardId}?turn=${turns[0]?.turnId}`)
  await ready(page)
  await near(page, -4900, 350)
  await page.goto(`${WEB}/boards/${boardId}?el=${followed.id}`)
  await ready(page)
  await near(page, -4900, 350)

  expect(problems).toEqual([])
})

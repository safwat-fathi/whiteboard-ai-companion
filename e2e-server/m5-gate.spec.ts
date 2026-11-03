import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { makeTestPdf } from '../apps/server/src/library/test-pdf'
import { type RunningServer, startServer } from './helpers/server'

// M5 gate (docs/plans/testing-spikes.md, "Tutor end-to-end"): upload -> index -> a board studying a chapter -> a question in
// the dock -> text, math and a shape on the board with a [p. N] citation -> the citation opens the page in the Source tab ->
// Stop leaves a consistent board -> "Undo this response" removes it. The server runs with INGEST_STUB=1 and TUTOR_STUB=1
// (scripted model from apps/server/test/fixtures/tutor/gate.json): deterministic and free. The real model is a manual run.
const WEB = 'http://localhost:3201'
const ENV = { INGEST_STUB: '1', TUTOR_STUB: '1' }

const PROSE =
  'The quick brown fox jumps over the lazy dog and keeps running through the long green meadow.'
const fixture = Buffer.from(
  makeTestPdf({
    pages: [PROSE, '', PROSE],
    outline: [
      { title: 'Chapter 1', page: 1 },
      { title: 'Chapter 2', page: 3 },
    ],
    labels: [{ from: 1, style: 'r' }],
  }),
)

test.describe.configure({ mode: 'serial' })

type El = { id: string; type: string; author: { kind: string; id: string } }
type W = { __editor?: { readOnly: boolean; getSnapshot(): { elements: El[] } } }
const ready = (page: Page) =>
  page.waitForFunction(() => {
    const ed = (window as unknown as W).__editor
    return !!ed && !ed.readOnly
  })
const elements = (page: Page): Promise<El[]> =>
  page.evaluate(
    () => (window as unknown as W).__editor?.getSnapshot().elements ?? [],
  )
const tutorEls = async (page: Page) =>
  (await elements(page)).filter((e) => e.author.kind === 'agent')

let dataDir: string
let server: RunningServer
test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-m5-'))
  server = await startServer({ dataDir, env: ENV })
})
test.afterAll(async () => {
  await server.stop()
  rmSync(dataDir, { recursive: true, force: true })
})

test('the tutor loop: ask, see it drawn with citations, open the page, stop, undo, reload', async ({
  page,
}) => {
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`)
  })

  // 1. upload and index a book, then study its second chapter
  await page.goto(`${WEB}/library`)
  await page.setInputFiles('input[type=file]', {
    name: 'Fixture Book.pdf',
    mimeType: 'application/pdf',
    buffer: fixture,
  })
  const dialog = page.getByRole('dialog', { name: /Index Fixture Book/ })
  await dialog.getByRole('button', { name: 'Index', exact: true }).click()
  const card = page.getByRole('listitem').filter({ hasText: 'Fixture Book' })
  await expect(card.getByText(/Ready: \d+ passages/)).toBeVisible({
    timeout: 30_000,
  })
  await card.getByRole('link', { name: 'Open' }).click()
  await page.getByRole('checkbox', { name: /Chapter 2/ }).check()
  await page.getByRole('button', { name: 'Study this' }).click()
  await page.waitForURL(`${WEB}/boards/*`)
  await ready(page)

  const dock = page.getByRole('complementary', { name: 'Tutor' })
  await expect(
    page.getByRole('button', { name: /Fixture Book: Chapter 2/ }),
  ).toBeVisible() // the scope chip
  const composer = dock.getByRole('textbox', { name: 'Message the tutor' })
  await expect(composer).toHaveAttribute('dir', 'auto')
  const replies = dock.getByRole('article', { name: 'Tutor' })

  // 2. ask: text, a formula and a shape appear on the board; the reply cites the chapter's page
  await composer.fill('explain this chapter')
  await composer.press('Enter')
  await expect(replies.first()).toContainText(
    'The fox keeps running through the meadow',
    { timeout: 30_000 },
  )
  await expect(dock.getByRole('button', { name: 'Send' })).toBeVisible() // the turn is over
  await expect
    .poll(async () => (await tutorEls(page)).map((e) => e.type).sort())
    .toEqual(['math', 'shape', 'text'])
  for (const e of await tutorEls(page)) expect(e.author.id).toMatch(/^tutor:/)
  await expect(replies.first()).toContainText('Add text · 1 element')
  await expect(replies.first()).toContainText('(900 cached)') // the footer shows the turn's tokens, and the cached part

  // 3. the citation opens the page in the Source tab
  await replies.first().getByRole('button', { name: 'p. 3' }).click()
  await expect(dock.getByRole('tab', { name: 'Source' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const image = dock.getByRole('img', { name: /^Page/ })
  await expect(image).toBeVisible()
  await expect
    .poll(() =>
      image.evaluate((el: HTMLImageElement) =>
        el.complete ? el.naturalWidth : 0,
      ),
    )
    .toBeGreaterThan(100)
  await expect(dock.locator('figcaption')).toHaveText(
    /^p\. iii \(file page 3 of 3\)$/,
  )
  await dock.getByRole('tab', { name: 'Chat' }).click()

  // 4. Stop in the middle of an answer: what was drawn stays, the board is consistent, the composer is ready again
  await composer.fill('slow please')
  await composer.press('Enter')
  await expect(replies.nth(1)).toContainText('Add rect · 1 element', {
    timeout: 30_000,
  })
  await dock.getByRole('button', { name: 'Stop' }).click()
  await expect(dock.getByRole('button', { name: 'Send' })).toBeVisible()
  await expect(dock.getByRole('alert')).toHaveCount(0)
  await expect.poll(async () => (await tutorEls(page)).length).toBe(4)
  await expect(composer).toBeEnabled()

  // 5. Undo this response removes exactly what that response drew, then the first one's
  await replies
    .nth(1)
    .getByRole('button', { name: 'Undo this response' })
    .click()
  await expect(replies.nth(1)).toContainText('Undid 1 change.')
  await expect.poll(async () => (await tutorEls(page)).length).toBe(3)
  await replies
    .first()
    .getByRole('button', { name: 'Undo this response' })
    .click()
  await expect(replies.first()).toContainText('Undid 3 changes.')
  await expect.poll(async () => (await tutorEls(page)).length).toBe(0)

  // 6. an Arabic question goes through the composer; reload brings the conversation back, citations still verified
  await composer.fill('اشرح لي هذا الفصل')
  await composer.press('Enter')
  await expect(dock.getByRole('article', { name: 'You' }).last()).toContainText(
    'اشرح لي هذا الفصل',
  )
  await expect(dock.getByRole('button', { name: 'Send' })).toBeVisible({
    timeout: 30_000,
  })
  await page.reload()
  await ready(page)
  await expect(dock.getByRole('article', { name: 'You' })).toHaveCount(3)
  await expect(
    dock.getByRole('article', { name: 'You' }).first(),
  ).toContainText('explain this chapter')
  await expect(
    dock
      .getByRole('article', { name: 'Tutor' })
      .first()
      .getByRole('button', { name: 'p. 3' }),
  ).toBeVisible()
  expect(await tutorEls(page)).toHaveLength(0) // the undone drawing stays undone

  expect(problems).toEqual([])
})

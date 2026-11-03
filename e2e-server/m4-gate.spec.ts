import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { makeTestPdf } from '../apps/server/src/library/test-pdf'
import { type RunningServer, startServer } from './helpers/server'

// M4 gate (docs/plans/testing-spikes.md, "Library"): upload a PDF, watch it index, browse the outline, search it, open
// the cited page, study it; an interrupted book is retried; a foreign Origin cannot upload. The server runs with
// INGEST_STUB=1 (offline providers: deterministic, free). The real books are measured by `pnpm eval:retrieval`.
const API = 'http://localhost:4201'
const WEB = 'http://localhost:3201'
const ENV = { INGEST_STUB: '1' }

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

let dataDir: string
let server: RunningServer
test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-m4-'))
  server = await startServer({ dataDir, env: ENV })
})
test.afterAll(async () => {
  await server.stop()
  rmSync(dataDir, { recursive: true, force: true })
})

test('a book goes from upload to a cited page, and can be studied', async ({
  page,
}) => {
  await page.goto(`${WEB}/library`)
  await expect(page.getByText('Drop a PDF here')).toBeVisible()

  await page.setInputFiles('input[type=file]', {
    name: 'Fixture Book.pdf',
    mimeType: 'application/pdf',
    buffer: fixture,
  })
  const dialog = page.getByRole('dialog', { name: /Index Fixture Book/ })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/3 pages/)).toBeVisible()
  // look before anything is started: both readings of a page, for free
  await dialog.getByRole('button', { name: 'Compare readings' }).click()
  await expect(dialog.getByText('Local text')).toBeVisible()
  await expect(dialog.getByText('Vision model')).toBeVisible()
  await dialog.getByRole('button', { name: 'Index', exact: true }).click()
  await expect(dialog).toBeHidden()

  const card = page.getByRole('listitem').filter({ hasText: 'Fixture Book' })
  await expect(card.getByText(/Ready: \d+ passages/)).toBeVisible({
    timeout: 30_000,
  })
  await card.getByRole('link', { name: 'Open' }).click()

  await expect(
    page.getByRole('heading', { name: 'Fixture Book' }),
  ).toBeVisible()
  await expect(page.getByText('Chapter 1')).toBeVisible()
  await expect(page.getByText('Chapter 2')).toBeVisible()

  await page
    .getByRole('searchbox', { name: 'Search this book' })
    .fill('quick brown fox')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  const hit = page
    .getByRole('region', { name: 'Search results' })
    .getByRole('button')
    .first()
  await expect(hit).toContainText(/pp?\. i/)
  await hit.click()
  const image = page.getByRole('img', { name: /^Page/ })
  await expect(image).toBeVisible()
  await expect
    .poll(() =>
      image.evaluate((el: HTMLImageElement) =>
        el.complete ? el.naturalWidth : 0,
      ),
    )
    .toBeGreaterThan(100)
  await expect(page.getByText(/p\. i \(file page 1 of 3\)/)).toBeVisible()

  // the chosen section becomes the board's scope
  await page.getByRole('checkbox', { name: /Chapter 2/ }).check()
  await page.getByRole('button', { name: 'Study this' }).click()
  await page.waitForURL(`${WEB}/`)
  const boardId = await page.evaluate(() =>
    localStorage.getItem('whiteboard:boardId'),
  )
  expect(boardId).toBeTruthy()
  const board = await (
    await page.request.get(`${API}/api/boards/${boardId}`)
  ).json()
  expect(board.scope).toMatchObject({
    kind: 'chapter',
    sectionIds: [expect.any(Number)],
  })
  expect(board.title).toContain('Fixture Book')
})

test('a book interrupted by a restart can be retried and finishes', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const big = Buffer.from(makeTestPdf({ pages: Array(250).fill('') })) // 250 pages the vision stub reads one by one
  const headers = { Origin: WEB, 'Content-Type': 'application/pdf' }
  const up = await request.post(`${API}/api/books?title=Big%20Scan`, {
    headers,
    data: big,
  })
  expect(up.status()).toBe(201)
  const { id } = await up.json()
  expect(
    (
      await request.post(`${API}/api/books/${id}/index`, {
        headers: { Origin: WEB },
      })
    ).status(),
  ).toBe(202)

  await expect
    .poll(
      async () => {
        const b = await (await request.get(`${API}/api/books/${id}`)).json()
        return b.status === 'extracting' && b.progress > 0
      },
      { timeout: 60_000 },
    )
    .toBe(true)
  await server.stop() // killed mid-job
  server = await startServer({ dataDir, env: ENV })

  const after = await (await request.get(`${API}/api/books/${id}`)).json()
  expect(after.status).toBe('failed')
  expect(after.error).toMatch(/interrupted/)

  await page.goto(`${WEB}/library`)
  const card = page.getByRole('listitem').filter({ hasText: 'Big Scan' })
  await expect(card.getByText(/Failed/)).toBeVisible()
  await card.getByRole('button', { name: 'Retry' }).click()
  await expect(card.getByText(/Ready: \d+ passages/)).toBeVisible({
    timeout: 120_000,
  })
})

test('an upload from a foreign Origin is refused and stores nothing', async ({
  request,
}) => {
  const before = await (await request.get(`${API}/api/books`)).json()
  const r = await request.post(`${API}/api/books?title=Evil`, {
    headers: { Origin: 'http://evil.test', 'Content-Type': 'application/pdf' },
    data: fixture,
  })
  expect(r.status()).toBe(403)
  expect((await r.json()).error.code).toBe('forbidden_origin')
  const after = await (await request.get(`${API}/api/books`)).json()
  expect(after.books.length).toBe(before.books.length)
})

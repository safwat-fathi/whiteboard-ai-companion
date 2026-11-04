import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { decodePng, encodePng } from '../e2e/helpers/diff'
import { comparePngBuffers } from './helpers/png'
import { type RunningServer, startServer } from './helpers/server'

// M6 gate (docs/plans/testing-spikes.md): "the student can handwrite; the AI can chart". Handwrite with real pointer input,
// select it, Ask AI (the request carries the handwriting as one picture), ask for a chart (the scripted model calls
// add_chart with data and draw_stroke), the chart appears, the server's picture of a board with ink and a chart matches the
// browser's within 1.5%, the tutor aligns the student's selected boxes, and Undo this response takes each response back.
// TUTOR_STUB=1: the scripted model (apps/server/test/fixtures/tutor/m6.json); the real model is a manual run.
const API = 'http://localhost:4201'
const WEB = 'http://localhost:3201'

test.use({ deviceScaleFactor: 1, viewport: { width: 1000, height: 800 } })
test.describe.configure({ mode: 'serial' })

type El = {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  author: { kind: string; id: string }
  data: Record<string, unknown>
}
type W = {
  __editor?: {
    readOnly: boolean
    selection: Set<string>
    commit(batch: unknown): void
    camera: { x: number; y: number; zoom: number }
    invalidate(): void
    getSnapshot(): { elements: El[] }
  }
}
const ready = (page: Page) =>
  page.waitForFunction(() => {
    const ed = (window as unknown as W).__editor
    return !!ed && !ed.readOnly
  })
const elements = (page: Page): Promise<El[]> =>
  page.evaluate(
    () => (window as unknown as W).__editor?.getSnapshot().elements ?? [],
  )
const agentEls = async (page: Page) =>
  (await elements(page)).filter((e) => e.author.kind === 'agent')
const frames = (page: Page, n: number) =>
  page.evaluate(
    (k) =>
      new Promise<void>((done) => {
        const f = (i: number) =>
          i <= 0 ? done() : requestAnimationFrame(() => f(i - 1))
        f(k)
      }),
    n,
  )
const btn = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true })

/** Press, drag through `pts`, release: real mouse input, so the pen sees pointerType 'mouse' and no pressure. */
async function stroke(page: Page, pts: [number, number][]) {
  const [first, ...rest] = pts as [[number, number], ...[number, number][]]
  await page.mouse.move(...first)
  await page.mouse.down()
  for (const p of rest) await page.mouse.move(...p, { steps: 4 })
  await page.mouse.up()
}

type Prompt = {
  role: string
  content: { type: string; text?: string }[]
}[]
async function lastUserContent(page: Page) {
  const boardId = page.url().split('/boards/')[1]
  const res = await page.request.get(
    `${API}/api/_test/last-request?boardId=${boardId}`,
  )
  const calls = (await res.json()).calls as { prompt: Prompt }[]
  return (
    calls
      .at(-1)
      ?.prompt.filter((m) => m.role === 'user')
      .at(-1)?.content ?? []
  )
}

let dataDir: string
let server: RunningServer
test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-m6-'))
  server = await startServer({
    dataDir,
    env: { INGEST_STUB: '1', TUTOR_STUB: '1' },
  })
})
test.afterAll(async () => {
  await server.stop()
  rmSync(dataDir, { recursive: true, force: true })
})

test('M6 gate: handwrite, Ask AI, chart, the picture matches the server, tidy, undo', async ({
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
  const dock = page.getByRole('complementary', { name: 'Tutor' })
  const composer = dock.getByRole('textbox', { name: 'Message the tutor' })
  const replies = dock.getByRole('article', { name: 'Tutor' })

  // 1. handwrite with the pen: a wave and a loop
  await btn(page, 'Pen').click()
  await stroke(page, [
    [130, 470],
    [170, 440],
    [210, 500],
    [250, 450],
    [290, 500],
  ])
  await stroke(page, [
    [340, 470],
    [370, 440],
    [400, 470],
    [370, 510],
    [340, 470],
  ])
  const ink = (await elements(page)).filter((e) => e.type === 'freehand')
  expect(ink).toHaveLength(2)
  for (const e of ink) expect(e.author.kind).toBe('human')

  // 2. select it with a marquee and Ask AI: the composer takes the cursor and the request carries the ink as one picture
  await btn(page, 'Select').click()
  await page.mouse.move(100, 410)
  await page.mouse.down()
  await page.mouse.move(430, 540, { steps: 6 })
  await page.mouse.up()
  const chips = dock.getByRole('group', { name: 'What goes with your message' })
  await expect(chips).toContainText('Selection (2)')
  await page
    .getByRole('toolbar', { name: 'Selection' })
    .getByRole('button', { name: 'Ask AI' })
    .click()
  await expect(composer).toBeFocused()
  await composer.fill('what did I write')
  await composer.press('Enter')
  await expect(replies.first()).toContainText(
    'It looks like a wave and a loop.',
    {
      timeout: 30_000,
    },
  )
  const asked = await lastUserContent(page)
  for (const e of ink) expect(asked[0]?.text).toContain(`"id":"${e.id}"`)
  expect(asked.filter((p) => p.type === 'file')).toHaveLength(1)

  // 3. ask for a chart: the tutor draws it from data, and a line under it
  await composer.fill('chart the sales numbers')
  await composer.press('Enter')
  await expect(replies.nth(1)).toContainText(
    'Here is the chart, with a line under it.',
    { timeout: 30_000 },
  )
  await expect(replies.nth(1)).toContainText('Chart: Sales by quarter')
  await expect
    .poll(async () => (await agentEls(page)).map((e) => e.type).sort())
    .toEqual(['chart', 'freehand'])
  const chart = (await agentEls(page)).find((e) => e.type === 'chart') as El
  expect(chart.author.id).toMatch(/^tutor:/)
  expect(chart.data).toMatchObject({
    kind: 'bar',
    title: 'Sales by quarter',
    categories: ['Q1', 'Q2', 'Q3', 'Q4'],
    series: [
      { name: 'North', values: [12, 19, 8, 15] },
      { name: 'South', values: [9, 4, 14, 20] },
    ],
  })
  expect(chart).toMatchObject({ w: 480, h: 320, x: 120, y: 40 })

  // 4. the server's picture of this board (ink, a chart and a stroke) matches the browser's within 1.5% of pixels
  const boardId = page.url().split('/boards/')[1] as string
  const rect = await page.evaluate(() => {
    const els = (window as unknown as W).__editor?.getSnapshot().elements ?? []
    const minX = Math.min(...els.map((e) => e.x))
    const minY = Math.min(...els.map((e) => e.y))
    const maxX = Math.max(...els.map((e) => e.x + e.w))
    const maxY = Math.max(...els.map((e) => e.y + e.h))
    const pad = 24
    return {
      x: Math.floor(minX - pad),
      y: Math.floor(minY - pad),
      w: Math.ceil(maxX - minX + 2 * pad),
      h: Math.ceil(maxY - minY + 2 * pad),
    }
  })
  const width = 800
  const height = Math.round((width * rect.h) / rect.w)
  await page.setViewportSize({
    width: Math.max(1000, width + 420), // the board is the viewport minus the dock (up to 380 px)
    height: Math.max(800, height + 100),
  })
  await page.evaluate(
    ({ r, w }) => {
      const ed = (window as unknown as W).__editor
      if (!ed) return
      ed.selection.clear()
      ed.camera = { x: r.x, y: r.y, zoom: w / r.w }
      ed.invalidate()
    },
    { r: rect, w: width },
  )
  await frames(page, 5)
  await page.waitForTimeout(500)
  // display, not visibility: the bar's transition would still be drawn in the screenshot
  await page.addStyleTag({ content: 'header { display: none !important }' })
  const browserPicture = await page.screenshot({
    clip: { x: 0, y: 0, width, height },
  })
  const res = await fetch(
    `${API}/api/boards/${boardId}/export.png?x=${rect.x}&y=${rect.y}&w=${rect.w}&h=${rect.h}&width=${width}`,
  )
  expect(res.status).toBe(200)
  const serverPicture = Buffer.from(await res.arrayBuffer())
  const diff = comparePngBuffers(browserPicture, serverPicture, 24)
  test.info().annotations.push({
    type: 'parity',
    description: `${(diff.ratio * 100).toFixed(3)}% of ${diff.total} px differ`,
  })
  if (diff.ratio > 0.015) {
    const out = resolve(process.cwd(), 'test-results')
    mkdirSync(out, { recursive: true })
    writeFileSync(resolve(out, 'm6-browser.png'), browserPicture)
    writeFileSync(resolve(out, 'm6-server.png'), serverPicture)
    writeFileSync(
      resolve(out, 'm6-diff.png'),
      encodePng(diff.w, diff.h, diff.diffRgba),
    )
  }
  expect(diff.ratio).toBeLessThanOrEqual(0.015)
  // a server that drew no chart would still pass on ratio alone if the bars were few: the picture must hold both series' colours
  const served = decodePng(serverPicture).data
  const near = (i: number, r: number, g: number, b: number) =>
    Math.abs((served[i] ?? 0) - r) < 12 &&
    Math.abs((served[i + 1] ?? 0) - g) < 12 &&
    Math.abs((served[i + 2] ?? 0) - b) < 12
  let north = 0
  let south = 0
  for (let i = 0; i < served.length; i += 4) {
    if (near(i, 0, 114, 178)) north++ // #0072b2, the first palette colour
    if (near(i, 230, 159, 0)) south++ // #e69f00, the second
  }
  expect(north).toBeGreaterThan(5000)
  expect(south).toBeGreaterThan(5000)

  // 5. the tutor lines up two boxes the student selected, as one change
  await page.evaluate(() => {
    const ed = (window as unknown as W).__editor
    const box = (id: string, x: number, y: number, z: string) => ({
      op: 'add',
      el: {
        id,
        type: 'shape',
        x,
        y,
        w: 100,
        h: 60,
        rotation: 0,
        z,
        style: {
          stroke: '#1e1e1e',
          fill: '#ffffff',
          strokeWidth: 2,
          opacity: 1,
          dash: 'solid',
        },
        locked: false,
        author: { kind: 'human', id: 'owner' },
        v: 0,
        data: { kind: 'rect' },
      },
    })
    ed?.commit({
      batchId: 'seed-tidy',
      label: 'Seed',
      ops: [box('tidy-a', 30, 600, 'a8'), box('tidy-b', 230, 660, 'a9')],
    })
    ed?.selection.clear()
    for (const id of ['tidy-a', 'tidy-b']) ed?.selection.add(id)
  })
  await expect(chips).toContainText('Selection (2)')
  await composer.fill('tidy up my boxes')
  await composer.press('Enter')
  await expect(replies.nth(2)).toContainText('Lined up along the top.', {
    timeout: 30_000,
  })
  const y = async (id: string) =>
    ((await elements(page)).find((e) => e.id === id) as El).y
  expect([await y('tidy-a'), await y('tidy-b')]).toEqual([600, 600])

  // 6. Undo this response: the alignment first, then the chart and its line; the student's handwriting stays
  await replies
    .nth(2)
    .getByRole('button', { name: 'Undo this response' })
    .click()
  await expect(replies.nth(2)).toContainText('Undid 1 change.')
  expect(await y('tidy-b')).toBe(660)
  await replies
    .nth(1)
    .getByRole('button', { name: 'Undo this response' })
    .click()
  await expect(replies.nth(1)).toContainText('Undid 2 changes.')
  await expect.poll(async () => (await agentEls(page)).length).toBe(0)
  expect(
    (await elements(page)).filter((e) => e.type === 'freehand'),
  ).toHaveLength(2)

  expect(problems).toEqual([])
})

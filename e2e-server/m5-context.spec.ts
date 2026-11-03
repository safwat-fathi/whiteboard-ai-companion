import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { type RunningServer, startServer } from './helpers/server'

// M5 "Board context" script (docs/plans/testing-spikes.md): select three elements -> the chip says what goes along ->
// "What the AI sees" lists those ids and a picture -> send -> the model's request holds the digest with those ids and one
// image -> "make these red" changes only those -> editing an unselected element is refused -> viewport and whole-board
// payloads stay inside the digest budget. Then the M6 handwriting step: three strokes drawn with the mouse and a shape are
// selected, the chip says the picture is automatic, and exactly one image goes along even with "structure" chosen.
const API = 'http://localhost:4201'
const WEB = 'http://localhost:3201'

test.describe.configure({ mode: 'serial' })

type El = {
  id: string
  type: string
  style: { stroke: string }
  author: { kind: string }
}
type W = {
  __editor?: {
    readOnly: boolean
    selection: Set<string>
    commit(batch: unknown): void
    getSnapshot(): { elements: El[] }
  }
}
const ready = (page: Page) =>
  page.waitForFunction(() => {
    const ed = (window as unknown as W).__editor
    return !!ed && !ed.readOnly
  })
const stroke = async (page: Page, id: string) =>
  page.evaluate(
    (i) =>
      (window as unknown as W).__editor
        ?.getSnapshot()
        .elements.find((e) => e.id === i)?.style.stroke,
    id,
  )

let dataDir: string
let server: RunningServer
test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-m5c-'))
  server = await startServer({
    dataDir,
    env: { INGEST_STUB: '1', TUTOR_STUB: '1' },
  })
})
test.afterAll(async () => {
  await server.stop()
  rmSync(dataDir, { recursive: true, force: true })
})

type Prompt = {
  role: string
  content: { type: string; text?: string; bytes?: number }[]
}[]
async function lastRequest(page: Page): Promise<Prompt> {
  const boardId = page.url().split('/boards/')[1]
  const res = await page.request.get(
    `${API}/api/_test/last-request?boardId=${boardId}`,
  )
  const calls = (await res.json()).calls as { prompt: Prompt }[]
  return calls[0]?.prompt ?? []
}
const userContent = async (page: Page) =>
  (await lastRequest(page)).filter((m) => m.role === 'user').at(-1)?.content ??
  []

test('the board goes along with the question: chips, a preview, a picture, edit rights', async ({
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
  // four shapes of the student's, with known ids
  await page.evaluate(() => {
    const ed = (window as unknown as W).__editor
    const rect = (id: string, x: number, z: string) => ({
      op: 'add',
      el: {
        id,
        type: 'shape',
        x,
        y: 100,
        w: 120,
        h: 70,
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
      batchId: 'seed',
      label: 'Seed',
      ops: [
        rect('sel-a', 100, 'a0'),
        rect('sel-b', 300, 'a1'),
        rect('sel-c', 500, 'a2'),
        rect('other', 700, 'a3'),
      ],
    })
    for (const id of ['sel-a', 'sel-b', 'sel-c']) ed?.selection.add(id)
  })

  const dock = page.getByRole('complementary', { name: 'Tutor' })
  const composer = dock.getByRole('textbox', { name: 'Message the tutor' })
  const chips = dock.getByRole('group', { name: 'What goes with your message' })

  // 1. the chip says what goes along, and the toolbar offers Ask AI, which brings the cursor to the composer
  await expect(chips).toContainText('Selection (3)')
  await expect(chips.getByLabel('How the selection is sent')).toHaveValue(
    'both',
  )
  await page
    .getByRole('toolbar', { name: 'Selection' })
    .getByRole('button', { name: 'Ask AI' })
    .click()
  await expect(composer).toBeFocused()

  // 2. "What the AI sees": the ids and a picture
  await dock.getByRole('button', { name: 'What the AI sees' }).click()
  const peek = page.getByRole('dialog', { name: 'What the AI sees' })
  await expect(peek).toContainText('SELECTION sel-a sel-b sel-c')
  await expect(peek.getByRole('img').first()).toBeVisible()
  await expect(peek).toContainText(/\d[\d,]* tokens/)
  await peek.getByRole('button', { name: 'Close' }).click()

  // 3. send: the model's request carries the digest with those ids and exactly one image
  await composer.fill('make these red')
  await composer.press('Enter')
  await expect(
    dock.getByRole('article', { name: 'Tutor' }).first(),
  ).toContainText('They are red now.', { timeout: 30_000 })
  const content = await userContent(page)
  expect(content[0]?.text).toContain('SELECTION sel-a sel-b sel-c')
  expect(content[0]?.text).toContain('"id":"sel-a"') // the selection as full data
  expect(content.filter((p) => p.type === 'file')).toHaveLength(1)
  expect(content.filter((p) => p.type === 'file')[0]?.bytes).toBeGreaterThan(
    200,
  )

  // 4. only the selected elements changed
  expect([
    await stroke(page, 'sel-a'),
    await stroke(page, 'sel-b'),
    await stroke(page, 'sel-c'),
  ]).toEqual(['#ff0000', '#ff0000', '#ff0000'])
  expect(await stroke(page, 'other')).toBe('#1e1e1e')

  // 5. an element the student did not select cannot be edited: the tutor is told why, the board is unchanged
  await page.evaluate(() => {
    const ed = (window as unknown as W).__editor
    ed?.selection.clear()
    ed?.selection.add('sel-a')
  })
  await expect(chips).toContainText('Selection (1)')
  await composer.fill('edit the other one')
  await composer.press('Enter')
  await expect(
    dock.getByRole('article', { name: 'Tutor' }).nth(1),
  ).toContainText('I can only change what you select.', { timeout: 30_000 })
  expect(await stroke(page, 'other')).toBe('#1e1e1e')
  const boardId = page.url().split('/boards/')[1]
  const calls = (
    await (
      await page.request.get(`${API}/api/_test/last-request?boardId=${boardId}`)
    ).json()
  ).calls as { prompt: unknown }[]
  expect(JSON.stringify(calls[1]?.prompt)).toContain(
    'belongs to the student and was not selected',
  )

  // 6. viewport and whole board as pictures: two images, and the digest stays inside its budget
  await page.evaluate(() =>
    (window as unknown as W).__editor?.selection.clear(),
  )
  await expect(chips).not.toContainText('Selection (')
  await chips.getByRole('button', { name: 'Viewport' }).click()
  await chips.getByLabel('Whole board').selectOption('picture')
  await composer.fill('what do you see')
  await composer.press('Enter')
  await expect(
    dock.getByRole('article', { name: 'Tutor' }).nth(2),
  ).toContainText('I see your board.', { timeout: 30_000 })
  const wide = await userContent(page)
  expect(wide.filter((p) => p.type === 'file')).toHaveLength(2)
  expect((wide[0]?.text ?? '').length).toBeLessThan(9500) // about 3,000 tokens

  // 7. handwriting (M6): the viewport and board chips go back off; three strokes drawn with real mouse input, then
  // selected with a shape. Handwriting is only readable as a picture, so structure-only still sends exactly one.
  await chips.getByRole('button', { name: 'Viewport' }).click()
  await chips.getByLabel('Whole board').selectOption('off')
  await page.getByRole('button', { name: 'Pen', exact: true }).click()
  const inkPaths: [number, number][][] = [
    [
      [150, 300],
      [250, 380],
      [350, 300],
    ],
    [
      [150, 420],
      [350, 420],
    ],
    [
      [420, 300],
      [480, 420],
    ],
  ]
  for (const pts of inkPaths) {
    const [first, ...rest] = pts as [[number, number], ...[number, number][]]
    await page.mouse.move(...first)
    await page.mouse.down()
    for (const p of rest) await page.mouse.move(...p, { steps: 4 })
    await page.mouse.up()
  }
  const strokeIds = await page.evaluate(
    () =>
      (window as unknown as W).__editor
        ?.getSnapshot()
        .elements.filter((e) => e.type === 'freehand')
        .map((e) => e.id) ?? [],
  )
  expect(strokeIds).toHaveLength(3)
  await page.evaluate((ids) => {
    const ed = (window as unknown as W).__editor
    ed?.selection.clear()
    for (const id of [...ids, 'sel-a']) ed?.selection.add(id)
  }, strokeIds)
  await expect(chips).toContainText('Selection (4)')
  await chips.getByLabel('How the selection is sent').selectOption('structure')
  await expect(chips).toContainText('(auto)')
  await expect(chips.getByLabel('How the selection is sent')).toHaveValue(
    'both',
  )
  await dock.getByRole('button', { name: 'What the AI sees' }).click()
  const inkPeek = page.getByRole('dialog', { name: 'What the AI sees' })
  for (const id of [...strokeIds, 'sel-a'])
    await expect(inkPeek).toContainText(id)
  await expect(inkPeek.getByRole('img')).toHaveCount(1)
  await inkPeek.getByRole('button', { name: 'Close' }).click()
  await composer.fill('read my handwriting')
  await composer.press('Enter')
  await expect(
    dock.getByRole('article', { name: 'Tutor' }).nth(3),
  ).toContainText('It says hello.', { timeout: 30_000 })
  const inkContent = await userContent(page)
  for (const id of [...strokeIds, 'sel-a'])
    expect(inkContent[0]?.text).toContain(`"id":"${id}"`)
  expect(inkContent[0]?.text).toContain('stroke, 3 pts') // the digest names a stroke without its coordinates
  expect(inkContent.filter((p) => p.type === 'file')).toHaveLength(1)

  // a text-only selection with the same "structure" choice sends no picture
  await page.evaluate(() => {
    const ed = (window as unknown as W).__editor
    ed?.selection.clear()
    ed?.selection.add('sel-a')
  })
  await expect(chips).toContainText('Selection (1)')
  await chips.getByLabel('How the selection is sent').selectOption('structure')
  await expect(chips).not.toContainText('(auto)')
  await composer.fill('what do you see')
  await composer.press('Enter')
  await expect(
    dock.getByRole('article', { name: 'Tutor' }).nth(4),
  ).toContainText('I see your board.', { timeout: 30_000 })
  expect(
    (await userContent(page)).filter((p) => p.type === 'file'),
  ).toHaveLength(0)

  expect(problems).toEqual([])
})

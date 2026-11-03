import type { Element } from '@whiteboard/core'
import { describe, expect, it } from 'vitest'
import { boot, ORIGIN } from '../../http-test-utils'
import { makeTestPdf } from '../../library/test-pdf'
import type { StubFixture } from '../stub'

const PDF = Buffer.from(
  makeTestPdf({
    pages: [
      'Chloroplast structure: thylakoid stacks form grana.',
      'Second page.',
    ],
    outline: [{ title: 'Cells', page: 1 }],
    labels: [{ from: 1, style: 'r' }],
  }),
)

async function setup(fixtures: StubFixture[]) {
  const t = await boot({ tutor: { fixtures, realTools: true } })
  const up = await t.call('POST', '/api/books?title=Cells', {
    origin: ORIGIN,
    headers: { 'Content-Type': 'application/pdf' },
    body: PDF,
  })
  const bookId = up.json.id as string
  await t.call('POST', `/api/books/${bookId}/index`, {
    origin: ORIGIN,
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  await t.queue.whenIdle()
  const board = t.boards.createBoard('B', { kind: 'book', bookId })
  const chat = (text: string) =>
    t.json(
      'POST',
      '/api/chat',
      { boardId: board.id, message: { text } },
      ORIGIN,
    )
  const recorded = async () =>
    (await t.call('GET', `/api/_test/last-request?boardId=${board.id}`)).json
      .calls as { prompt: unknown[] }[]
  return {
    ...t,
    bookId,
    board,
    chat,
    recorded,
    scene: () => t.boards.scene(board.id).elements,
  }
}
const fig = (input: unknown): StubFixture => ({
  match: 'fig',
  steps: [{ toolCalls: [{ name: 'add_book_figure', input }] }, { text: 'ok' }],
})

describe('add_book_figure', () => {
  it('crops the page region, stores it as a blob, and adds an image that remembers its page, with a caption under it', async () => {
    const t = await setup([
      fig({
        page: 1,
        rect: { x: 0, y: 0, w: 0.5, h: 0.25 },
        caption: 'Chloroplast',
        width: 300,
        placement: { x: 100, y: 100 },
      }),
    ])
    await t.chat('show a figure')
    const els = t.scene()
    const image = els.find((e) => e.type === 'image') as Extract<
      Element,
      { type: 'image' }
    >
    const caption = els.find((e) => e.type === 'text') as Extract<
      Element,
      { type: 'text' }
    >
    expect(image).toMatchObject({
      x: 100,
      y: 100,
      w: 300,
      data: {
        naturalW: 1024,
        source: { bookPage: { bookId: t.bookId, page: 1 } },
        alt: 'Chloroplast',
      },
    })
    // a US-letter page is 792/612 tall: a quarter of it at 2048 px wide
    expect(image.data.naturalH).toBeCloseTo((2048 * 792) / 612 / 4, -1)
    expect(image.h).toBeCloseTo((300 * image.data.naturalH) / 1024, 0)
    expect(await t.blobs.has(image.data.blobId)).toBe(true)
    expect(caption.data.text).toBe('Chloroplast (p. i)') // the printed label, roman numeral i
    expect(caption.y).toBeGreaterThan(image.y + image.h)
    expect(image.author.kind).toBe('agent')
  })

  it('the same figure twice stores one blob', async () => {
    const t = await setup([fig({ page: 2 })])
    await t.chat('fig one')
    const first = (
      t.scene().find((e) => e.type === 'image') as Extract<
        Element,
        { type: 'image' }
      >
    ).data.blobId
    await t.chat('fig two')
    const ids = t
      .scene()
      .flatMap((e) => (e.type === 'image' ? [e.data.blobId] : []))
    expect(ids).toEqual([first, first])
  })

  it('a page past the end, an unready book and a rect outside the page come back as errors the model can read', async () => {
    const t = await setup([
      {
        match: 'bad',
        steps: [
          {
            toolCalls: [
              { name: 'add_book_figure', input: { page: 9 } },
              { name: 'add_book_figure', input: { page: 1, bookId: 'nope' } },
              {
                name: 'add_book_figure',
                input: { page: 1, rect: { x: 0.8, y: 0, w: 0.5, h: 0.5 } },
              },
            ],
          },
          { text: 'sorry' },
        ],
      },
    ])
    await t.chat('bad figures')
    const prompt = JSON.stringify((await t.recorded())[1]?.prompt)
    expect(prompt).toContain('the book has 2 pages')
    expect(prompt).toContain('no book nope is ready')
    expect(prompt).toContain('must lie within the page')
    expect(t.scene()).toEqual([])
  })
})

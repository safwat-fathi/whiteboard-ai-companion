import { describe, expect, it } from 'vitest'
import { boot, ORIGIN, sseChunks } from '../http-test-utils'
import type { StubFixture } from './stub'

const OWNER = { kind: 'human' as const, id: 'owner' }
const fixtures: StubFixture[] = [
  {
    match: 'draw one',
    steps: [
      {
        toolCalls: [
          {
            name: 'add_text',
            input: { text: 'One', placement: { x: 0, y: 0 } },
          },
          {
            name: 'add_shape',
            input: { kind: 'rect', placement: { x: 0, y: 100 } },
          },
        ],
      },
      { text: 'done' },
    ],
  },
  {
    match: 'draw two',
    steps: [
      {
        toolCalls: [
          {
            name: 'add_text',
            input: { text: 'Two', placement: { x: 500, y: 0 } },
          },
        ],
      },
      { text: 'done' },
    ],
  },
  {
    match: 'slow',
    steps: [
      {
        toolCalls: [
          {
            name: 'add_shape',
            input: { kind: 'rect', placement: { x: 900, y: 0 } },
          },
        ],
      },
      { text: Array(150).fill('w').join(' '), chunkDelayMs: 20 },
    ],
  },
]
async function setup() {
  const t = await boot({ tutor: { fixtures, realTools: true } })
  const board = t.boards.createBoard('B')
  t.boards.submit(
    board.id,
    {
      batchId: 'mine',
      label: 'Mine',
      ops: [
        {
          op: 'add',
          el: {
            id: 'm',
            type: 'shape',
            x: 0,
            y: 300,
            w: 10,
            h: 10,
            rotation: 0,
            z: 'am',
            style: {
              stroke: '#000',
              fill: null,
              strokeWidth: 1,
              opacity: 1,
              dash: 'solid',
            },
            locked: false,
            author: OWNER,
            v: 0,
            data: { kind: 'rect' },
          },
        },
      ],
    },
    OWNER,
  )
  const chat = (text: string) =>
    t.json(
      'POST',
      '/api/chat',
      { boardId: board.id, message: { text } },
      ORIGIN,
    )
  const activity = async (qs = '') =>
    (await t.call('GET', `/api/boards/${board.id}/activity${qs}`)).json as {
      turns: any[]
      next?: string
    }
  return { ...t, board, chat, activity }
}

describe('GET /api/boards/:id/activity', () => {
  it("lists the turns that changed the board, newest first, with their batches, and not the student's own", async () => {
    const t = await setup()
    const r1 = await t.chat('draw one')
    await t.chat('draw two')
    const { turns } = await t.activity()
    expect(turns.map((x) => x.userText)).toEqual(['draw two', 'draw one'])
    const first = turns[1]
    expect(first).toMatchObject({
      status: 'done',
      batches: [
        { label: 'Add text', count: 1 },
        { label: 'Add rect', count: 1 },
      ],
    })
    expect(first.bounds).toMatchObject({ x: 0, y: 0 })
    expect(first.bounds.h).toBeGreaterThan(100)
    expect(first.startedAt).toBeGreaterThan(0)
    // the chip in the chat and the row here name the same elements and the same bounds
    const chips = sseChunks(r1.text)
      .filter((c) => c.type === 'data-batch')
      .map((c) => c.data)
    expect(
      first.batches.map((b: { touchedIds: string[] }) => b.touchedIds),
    ).toEqual(chips.map((c) => c.touchedIds))
    expect(first.batches.map((b: { batchId: string }) => b.batchId)).toEqual(
      chips.map((c) => c.batchId),
    )
    expect(JSON.stringify(turns)).not.toContain('"Mine"')
  })

  it('pages with a cursor, and can fetch one turn or the turn that holds a batch', async () => {
    const t = await setup()
    await t.chat('draw one')
    const second = await t.chat('draw two')
    const page1 = await t.activity('?limit=1')
    expect(page1.turns.map((x) => x.userText)).toEqual(['draw two'])
    expect(page1.next).toBe(page1.turns[0].turnId)
    const page2 = await t.activity(`?limit=1&before=${page1.next}`)
    expect(page2.turns.map((x) => x.userText)).toEqual(['draw one'])
    expect(page2.next).toBeUndefined()
    const turnId = sseChunks(second.text).find((c) => c.type === 'data-turn')
      ?.data.turnId
    expect(
      (await t.activity(`?turn=${turnId}`)).turns.map((x) => x.userText),
    ).toEqual(['draw two'])
    const batchId = page2.turns[0].batches[1].batchId
    expect(
      (await t.activity(`?batch=${batchId}`)).turns.map((x) => x.userText),
    ).toEqual(['draw one'])
    expect((await t.activity('?turn=nope')).turns).toEqual([])
  })

  it('says running while a turn works, and stopped after Stop', async () => {
    const t = await setup()
    const running = t.chat('slow please')
    await new Promise((r) => setTimeout(r, 300))
    expect((await t.activity()).turns[0]).toMatchObject({
      status: 'running',
      batches: [{ label: 'Add rect' }],
    })
    await running
    expect((await t.activity()).turns[0].status).toBe('done')
  })

  it('refuses an unknown board and a bad limit', async () => {
    const t = await setup()
    expect((await t.call('GET', '/api/boards/nope/activity')).status).toBe(404)
    expect(
      (await t.call('GET', `/api/boards/${t.board.id}/activity?limit=0`))
        .status,
    ).toBe(400)
  })
})

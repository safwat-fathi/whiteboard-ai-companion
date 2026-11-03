import http from 'node:http'
import type { Element } from '@whiteboard/core'
import { describe, expect, it } from 'vitest'
import { BoardService } from '../board-service'
import { createBoardsDb, createSettingsDb } from '../db'
import { boot, ORIGIN, sseChunks } from '../http-test-utils'
import type { StubFixture } from './stub'
import { createUndo } from './undo'

const OWNER = { kind: 'human' as const, id: 'owner' }
const TUTOR = { kind: 'agent' as const, id: 'tutor:old' }
const shape = (id: string, x: number) => ({
  batchId: `s-${id}`,
  label: `Add ${id}`,
  ops: [
    {
      op: 'add',
      el: {
        id,
        type: 'shape',
        x,
        y: 0,
        w: 100,
        h: 60,
        rotation: 0,
        z: `a${id}`,
        style: {
          stroke: '#000',
          fill: '#fff',
          strokeWidth: 2,
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
})
const work: StubFixture = {
  match: 'work',
  steps: [
    {
      toolCalls: [
        {
          name: 'add_text',
          input: { text: 'Notes', placement: { x: 0, y: 400 } },
        },
        {
          name: 'add_shape',
          input: { kind: 'rect', placement: { x: 300, y: 400 } },
        },
        {
          name: 'update_elements',
          input: {
            updates: [{ id: 'sel', set: { 'style.stroke': '#ff0000' } }],
          },
        },
        { name: 'delete_elements', input: { ids: ['del'] } },
      ],
    },
    { text: 'done' },
  ],
}

async function setup(fixtures: StubFixture[] = [work]) {
  const t = await boot({ tutor: { fixtures, realTools: true } })
  const board = t.boards.createBoard('B')
  for (const [id, x] of [
    ['sel', 0],
    ['del', 200],
    ['other', 600],
  ] as const)
    t.boards.submit(board.id, shape(id, x), OWNER)
  const strip = (els: Element[]) =>
    els.map(({ v: _v, ...e }) => e).sort((a, b) => a.id.localeCompare(b.id))
  const before = strip(t.boards.scene(board.id).elements)
  const chat = (text: string) =>
    t.json(
      'POST',
      '/api/chat',
      {
        boardId: board.id,
        message: { text },
        context: { selection: ['sel', 'del'] },
      },
      ORIGIN,
    )
  const turnOf = (r: { text: string }) =>
    sseChunks(r.text).find((c) => c.type === 'data-turn')?.data.turnId as string
  const undoTurn = (turnId: string, origin: string | null = ORIGIN) =>
    t.json('POST', `/api/boards/${board.id}/turns/${turnId}/undo`, {}, origin)
  return {
    ...t,
    board,
    strip,
    before,
    chat,
    turnOf,
    undoTurn,
    now: () => strip(t.boards.scene(board.id).elements),
  }
}

describe('Undo this response', () => {
  it('puts the board back exactly as it was, and says how many batches it undid', async () => {
    const t = await setup()
    const turn = t.turnOf(await t.chat('do the work'))
    expect(t.now()).not.toEqual(t.before)
    const r = await t.undoTurn(turn)
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ undone: 4, skipped: 0 })
    expect(t.now()).toEqual(t.before)
  })

  it('a second press does nothing', async () => {
    const t = await setup()
    const turn = t.turnOf(await t.chat('do the work'))
    await t.undoTurn(turn)
    expect((await t.undoTurn(turn)).json).toEqual({ undone: 0, skipped: 0 })
    expect(t.now()).toEqual(t.before)
  })

  it('keeps what the student changed afterwards, and counts it as skipped', async () => {
    const t = await setup()
    const turn = t.turnOf(await t.chat('do the work'))
    // the student recolours the shape the tutor reddened, after the turn
    t.boards.submit(
      t.board.id,
      {
        batchId: 'mine',
        label: 'Blue',
        ops: [{ op: 'patch', id: 'sel', set: { 'style.stroke': '#0000ff' } }],
      },
      OWNER,
    )
    const r = await t.undoTurn(turn)
    expect(r.json).toEqual({ undone: 3, skipped: 1 })
    const sel = t.boards
      .scene(t.board.id)
      .elements.find((e) => e.id === 'sel') as Element
    expect(sel.style.stroke).toBe('#0000ff')
    expect(
      t.boards
        .scene(t.board.id)
        .elements.map((e) => e.id)
        .sort(),
    ).toEqual(['del', 'other', 'sel'])
  })

  it('still works after the server restarted: the inverses are in the database', async () => {
    const t = await setup()
    const turn = t.turnOf(await t.chat('do the work'))
    const fresh = new BoardService(createBoardsDb(t.db))
    const undo = createUndo({ boards: fresh, settings: createSettingsDb(t.db) })
    expect(undo.turn(t.board.id, turn)).toEqual({ undone: 4, skipped: 0 })
    expect(t.strip(fresh.scene(t.board.id).elements)).toEqual(t.before)
  })

  it("an element the tutor removed comes back as the tutor's own, not the student's", async () => {
    const t = await setup([
      {
        match: 'tidy',
        steps: [
          {
            toolCalls: [{ name: 'delete_elements', input: { ids: ['made'] } }],
          },
          { text: 'gone' },
        ],
      },
    ])
    t.boards.submit(
      t.board.id,
      { ...shape('made', 900), batchId: 'made-b' },
      TUTOR,
      'old',
    )
    const turn = t.turnOf(await t.chat('tidy up'))
    expect(
      t.boards.scene(t.board.id).elements.some((e) => e.id === 'made'),
    ).toBe(false)
    await t.undoTurn(turn)
    const back = t.boards
      .scene(t.board.id)
      .elements.find((e) => e.id === 'made') as Element
    expect(back.author).toEqual({ kind: 'agent', id: 'tutor:old' })
  })

  it('undoes one batch of a turn', async () => {
    const t = await setup()
    const r = await t.chat('do the work')
    const batches = sseChunks(r.text)
      .filter((c) => c.type === 'data-batch')
      .map((c) => c.data)
    const res = await t.json(
      'POST',
      `/api/boards/${t.board.id}/batches/${batches[1].batchId}/undo`,
      {},
    )
    expect(res.json).toEqual({ undone: 1, skipped: 0 })
    expect(
      t.boards
        .scene(t.board.id)
        .elements.filter((e) => e.author.kind === 'agent'),
    ).toHaveLength(1) // only the text is left
  })

  it('refuses while the turn is running, an unknown turn, a human batch and a foreign Origin', async () => {
    const t = await setup([
      {
        match: 'slow',
        steps: [{ text: Array(100).fill('word').join(' '), chunkDelayMs: 20 }],
      },
      work,
    ])
    const running = t.chat('slow one')
    await new Promise((r) => setTimeout(r, 100))
    expect((await t.undoTurn('whatever')).status).toBe(409)
    await running
    expect((await t.undoTurn('no-such-turn')).status).toBe(404)
    expect(
      (await t.json('POST', `/api/boards/${t.board.id}/batches/s-sel/undo`, {}))
        .status,
    ).toBe(404)
    const turn = t.turnOf(await t.chat('do the work'))
    expect((await t.undoTurn(turn, 'http://evil.test')).status).toBe(403)
    expect(t.now()).not.toEqual(t.before)
  })

  it('Stop mid-turn keeps whole batches only, and they can still be undone', async () => {
    const t = await setup([
      {
        match: 'stopper',
        steps: [
          {
            toolCalls: [
              {
                name: 'add_shape',
                input: { kind: 'rect', placement: { x: 0, y: 500 } },
              },
            ],
          },
          { text: Array(300).fill('word').join(' '), chunkDelayMs: 10 },
        ],
      },
    ])
    let turn = ''
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: t.port,
          method: 'POST',
          path: '/api/chat',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        },
        (res) => {
          let buf = ''
          res.on('data', (c) => {
            buf += c
            const chunks = sseChunks(buf)
            turn =
              (chunks.find((x) => x.type === 'data-turn')?.data
                .turnId as string) ?? turn
            if (chunks.some((x) => x.type === 'text-delta')) {
              req.destroy()
              resolve()
            }
          })
        },
      )
      req.on('error', () => {})
      req.on('error', reject)
      req.end(
        JSON.stringify({ boardId: t.board.id, message: { text: 'stopper' } }),
      )
    })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && t.tutor?.isBusy(t.board.id))
      await new Promise((r) => setTimeout(r, 25))
    expect(t.boards.scene(t.board.id).elements).toHaveLength(4) // the three student shapes and the tutor's one complete shape
    expect((await t.undoTurn(turn)).json).toEqual({ undone: 1, skipped: 0 })
    expect(t.now()).toEqual(t.before)
  })
})

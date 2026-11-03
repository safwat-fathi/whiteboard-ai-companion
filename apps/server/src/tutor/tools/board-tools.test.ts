import type { Element } from '@whiteboard/core'
import { describe, expect, it } from 'vitest'
import type { Broadcast } from '../../board-service'
import { boot, ORIGIN, sseChunks } from '../../http-test-utils'
import type { StubFixture } from '../stub'

const OWNER = { kind: 'human' as const, id: 'owner' }
const stuShape = (id: string, x: number) => ({
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

async function setup(fixtures: StubFixture[]) {
  const t = await boot({ tutor: { fixtures, realTools: true } })
  const board = t.boards.createBoard('B')
  const heard: Broadcast[] = []
  t.boards.subscribe(board.id, (b) => heard.push(b)) // what a connected socket would receive
  const chat = (text: string, selection: string[] = []) =>
    t.json(
      'POST',
      '/api/chat',
      { boardId: board.id, message: { text }, context: { selection } },
      ORIGIN,
    )
  const scene = () => t.boards.scene(board.id).elements
  const recorded = async () =>
    (await t.call('GET', `/api/_test/last-request?boardId=${board.id}`)).json
      .calls as {
      prompt: { role: string; content: unknown }[]
      tools: string[]
    }[]
  return { ...t, board, heard, chat, scene, recorded }
}

describe('the board tools inside a turn', () => {
  it('draws text, a formula and a shape; each is one batch, authored by the turn, and the socket sees what the chat shows', async () => {
    const t = await setup([
      {
        match: 'draw',
        steps: [
          {
            text: 'I will draw it.',
            toolCalls: [
              {
                name: 'add_text',
                input: { text: 'Light reactions', placement: { x: 0, y: 0 } },
              },
              {
                name: 'add_math',
                input: { latex: 'E = mc^2', placement: { x: 0, y: 100 } },
              },
              {
                name: 'add_shape',
                input: {
                  kind: 'ellipse',
                  label: 'Sun',
                  placement: { x: 0, y: 200 },
                },
              },
            ],
          },
          { text: 'Done.' },
        ],
      },
    ])
    const r = await t.chat('please draw')
    const chunks = sseChunks(r.text)
    const batches = chunks
      .filter((c) => c.type === 'data-batch')
      .map((c) => c.data)
    expect(batches).toHaveLength(3)
    expect(batches.map((b) => b.label)).toEqual([
      'Add text',
      'Add formula',
      'Add ellipse',
    ])
    expect(batches.map((b) => b.count)).toEqual([1, 1, 1])
    expect(new Set(batches.map((b) => b.seq)).size).toBe(3)

    const els = t.scene()
    expect(els).toHaveLength(3)
    const turnId = chunks.find((c) => c.type === 'data-turn')?.data
      .turnId as string
    for (const e of els)
      expect(e.author).toEqual({ kind: 'agent', id: `tutor:${turnId}` })

    // the broadcast a socket gets carries the same batch, author, turn and bounds
    expect(t.heard).toHaveLength(3)
    expect(t.heard.map((h) => h.batch.batchId)).toEqual(
      batches.map((b) => b.batchId),
    )
    expect(t.heard.map((h) => h.bounds)).toEqual(batches.map((b) => b.bounds))
    for (const h of t.heard)
      expect(h).toMatchObject({
        author: { kind: 'agent', id: `tutor:${turnId}` },
        turnId,
      })

    // reload: the stored message still has its chips
    const stored = (await t.call('GET', `/api/boards/${t.board.id}/messages`))
      .json.messages
    expect(
      stored[1].parts.filter((p: { type: string }) => p.type === 'data-batch'),
    ).toHaveLength(3)
  })

  it('parallel tool calls take turns, so automatic placements do not collide', async () => {
    const calls = Array.from({ length: 6 }, () => ({
      name: 'add_shape',
      input: { kind: 'rect', w: 140, h: 70 },
    }))
    const t = await setup([
      { match: 'grid', steps: [{ toolCalls: calls }, { text: 'ok' }] },
    ])
    await t.chat('grid')
    const els = t.scene()
    expect(els).toHaveLength(6)
    for (let i = 0; i < els.length; i++)
      for (let j = i + 1; j < els.length; j++) {
        const [a, b] = [els[i] as Element, els[j] as Element]
        expect(
          a.x < b.x + b.w &&
            a.x + a.w > b.x &&
            a.y < b.y + b.h &&
            a.y + a.h > b.y,
        ).toBe(false)
      }
  })

  it('edit rights: a selected student element can be changed, an unselected one is refused and the model is told why', async () => {
    const t = await setup([
      {
        match: 'edit',
        steps: [
          {
            toolCalls: [
              {
                name: 'update_elements',
                input: {
                  updates: [
                    { id: 'selected', set: { 'style.stroke': '#ff0000' } },
                  ],
                },
              },
              {
                name: 'update_elements',
                input: {
                  updates: [
                    { id: 'other', set: { 'style.stroke': '#ff0000' } },
                  ],
                },
              },
            ],
          },
          { text: 'Done.' },
        ],
      },
    ])
    t.boards.submit(t.board.id, stuShape('selected', 0), OWNER)
    t.boards.submit(t.board.id, stuShape('other', 300), OWNER)
    await t.chat('edit please', ['selected'])
    const by = (id: string) => t.scene().find((e) => e.id === id) as Element
    expect(by('selected').style.stroke).toBe('#ff0000')
    expect(by('other').style.stroke).toBe('#000')
    const second = (await t.recorded())[1]
    expect(JSON.stringify(second?.prompt)).toMatch(
      /belongs to the student and was not selected/,
    )
  })

  it('a bad formula or a bad argument reaches the model as an error and changes nothing', async () => {
    const t = await setup([
      {
        match: 'oops',
        steps: [
          {
            toolCalls: [
              { name: 'add_math', input: { latex: '\\notacommand{x}' } },
              { name: 'add_shape', input: { kind: 'hexagon' } },
              {
                name: 'update_elements',
                input: { updates: [{ id: 'nope', set: { x: 1 } }] },
              },
            ],
          },
          { text: 'sorry' },
        ],
      },
    ])
    const before = t.boards.scene(t.board.id).headSeq
    await t.chat('oops')
    expect(t.boards.scene(t.board.id).headSeq).toBe(before)
    const prompt = JSON.stringify((await t.recorded())[1]?.prompt)
    expect(prompt).toMatch(/latex:/)
    expect(prompt).toMatch(/no element nope/)
    expect(t.heard).toEqual([])
  })

  it('a snapshot comes back as a user message with the picture, not inside the tool result', async () => {
    const t = await setup([
      {
        match: 'look',
        steps: [
          {
            toolCalls: [
              {
                name: 'add_shape',
                input: {
                  kind: 'rect',
                  placement: { x: 0, y: 0 },
                  returnSnapshot: true,
                },
              },
            ],
          },
          { text: 'looks fine' },
        ],
      },
    ])
    await t.chat('look at it')
    const second = (await t.recorded())[1]
    const withPicture = second?.prompt.filter(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some(
          (p: { type: string; bytes?: number }) =>
            p.type === 'file' && (p.bytes ?? 0) > 100,
        ),
    )
    expect(withPicture).toHaveLength(1)
    const toolMsg = second?.prompt.find((m) => m.role === 'tool')
    expect(JSON.stringify(toolMsg)).not.toMatch(/"type":"file"/)
  })

  it('focus_region points without changing the board', async () => {
    const t = await setup([
      {
        match: 'point',
        steps: [
          {
            toolCalls: [
              {
                name: 'focus_region',
                input: {
                  rect: { x: 10, y: 20, w: 300, h: 200 },
                  note: 'this part',
                },
              },
            ],
          },
          { text: 'there' },
        ],
      },
    ])
    const r = await t.chat('point at it')
    const focus = sseChunks(r.text).find((c) => c.type === 'data-focus')
    expect(focus?.data).toEqual({
      bounds: { x: 10, y: 20, w: 300, h: 200 },
      note: 'this part',
    })
    expect(t.heard).toEqual([])
  })
})

import http from 'node:http'
import { tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { boot, ORIGIN, sseChunks } from './http-test-utils'
import type { StubFixture } from './tutor/stub'

const fixtures: StubFixture[] = [
  {
    match: 'hello',
    steps: [
      { text: 'Hi there, student.', usage: { in: 50, cached: 5, out: 8 } },
    ],
  },
  {
    match: 'loop',
    steps: [
      { toolCalls: [{ name: 'ping', input: {} }], usage: { in: 10, out: 10 } },
    ],
  },
  {
    match: 'slow',
    steps: [{ text: Array(200).fill('word').join(' '), chunkDelayMs: 10 }],
  },
]
const ping = () => ({
  tools: {
    ping: tool({
      description: 'ping',
      inputSchema: z.object({}),
      execute: async () => 'pong',
    }),
  },
})

async function setup(o: Parameters<typeof boot>[0] = {}) {
  const t = await boot({ tutor: { fixtures, tools: ping }, ...o })
  const board = t.boards.createBoard('B')
  const chat = (
    text: string,
    boardId = board.id,
    origin: string | null = ORIGIN,
  ) => t.json('POST', '/api/chat', { boardId, message: { text } }, origin)
  const history = async (qs = '') =>
    (await t.call('GET', `/api/boards/${board.id}/messages${qs}`)).json as {
      messages: {
        id: string
        role: string
        parts: { type: string; text?: string }[]
        usage?: Record<string, unknown>
      }[]
      next?: string
    }
  return { ...t, board, chat, history }
}

describe('POST /api/chat', () => {
  it('streams the turn in order, stores both messages, and counts tokens without a price', async () => {
    const t = await setup()
    const r = await t.chat('hello tutor')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toMatch(/text\/event-stream/)
    const chunks = sseChunks(r.text)
    const types = chunks.map((c) => c.type)
    expect(types[0]).toBe('start') // the message exists before any part is attached to it
    expect(chunks[0]?.messageId).toMatch(/:a$/)
    expect(types.indexOf('data-turn')).toBeLessThan(types.indexOf('text-start'))
    expect(types.indexOf('text-end')).toBeLessThan(types.indexOf('data-usage'))
    expect(types.at(-1)).toBe('finish')
    expect(chunks.find((c) => c.type === 'data-status')).toMatchObject({
      data: { state: 'thinking' },
    })
    expect(chunks.filter((c) => c.type === 'data-status').at(-1)).toMatchObject(
      { data: { state: 'done' } },
    )
    const usage = chunks.find((c) => c.type === 'data-usage') as {
      data: Record<string, unknown>
    }
    expect(usage.data).toMatchObject({
      inputTokens: 50,
      cachedTokens: 5,
      outputTokens: 8,
      costUsd: null,
      model: 'stub-tutor',
    })

    const h = await t.history()
    expect(h.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(h.messages[0]?.parts).toEqual([
      { type: 'text', text: 'hello tutor' },
    ])
    expect(h.messages[1]?.parts.find((p) => p.type === 'text')?.text).toBe(
      'Hi there, student.',
    )
    expect(h.messages[1]?.usage).toMatchObject({ outputTokens: 8 })
    expect(r.text).not.toContain('sk-secret-meta-value')
  })

  it('answers turn_busy (409) while a turn runs, and runs the next one after it ends', async () => {
    const t = await setup()
    const first = t.chat('slow please')
    await new Promise((r) => setTimeout(r, 80))
    const second = await t.chat('hello')
    expect(second.status).toBe(409)
    expect(second.json.error.code).toBe('turn_busy')
    expect((await first).status).toBe(200)
    expect((await t.chat('hello again')).status).toBe(200)
  })

  it('MAX_STEPS stops a runaway tool loop with a plain note, stored with the message', async () => {
    const t = await setup({ env: { MAX_STEPS: '2' } })
    const r = await t.chat('loop forever')
    const chunks = sseChunks(r.text)
    expect(
      chunks.filter((c) => c.type === 'tool-input-available'),
    ).toHaveLength(2)
    const h = await t.history()
    const note = h.messages[1]?.parts.find((p) => p.type === 'text')?.text
    expect(note).toMatch(/used its 2 steps/)
  })

  it('a priced MAX_TURN_COST_USD stops the loop and the spend ledger equals tokens x price', async () => {
    const t = await setup({
      env: {
        TUTOR_PRICE_IN_PER_M: '10000',
        TUTOR_PRICE_OUT_PER_M: '10000',
        MAX_TURN_COST_USD: '0.01',
      },
    })
    const r = await t.chat('loop forever')
    expect(
      sseChunks(r.text).filter((c) => c.type === 'tool-input-available'),
    ).toHaveLength(1)
    expect(
      (await t.history()).messages[1]?.parts.find((p) => p.type === 'text')
        ?.text,
    ).toMatch(/cost cap/)
    // 10 in + 10 out at $10,000 per million tokens each = $0.20
    expect(t.booksDb.spentSince(0)).toBeCloseTo(0.2, 10)
    const usage = sseChunks(r.text).find((c) => c.type === 'data-usage') as {
      data: { costUsd: number }
    }
    expect(usage.data.costUsd).toBeCloseTo(0.2, 10)
  })

  it('the daily cap is a plain 429 before any stream, and nothing is stored', async () => {
    const t = await setup({ dailyBudget: '0' })
    const r = await t.chat('hello')
    expect(r.status).toBe(429)
    expect(r.headers['content-type']).toMatch(/application\/json/)
    expect(r.json.error).toMatchObject({
      code: 'budget_exceeded',
      details: { cap: 'daily' },
    })
    expect((await t.history()).messages).toEqual([])
  })

  it('rejects a foreign Origin, an unknown board and a bad body, all before streaming', async () => {
    const t = await setup()
    expect((await t.chat('hello', t.board.id, 'http://evil.test')).status).toBe(
      403,
    )
    const missing = await t.chat('hello', 'nope')
    expect(missing.status).toBe(404)
    const bad = await t.json('POST', '/api/chat', {
      boardId: t.board.id,
      message: { text: '  ' },
    })
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe('validation_failed')
    expect((await t.history()).messages).toEqual([])
  })

  it('without a model key and no stub it says so plainly instead of streaming', async () => {
    const t = await boot({ tutor: {} })
    const board = t.boards.createBoard('B')
    const r = await t.json('POST', '/api/chat', {
      boardId: board.id,
      message: { text: 'hi' },
    })
    expect(r.status).toBe(502)
    expect(r.json.error.message).toMatch(/META_API_KEY/)
    expect(JSON.stringify(r.json)).not.toContain('sk-secret-meta-value')
  })

  it('Stop: closing the connection mid-stream keeps the partial text and frees the board', async () => {
    const t = await setup()
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
          res.once('data', () => {
            req.destroy()
            resolve()
          })
        },
      )
      req.on('error', () => {})
      req.on('error', reject)
      req.end(
        JSON.stringify({
          boardId: t.board.id,
          message: { text: 'slow please' },
        }),
      )
    })
    // the server notices, aborts the model call, stores what it has and releases the lock
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && (await t.history()).messages.length < 2)
      await new Promise((r) => setTimeout(r, 25))
    const h = await t.history()
    expect(h.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    const text = h.messages[1]?.parts.find((p) => p.type === 'text')?.text ?? ''
    expect(text.length).toBeLessThan(Array(200).fill('word').join(' ').length)
    expect((await t.chat('hello')).status).toBe(200)
  })
})

describe('history and models', () => {
  it('pages messages with a cursor and 404s an unknown board', async () => {
    const t = await setup()
    await t.chat('hello one')
    await t.chat('hello two')
    const page1 = await t.history('?limit=3')
    expect(page1.messages).toHaveLength(3)
    expect(page1.next).toBeDefined()
    const page2 = await t.history(`?limit=3&before=${page1.next}`)
    expect(page2.messages).toHaveLength(1)
    expect(page2.next).toBeUndefined()
    expect((await t.call('GET', '/api/boards/nope/messages')).status).toBe(404)
    expect(
      (await t.call('GET', `/api/boards/${t.board.id}/messages?limit=0`))
        .status,
    ).toBe(400)
  })

  it('lists the configured models and records the stub requests for specs', async () => {
    const t = await setup()
    expect((await t.call('GET', '/api/models')).json).toMatchObject({
      tutor: 'muse-spark-1.3',
      priced: false,
    })
    await t.chat('hello recorder')
    const rec = (
      await t.call('GET', `/api/_test/last-request?boardId=${t.board.id}`)
    ).json as {
      calls: { prompt: { role: string; content: unknown }[]; tools: string[] }[]
    }
    expect(rec.calls).toHaveLength(1)
    expect(JSON.stringify(rec.calls[0]?.prompt)).toContain('hello recorder')
    expect(rec.calls[0]?.prompt[0]?.role).toBe('system')
    expect(rec.calls[0]?.tools).toEqual(['ping'])
  })
})

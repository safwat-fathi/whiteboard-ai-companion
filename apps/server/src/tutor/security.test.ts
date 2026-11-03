import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boot, ORIGIN, sseChunks } from '../http-test-utils'
import { createLlm } from './llm'

const KEY = 'sk-live-secret-1234567890'
const servers: ReturnType<typeof createServer>[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  vi.restoreAllMocks()
})

/** A model endpoint that is broken in the worst way: it answers every call with an error that quotes the key it was given. */
async function leakyProvider() {
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(String(req.headers.authorization))
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        error: {
          message: `invalid key ${req.headers.authorization} for ${KEY}`,
        },
      }),
    )
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  return { seen, llm: createLlm({ baseUrl, apiKey: KEY }) }
}

describe('keys never leave the server', () => {
  it('an upstream error that quotes the key reaches neither the chat, the stored messages, the database nor the logs', async () => {
    const logs: string[] = []
    for (const m of ['log', 'error', 'warn', 'info'] as const)
      vi.spyOn(console, m).mockImplementation(
        (...a: unknown[]) => void logs.push(a.map(String).join(' ')),
      )
    const { llm, seen } = await leakyProvider()
    const t = await boot({ tutor: { llm } })
    const board = t.boards.createBoard('B')
    const r = await t.json(
      'POST',
      '/api/chat',
      { boardId: board.id, message: { text: 'hello' } },
      ORIGIN,
    )

    expect(seen.length).toBeGreaterThan(0) // the provider really was called, with the key in its header
    expect(seen[0]).toContain(KEY)
    const error = sseChunks(r.text).find((c) => c.type === 'error')
    expect(JSON.parse(error?.errorText as string)).toEqual({
      code: 'upstream_error',
      message: 'The AI provider failed to answer. Try again.',
    })
    expect(r.text).not.toContain(KEY)

    const stored = (await t.call('GET', `/api/boards/${board.id}/messages`))
      .json
    expect(JSON.stringify(stored)).not.toContain(KEY)

    const tables = (
      t.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((x) => x.name)
    for (const name of tables) {
      const rows = t.db.prepare(`SELECT * FROM "${name}"`).all()
      expect(
        JSON.stringify(rows, (_k, v) =>
          v instanceof Buffer ? v.toString('latin1') : v,
        ),
      ).not.toContain(KEY)
    }
    expect(logs.join('\n')).not.toContain(KEY)
    expect((await t.call('GET', '/api/health')).text).not.toContain(KEY)
    expect((await t.call('GET', '/api/models')).text).not.toContain(KEY)
  }, 30_000) // the SDK retries a 5xx with backoff, so a dead provider takes several seconds to give up

  it("a rate limit or an exhausted quota is worded for the student, never with the provider's own text", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(402, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: { message: `credits gone for account acct_123 key ${KEY}` },
        }),
      )
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const llm = createLlm({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKey: KEY,
    })
    const t = await boot({ tutor: { llm } })
    const board = t.boards.createBoard('B')
    const r = await t.json(
      'POST',
      '/api/chat',
      { boardId: board.id, message: { text: 'hi' } },
      ORIGIN,
    )
    const error = sseChunks(r.text).find((c) => c.type === 'error')
    expect(JSON.parse(error?.errorText as string).message).toBe(
      'The AI provider says its quota or credits are exhausted.',
    )
    expect(r.text).not.toContain('acct_123')
  })
})

import { describe, expect, it } from 'vitest'
import { boot, ORIGIN } from './http-test-utils'
import type { StubFixture } from './tutor/stub'

const fixtures: StubFixture[] = [
  {
    match: '*',
    steps: [{ text: 'hello', usage: { in: 100, cached: 40, out: 10 } }],
  },
]
const evil = 'http://evil.test'

async function setup(o: Parameters<typeof boot>[0] = {}) {
  const t = await boot({ tutor: { fixtures }, ...o })
  const board = t.boards.createBoard('B')
  const chat = (text = 'hi') =>
    t.json(
      'POST',
      '/api/chat',
      { boardId: board.id, message: { text } },
      ORIGIN,
    )
  return { ...t, board, chat }
}

describe('/api/settings', () => {
  it('starts empty, saves the profile and a budget override, and clears them', async () => {
    const t = await setup()
    expect((await t.call('GET', '/api/settings')).json).toEqual({
      profile: '',
      dailyBudgetUsd: null,
    })
    const put = await t.json('PUT', '/api/settings', {
      profile: 'Grade 9, likes diagrams',
      dailyBudgetUsd: 1.5,
    })
    expect(put.status).toBe(200)
    expect(put.json).toEqual({
      profile: 'Grade 9, likes diagrams',
      dailyBudgetUsd: 1.5,
    })
    expect((await t.call('GET', '/api/settings')).json).toEqual(put.json)
    expect((await t.json('PUT', '/api/settings', {})).json).toEqual({
      profile: '',
      dailyBudgetUsd: null,
    })
  })

  it('refuses a bad body and a foreign Origin, and stores nothing', async () => {
    const t = await setup()
    const bad = await t.json('PUT', '/api/settings', {
      profile: 'x'.repeat(2001),
    })
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe('validation_failed')
    expect(
      (await t.json('PUT', '/api/settings', { dailyBudgetUsd: -1 })).status,
    ).toBe(400)
    expect(
      (await t.json('PUT', '/api/settings', { profile: 'hijack' }, evil))
        .status,
    ).toBe(403)
    expect((await t.call('GET', '/api/settings')).json.profile).toBe('')
  })

  it('the profile goes into the cached prefix of the next turn, after the charter', async () => {
    const t = await setup()
    await t.json('PUT', '/api/settings', { profile: 'I am nine years old.' })
    await t.chat()
    const rec = (
      await t.call('GET', `/api/_test/last-request?boardId=${t.board.id}`)
    ).json.calls[0].prompt[0].content as string
    expect(rec).toContain(
      '<student_profile>\nI am nine years old.\n</student_profile>',
    )
    expect(rec.indexOf('<student_profile>')).toBeGreaterThan(
      rec.indexOf('UNTRUSTED DATA'),
    )
  })

  it('a budget override replaces DAILY_BUDGET_USD for the tutor, whichever way it moves', async () => {
    const t = await setup({ dailyBudget: '5' })
    t.booksDb.addSpend({
      at: Date.now(),
      kind: 'embed',
      ref: null,
      costUsd: 0.5,
    })
    expect((await t.chat()).status).toBe(200)
    await t.json('PUT', '/api/settings', { dailyBudgetUsd: 0.25 }) // below what is already spent
    const r = await t.chat()
    expect(r.status).toBe(429)
    expect(r.json.error).toMatchObject({
      code: 'budget_exceeded',
      details: { cap: 'daily', limitUsd: 0.25 },
    })
    await t.json('PUT', '/api/settings', { dailyBudgetUsd: 9 })
    expect((await t.chat()).status).toBe(200)
    await t.json('PUT', '/api/settings', {}) // cleared: back to the configured 5
    expect((await t.chat()).status).toBe(200)
  })
})

describe('GET /api/usage', () => {
  it('sums money by day and kind from the ledger and tokens from the stored replies', async () => {
    const t = await setup({
      env: { TUTOR_PRICE_IN_PER_M: '1000', TUTOR_PRICE_OUT_PER_M: '2000' },
    })
    await t.chat()
    await t.chat()
    const day = new Date().toISOString().slice(0, 10)
    t.booksDb.addSpend({
      at: Date.now(),
      kind: 'embed',
      ref: null,
      costUsd: 0.003,
    })
    t.booksDb.addSpend({
      at: Date.parse('2020-01-02T10:00:00Z'),
      kind: 'embed',
      ref: null,
      costUsd: 0.5,
    })
    const u = (await t.call('GET', '/api/usage')).json
    // two turns of 100 in / 10 out at $1,000 and $2,000 per million tokens: 0.1 + 0.02 each
    expect(u.today).toMatchObject({
      day,
      turns: 2,
      inputTokens: 200,
      cachedTokens: 80,
      outputTokens: 20,
    })
    expect(u.today.byKind.turn).toBeCloseTo(0.24, 10)
    expect(u.today.byKind.embed).toBeCloseTo(0.003, 10)
    expect(u.today.costUsd).toBeCloseTo(0.243, 10)
    expect(u.dailyCapUsd).toBe(5)
    expect(u.days.map((d: { day: string }) => d.day)).toEqual([day]) // the 2020 spend is outside the default two weeks
    const old = (
      await t.call(
        'GET',
        `/api/usage?from=${Date.parse('2020-01-01')}&to=${Date.parse('2020-02-01')}`,
      )
    ).json
    expect(old.days).toMatchObject([
      { day: '2020-01-02', costUsd: 0.5, byKind: { embed: 0.5 }, turns: 0 },
    ])
    expect(old.totalUsd).toBeCloseTo(0.5, 10)
  })

  it('unpriced turns still count tokens, with no money; bad ranges are refused', async () => {
    const t = await setup()
    await t.chat()
    const u = (await t.call('GET', '/api/usage')).json
    expect(u.today).toMatchObject({ turns: 1, inputTokens: 100, costUsd: 0 })
    expect((await t.call('GET', '/api/usage?from=abc')).status).toBe(400)
  })
})

describe('every write the tutor added needs the right Origin', () => {
  it.each([
    [
      'POST',
      '/api/chat',
      (id: string) => ({ boardId: id, message: { text: 'x' } }),
    ],
    ['POST', '/api/boards/ID/context-preview', () => ({ context: {} })],
    ['POST', '/api/boards/ID/turns/t1/undo', () => ({})],
    ['POST', '/api/boards/ID/batches/b1/undo', () => ({})],
    ['PUT', '/api/settings', () => ({ profile: 'x' })],
  ] as const)('%s %s', async (method, path, body) => {
    const t = await setup()
    const r = await t.json(
      method,
      path.replace('ID', t.board.id),
      body(t.board.id),
      evil,
    )
    expect(r.status).toBe(403)
    expect(r.json.error.code).toBe('forbidden_origin')
    expect(
      (await t.call('GET', `/api/boards/${t.board.id}/messages`)).json.messages,
    ).toEqual([])
  })
})

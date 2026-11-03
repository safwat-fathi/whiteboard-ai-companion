import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createBoardsDb } from './boards'
import { openDatabase } from './index'
import { createMessagesDb, type NewMessage } from './messages'
import { createSettingsDb } from './settings'

const dirs: string[] = []
const dbs: Database.Database[] = []
afterEach(() => {
  for (const d of dbs.splice(0)) if (d.open) d.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function open() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-msg-'))
  dirs.push(dir)
  const db = openDatabase({ dataDir: dir })
  dbs.push(db)
  const boards = createBoardsDb(db)
  boards.createBoard({ id: 'b', title: 'B' }, 1)
  boards.createBoard({ id: 'c', title: 'C' }, 1)
  return { db, messages: createMessagesDb(db), settings: createSettingsDb(db) }
}
const msg = (i: number, over: Partial<NewMessage> = {}): NewMessage => ({
  id: `m${String(i).padStart(3, '0')}`,
  boardId: 'b',
  turnId: `t${Math.ceil(i / 2)}`,
  role: i % 2 ? 'user' : 'assistant',
  parts: [{ type: 'text', text: `hello ${i}` }],
  createdAt: 100, // identical times: order must come from insertion, not the clock
  ...over,
})

describe('messages', () => {
  it('round-trips parts, context, model and usage', () => {
    const { messages } = open()
    const usage = {
      inputTokens: 5,
      cachedTokens: 1,
      outputTokens: 7,
      costUsd: null,
      model: 'm',
    }
    messages.append(msg(1, { context: { selection: ['a'] } }))
    messages.append(msg(2, { model: 'm', usage }))
    const [u, a] = messages.byTurn('b', 't1')
    expect(u).toMatchObject({ role: 'user', context: { selection: ['a'] } })
    expect(u && 'usage' in u).toBe(false)
    expect(a).toMatchObject({
      role: 'assistant',
      model: 'm',
      usage,
      parts: [{ type: 'text', text: 'hello 2' }],
    })
  })

  it('pages newest-first windows, oldest to newest inside a page, with a cursor', () => {
    const { messages } = open()
    for (let i = 1; i <= 7; i++) messages.append(msg(i))
    messages.append(msg(99, { boardId: 'c' }))
    const first = messages.page('b', { limit: 3 })
    expect(first.messages.map((m) => m.id)).toEqual(['m005', 'm006', 'm007'])
    expect(first.next).toBe('m005')
    const second = messages.page('b', { limit: 3, before: first.next })
    expect(second.messages.map((m) => m.id)).toEqual(['m002', 'm003', 'm004'])
    const last = messages.page('b', { limit: 3, before: second.next })
    expect(last.messages.map((m) => m.id)).toEqual(['m001'])
    expect(last.next).toBeUndefined()
  })

  it('an unknown cursor or another board id gives an empty page, not a leak', () => {
    const { messages } = open()
    messages.append(msg(1))
    messages.append(msg(2, { boardId: 'c', id: 'other' }))
    expect(messages.page('b', { before: 'other' }).messages).toEqual([])
    expect(messages.page('b', { before: 'nope' }).messages).toEqual([])
  })

  it('refuses a message for an unknown board and cascades with the board', () => {
    const { db, messages } = open()
    expect(() => messages.append(msg(1, { boardId: 'zzz' }))).toThrow()
    messages.append(msg(1))
    db.prepare("DELETE FROM boards WHERE id = 'b'").run()
    expect(messages.page('b', {}).messages).toEqual([])
  })
})

describe('settings', () => {
  it('gets, sets, overwrites and deletes a key', () => {
    const { settings } = open()
    expect(settings.get('profile')).toBeUndefined()
    settings.set('profile', 'grade 9')
    settings.set('profile', 'grade 10')
    expect(settings.get('profile')).toBe('grade 10')
    settings.delete('profile')
    expect(settings.get('profile')).toBeUndefined()
  })
})

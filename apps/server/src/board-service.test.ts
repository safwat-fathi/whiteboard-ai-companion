import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyBatch, createScene, type Element } from '@whiteboard/core'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { type Author, BoardService, type Broadcast } from './board-service'
import { createBoardsDb, openDatabase } from './db'

const OWNER: Author = { kind: 'human', id: 'owner' }
const roots: string[] = []
const dbs: Database.Database[] = []
let clock = 1_000
const setup = (
  o: ConstructorParameters<typeof BoardService>[1] = {},
  dataDir?: string,
) => {
  let dir = dataDir
  if (!dir) {
    const root = mkdtempSync(join(tmpdir(), 'wb-svc-'))
    roots.push(root)
    dir = join(root, 'data')
  }
  const db = openDatabase({ dataDir: dir })
  dbs.push(db)
  const boardsDb = createBoardsDb(db)
  const svc = new BoardService(boardsDb, { now: () => clock, ...o })
  return { dir, db, boardsDb, svc }
}
afterEach(() => {
  clock = 1_000
  for (const d of dbs.splice(0)) if (d.open) d.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

let n = 0
const rect = (id: string, over: Record<string, unknown> = {}): Element =>
  ({
    id,
    type: 'shape',
    x: 10,
    y: 20,
    w: 100,
    h: 50,
    rotation: 0,
    z: `a${String(n++).padStart(6, '0')}`,
    style: {
      stroke: '#000',
      fill: null,
      strokeWidth: 2,
      opacity: 1,
      dash: 'solid',
    },
    locked: false,
    author: { kind: 'human', id: 'client-claims-this' },
    v: 0,
    data: { kind: 'rect' },
    ...over,
  }) as Element
const add = (id: string, over: Record<string, unknown> = {}) => ({
  batchId: `b-${id}-${n++}`,
  label: `Add ${id}`,
  ops: [{ op: 'add', el: rect(id, over) }],
})
const patch = (id: string, set: Record<string, unknown>) => ({
  batchId: `p-${id}-${n++}`,
  label: 'Edit',
  ops: [{ op: 'patch', id, set }],
})
const replay = (b: ReturnType<typeof setup>, id: string) => {
  const s = createScene()
  for (const r of b.boardsDb.opsAfter(id, 0))
    applyBatch(s, { batchId: r.batchId, label: r.label, ops: r.ops })
  return [...s.els.values()]
}

describe('submit', () => {
  it('stamps consecutive seqs for interleaved authors and the log replays to the live scene', () => {
    const t = setup()
    const { id } = t.svc.createBoard('B')
    const agent: Author = { kind: 'agent', id: 'tutor:t1' }
    const seqs: number[] = []
    for (let i = 0; i < 50; i++)
      seqs.push(
        t.svc.submit(
          id,
          add(`e${i}`),
          i % 2 ? OWNER : agent,
          i % 2 ? undefined : 't1',
        ).seq,
      )
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(replay(t, id)).toEqual(t.svc.scene(id).elements)
    expect(t.boardsDb.opsAfter(id, 0)[0]).toMatchObject({
      authorKind: 'agent',
      turnId: 't1',
    })
  })

  it('same-field race: the later submit wins and the log says so', () => {
    const t = setup()
    const { id } = t.svc.createBoard('B')
    t.svc.submit(id, add('r'), OWNER)
    t.svc.submit(id, patch('r', { 'style.fill': '#ff0000' }), OWNER)
    t.svc.submit(id, patch('r', { 'style.fill': '#00ff00' }), OWNER)
    expect(t.svc.scene(id).elements[0]?.style.fill).toBe('#00ff00')
    expect(replay(t, id)[0]?.style.fill).toBe('#00ff00')
  })

  it('a batch whose second op is invalid stores nothing and broadcasts nothing', () => {
    const t = setup()
    const { id } = t.svc.createBoard('B')
    const got: Broadcast[] = []
    t.svc.subscribe(id, (b) => got.push(b))
    const bad = {
      batchId: 'x',
      label: 'x',
      ops: [
        { op: 'add', el: rect('ok') },
        {
          op: 'add',
          el: rect('bad', {
            style: {
              stroke: '#000',
              fill: null,
              strokeWidth: 2,
              opacity: 5,
              dash: 'solid',
            },
          }),
        },
      ],
    }
    expect(() => t.svc.submit(id, bad, OWNER)).toThrow(
      expect.objectContaining({
        code: 'validation_failed',
        details: { field: 'style.opacity' },
      }),
    )
    expect(t.svc.scene(id)).toEqual({ headSeq: 0, elements: [] })
    expect(t.boardsDb.opsAfter(id, 0)).toEqual([])
    expect(got).toEqual([])
    expect(() => t.svc.submit(id, { nonsense: true }, OWNER)).toThrow(
      expect.objectContaining({ code: 'validation_failed' }),
    )
  })

  it('R7: a batch whose every op is dropped is a no-op; a mixed batch stores only what took effect', () => {
    const t = setup()
    const { id } = t.svc.createBoard('B')
    t.svc.submit(id, add('a'), OWNER)
    const ghost = t.svc.submit(id, patch('ghost', { x: 5 }), OWNER)
    expect(ghost).toEqual({ seq: 1, noop: true, broadcast: null })
    expect(t.boardsDb.getBoard(id)?.headSeq).toBe(1)
    const mixed = t.svc.submit(
      id,
      {
        batchId: 'm',
        label: 'm',
        ops: [
          { op: 'add', el: rect('b') },
          { op: 'patch', id: 'ghost', set: { x: 1 } },
        ],
      },
      OWNER,
    )
    expect(mixed.seq).toBe(2)
    expect(t.boardsDb.opsAfter(id, 1)[0]?.touchedIds).toEqual(['b'])
  })

  it('computes bounds: after-state for add and patch, before-state for remove', () => {
    const t = setup()
    const { id } = t.svc.createBoard('B')
    const a = t.svc.submit(id, add('a'), OWNER)
    expect(a.broadcast?.bounds).toEqual({ x: 10, y: 20, w: 100, h: 50 })
    const p = t.svc.submit(id, patch('a', { x: 50 }), OWNER)
    expect(p.broadcast?.bounds).toEqual({ x: 50, y: 20, w: 100, h: 50 })
    const r = t.svc.submit(
      id,
      { batchId: 'r', label: 'r', ops: [{ op: 'remove', id: 'a' }] },
      OWNER,
    )
    expect(r.broadcast?.bounds).toEqual({ x: 50, y: 20, w: 100, h: 50 })
  })

  it('stamps the channel author on new elements, whatever the client claimed', () => {
    const t = setup()
    const { id } = t.svc.createBoard('B')
    const r = t.svc.submit(id, add('a'), OWNER)
    expect(t.svc.scene(id).elements[0]?.author).toEqual(OWNER)
    expect(r.broadcast?.author).toEqual(OWNER)
    expect(replay(t, id)[0]?.author).toEqual(OWNER)
    t.svc.submit(id, add('b'), { kind: 'agent', id: 'tutor:t9' }, 't9')
    expect(t.svc.scene(id).elements[1]?.author).toEqual({
      kind: 'agent',
      id: 'tutor:t9',
    })
  })

  it('refuses an unknown board', () => {
    const { svc } = setup()
    expect(() => svc.submit('nope', add('a'), OWNER)).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    )
    expect(() => svc.subscribe('nope', () => {})).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    )
  })

  it('drops the in-memory board when the database write fails, so memory never runs ahead of disk', () => {
    const t = setup()
    const { id } = t.svc.createBoard('B')
    let fail = true
    const flaky = {
      ...t.boardsDb,
      appendBatch: (...a: Parameters<typeof t.boardsDb.appendBatch>) => {
        if (fail) throw new Error('disk full')
        return t.boardsDb.appendBatch(...a)
      },
    }
    const svc = new BoardService(flaky, { now: () => clock })
    expect(() => svc.submit(id, add('a'), OWNER)).toThrow('disk full')
    fail = false
    expect(svc.scene(id)).toEqual({ headSeq: 0, elements: [] }) // reloaded from the database, not the lost write
    expect(svc.submit(id, add('b'), OWNER).seq).toBe(1)
  })

  it('a throwing subscriber does not break the write or the other subscribers', () => {
    const t = setup()
    const { id } = t.svc.createBoard('B')
    const got: number[] = []
    t.svc.subscribe(id, () => {
      throw new Error('boom')
    })
    t.svc.subscribe(id, (b) => got.push(b.seq))
    expect(t.svc.submit(id, add('a'), OWNER).seq).toBe(1)
    expect(got).toEqual([1])
  })

  it('unsubscribe stops delivery', () => {
    const t = setup()
    const { id } = t.svc.createBoard('B')
    const got: number[] = []
    const off = t.svc.subscribe(id, (b) => got.push(b.seq))
    t.svc.submit(id, add('a'), OWNER)
    off()
    t.svc.submit(id, add('b'), OWNER)
    expect(got).toEqual([1])
  })
})

describe('limits (R10)', () => {
  it('accepts 500 ops and refuses 501 with nothing stored', () => {
    const t = setup()
    const { id } = t.svc.createBoard('B')
    const many = (k: number) => ({
      batchId: `many-${k}`,
      label: 'many',
      ops: Array.from({ length: k }, (_, i) => ({
        op: 'add',
        el: rect(`m${k}-${i}`),
      })),
    })
    expect(t.svc.submit(id, many(500), OWNER).seq).toBe(1)
    expect(() => t.svc.submit(id, many(501), OWNER)).toThrow(
      expect.objectContaining({
        code: 'validation_failed',
        details: { limit: 'ops' },
      }),
    )
    expect(t.boardsDb.getBoard(id)?.headSeq).toBe(1)
  })

  it('accepts 50,000 elements and refuses the 50,001st', {
    timeout: 60_000,
  }, () => {
    const t = setup({ snapshotEvery: 1_000_000 })
    const { id } = t.svc.createBoard('B')
    for (let k = 0; k < 100; k++)
      t.svc.submit(
        id,
        {
          batchId: `bulk-${k}`,
          label: 'bulk',
          ops: Array.from({ length: 500 }, (_, i) => ({
            op: 'add',
            el: rect(`b${k}-${i}`),
          })),
        },
        OWNER,
      )
    expect(t.svc.scene(id).elements).toHaveLength(50_000)
    expect(() => t.svc.submit(id, add('one-more'), OWNER)).toThrow(
      expect.objectContaining({ details: { limit: 'elements' } }),
    )
  })

  it('keeps coordinates within +-1,000,000 on add and patch', () => {
    const t = setup()
    const { id } = t.svc.createBoard('B')
    const refused = (b: unknown) =>
      expect(() => t.svc.submit(id, b, OWNER)).toThrow(
        expect.objectContaining({ code: 'validation_failed' }),
      )
    refused(add('far', { x: 1_000_001 }))
    refused(add('neg', { w: -1_000_001 }))
    refused(add('inf', { x: Number.POSITIVE_INFINITY }))
    refused(
      add('line', {
        data: {
          kind: 'line',
          points: [
            [0, 0],
            [2_000_000, 0],
          ],
        },
      }),
    )
    expect(t.svc.submit(id, add('edge', { x: 1_000_000 }), OWNER).seq).toBe(1)
    refused(patch('edge', { x: 1_000_001 }))
    refused(patch('edge', { w: -1_000_001 }))
    expect(t.svc.submit(id, patch('edge', { x: -1_000_000 }), OWNER).seq).toBe(
      2,
    )
  })
})

describe('restart and snapshots', () => {
  const fill = (t: ReturnType<typeof setup>, id: string, count: number) => {
    for (let i = 0; i < count; i++) {
      t.svc.submit(id, add(`e${i}`), OWNER)
      if (i % 3 === 0) t.svc.submit(id, patch(`e${i}`, { x: i }), OWNER)
    }
  }

  it('restores an identical scene from ops alone', () => {
    const a = setup({ snapshotEvery: 1_000_000 })
    const { id } = a.svc.createBoard('B')
    fill(a, id, 30)
    const before = a.svc.scene(id)
    expect(a.boardsDb.latestSnapshot(id)).toBeUndefined()
    const b = setup({}, a.dir) // a new process over the same database file
    expect(b.svc.scene(id)).toEqual(before)
  })

  it('restores an identical scene from a snapshot plus a tail, even without a clean close', () => {
    const a = setup({ snapshotEvery: 20 })
    const { id } = a.svc.createBoard('B')
    fill(a, id, 30) // 40 batches: snapshots at 20 and 40, tail of 0; add 5 more for a tail
    for (let i = 100; i < 105; i++) a.svc.submit(id, add(`t${i}`), OWNER)
    const before = a.svc.scene(id)
    expect(a.boardsDb.latestSnapshot(id)?.seq).toBeLessThan(before.headSeq)
    a.db.close() // crash: no service.close()
    const b = setup({}, a.dir)
    expect(b.svc.scene(id)).toEqual(before)
  })

  it('writes a snapshot every snapshotEvery batches', () => {
    const t = setup({ snapshotEvery: 5 })
    const { id } = t.svc.createBoard('B')
    for (let i = 0; i < 12; i++) t.svc.submit(id, add(`e${i}`), OWNER)
    expect(t.boardsDb.latestSnapshot(id)?.seq).toBe(10)
  })

  it('close() snapshots at head; tick() snapshots after snapshotAfterMs and evicts idle boards', () => {
    const t = setup({
      snapshotEvery: 1_000_000,
      snapshotAfterMs: 5 * 60_000,
      idleEvictMs: 10 * 60_000,
    })
    const { id } = t.svc.createBoard('B')
    for (let i = 0; i < 3; i++) t.svc.submit(id, add(`e${i}`), OWNER)
    t.svc.tick()
    expect(t.boardsDb.latestSnapshot(id)).toBeUndefined() // too soon
    clock += 5 * 60_000
    t.svc.tick()
    expect(t.boardsDb.latestSnapshot(id)?.seq).toBe(3)
    expect(t.svc.activeCount()).toBe(1) // idle for 5 minutes only
    clock += 5 * 60_000
    t.svc.tick()
    expect(t.svc.activeCount()).toBe(0)
    expect(t.svc.scene(id).elements).toHaveLength(3) // reloads identically
    t.svc.submit(id, add('late'), OWNER)
    t.svc.close()
    expect(t.boardsDb.latestSnapshot(id)?.seq).toBe(4)
  })

  it('does not evict a board that still has a subscriber', () => {
    const t = setup({ idleEvictMs: 10 * 60_000 })
    const { id } = t.svc.createBoard('B')
    t.svc.subscribe(id, () => {})
    clock += 60 * 60_000
    t.svc.tick()
    expect(t.svc.activeCount()).toBe(1)
  })
})

describe('join', () => {
  it('returns only the missed ops, a snapshot plus tail when the client is behind it, and a snapshot when it is ahead', () => {
    const t = setup({ snapshotEvery: 40 })
    const { id } = t.svc.createBoard('B')
    for (let i = 0; i < 50; i++) t.svc.submit(id, add(`e${i}`), OWNER)
    // snapshot at 40, head 50
    expect(t.svc.join(id, 50)).toEqual({ headSeq: 50, ops: [] })
    const tail = t.svc.join(id, 45)
    expect(tail.snapshot).toBeUndefined()
    expect(tail.ops.map((o) => o.seq)).toEqual([46, 47, 48, 49, 50])
    const behind = t.svc.join(id, 10)
    expect(behind.snapshot?.seq).toBe(40)
    expect(behind.snapshot?.scene).toHaveLength(40)
    expect(behind.ops.map((o) => o.seq)).toEqual([
      41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
    ])
    const ahead = t.svc.join(id, 999)
    expect(ahead.snapshot).toMatchObject({ seq: 50 })
    expect(ahead.snapshot?.scene).toHaveLength(50)
    expect(ahead.ops).toEqual([])
  })

  it('without a snapshot, joins from 0 with every op, each carrying author and bounds', () => {
    const t = setup({ snapshotEvery: 1_000_000 })
    const { id } = t.svc.createBoard('B')
    for (let i = 0; i < 3; i++) t.svc.submit(id, add(`e${i}`), OWNER)
    const j = t.svc.join(id, 0)
    expect(j.snapshot).toBeUndefined()
    expect(j.ops).toHaveLength(3)
    expect(j.ops[0]).toMatchObject({
      seq: 1,
      author: OWNER,
      bounds: { x: 10, y: 20, w: 100, h: 50 },
    })
  })

  it('rejects a negative or fractional fromSeq and an unknown board', () => {
    const t = setup()
    const { id } = t.svc.createBoard('B')
    expect(() => t.svc.join(id, -1)).toThrow(
      expect.objectContaining({ code: 'validation_failed' }),
    )
    expect(() => t.svc.join(id, 1.5)).toThrow(
      expect.objectContaining({ code: 'validation_failed' }),
    )
    expect(() => t.svc.join('nope', 0)).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    )
  })
})

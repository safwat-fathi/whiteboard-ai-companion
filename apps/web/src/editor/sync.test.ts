// @vitest-environment jsdom
import {
  type Batch,
  DEFAULT_STYLE,
  type Element,
  type Op,
} from '@whiteboard/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from './editor'
import { createSyncClient, type ServerBatchHook, type SyncStatus } from './sync'
import { setup } from './test-utils'

// A WebSocket stand-in the test drives by hand.
class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  // biome-ignore lint/suspicious/noExplicitAny: wire messages are inspected loosely
  sent: Record<string, any>[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error('socket is not open')
    this.sent.push(JSON.parse(data))
  }
  close(code = 1000) {
    this.readyState = 3
    this.onclose?.({ code })
  }
  // test side
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  deliver(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }
  ofType(t: string) {
    return this.sent.filter((m) => m.type === t)
  }
}
const sock = () => FakeSocket.instances.at(-1) as FakeSocket

const OWNER = { kind: 'human' as const, id: 'owner' }
const shape = (id: string, over: Partial<Element> = {}): Element =>
  ({
    id,
    type: 'shape',
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    rotation: 0,
    z: 'a0',
    style: { ...DEFAULT_STYLE },
    locked: false,
    author: OWNER,
    v: 0,
    data: { kind: 'rect' },
    ...over,
  }) as Element
let bn = 0
const batch = (label: string, ...ops: Op[]): Batch => ({
  batchId: `b${bn++}`,
  label,
  ops,
})
const add = (id: string) => batch(`Add ${id}`, { op: 'add', el: shape(id) })
const fill = (id: string, color: string) =>
  batch('Fill', { op: 'patch', id, set: { 'style.fill': color } })
const bc = (seq: number, b: Batch) => ({
  type: 'ops',
  seq,
  batch: b,
  author: OWNER,
  bounds: null,
})
const sync = (
  headSeq: number,
  ops: ReturnType<typeof bc>[] = [],
  snapshot?: { seq: number; scene: Element[] },
) => ({
  type: 'sync',
  headSeq,
  ops,
  ...(snapshot ? { snapshot } : {}),
})
const fillOf = (ed: Editor, id: string) => ed.scene.els.get(id)?.style.fill
const strip = (ed: Editor) =>
  [...ed.scene.els.values()]
    .map(({ v: _v, ...e }) => e)
    .sort((a, b) => a.id.localeCompare(b.id))

let ed: Editor
let done: () => void
let statuses: [SyncStatus, string | undefined][]
let notices: string[]
beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.instances = []
  bn = 0
  ;({ ed, done } = setup())
  ed.author = OWNER
  statuses = []
  notices = []
  ed.onNotice = (m) => notices.push(m)
})
afterEach(() => {
  done()
  vi.useRealTimers()
})

function start(
  opts: {
    backoff?: { minMs: number; maxMs: number }
    onServerBatch?: ServerBatchHook
  } = {},
) {
  const c = createSyncClient({
    url: 'ws://127.0.0.1:4000/ws?boardId=b1',
    boardId: 'b1',
    editor: ed,
    onStatus: (s, d) => statuses.push([s, d]),
    WebSocketImpl: FakeSocket as never,
    ...opts,
  })
  c.start()
  return c
}
/** Opens the socket and answers its join with an empty board at head 0 (or the given sync). */
function live(msg: ReturnType<typeof sync> = sync(0)) {
  sock().open()
  sock().deliver(msg)
}

describe('connecting and syncing', () => {
  it('joins on open from seq 0 and applies the server tail; status goes connecting then live', () => {
    start()
    expect(statuses.map((s) => s[0])).toEqual(['connecting'])
    sock().open()
    expect(sock().sent).toEqual([{ type: 'join', boardId: 'b1', fromSeq: 0 }])
    sock().deliver(sync(2, [bc(1, add('a')), bc(2, add('b'))]))
    expect([...ed.scene.els.keys()].sort()).toEqual(['a', 'b'])
    expect(statuses.map((s) => s[0])).toEqual(['connecting', 'live'])
    expect(ed.undo.canUndo).toBe(false) // the server's history is nobody's undo entry
  })

  it('a snapshot replaces the scene and keeps the local undo stack', () => {
    ed.commit(add('mine'))
    expect(ed.undo.canUndo).toBe(true)
    start()
    live(sync(9, [], { seq: 9, scene: [shape('x'), shape('y')] }))
    expect([...ed.scene.els.keys()].sort()).toEqual(['x', 'y'])
    expect(ed.undo.canUndo).toBe(true)
  })

  it('ignores garbage, unknown message types and an ack for nothing', () => {
    start()
    live()
    sock().onmessage?.({ data: '{nope' })
    sock().deliver({ type: 'launch' })
    sock().deliver({ type: 'ack', clientSeq: 99, seq: 5 })
    expect(statuses.at(-1)?.[0]).toBe('live')
  })
})

describe('sending local edits', () => {
  it('sends ops with increasing clientSeq and records the last seq it learned (ack)', () => {
    start()
    live()
    ed.commit(add('a'))
    ed.commit(add('b'))
    expect(
      sock()
        .ofType('ops')
        .map((m) => m.clientSeq),
    ).toEqual([1, 2])
    expect(sock().ofType('ops')[0]?.batch.ops[0].el.id).toBe('a')
    sock().deliver({ type: 'ack', clientSeq: 1, seq: 5 })
    sock().deliver({ type: 'ack', clientSeq: 2, seq: 6 })
    sock().drop()
    vi.advanceTimersByTime(500)
    sock().open()
    expect(sock().sent.at(-1)).toEqual({
      type: 'join',
      boardId: 'b1',
      fromSeq: 6,
    })
  })

  it('sends undo and redo as ordinary batches', () => {
    start()
    live()
    ed.commit(add('a'))
    ed.undoOnce()
    ed.redoOnce()
    const ops = sock().ofType('ops')
    expect(ops).toHaveLength(3)
    expect(ops[1]?.batch.ops).toEqual([{ op: 'remove', id: 'a' }])
    expect(ops[2]?.batch.ops[0].op).toBe('add')
  })

  it('does not send ops if committed after open but before sync; flushes after sync', () => {
    start()
    sock().open()
    ed.commit(add('early'))
    expect(sock().ofType('ops')).toEqual([])
    sock().deliver(sync(0))
    expect(sock().ofType('ops')).toHaveLength(1)
    expect(sock().ofType('ops')[0]?.batch.ops[0].el.id).toBe('early')
  })
})

describe('concurrent edits converge to the server order (Review Focus 1)', () => {
  it('a remote patch of the same field that the server applied FIRST: we end with ours, the later one', () => {
    start()
    live(sync(1, [bc(1, add('r'))]))
    ed.commit(fill('r', '#aaaaaa')) // pending, clientSeq 1
    expect(fillOf(ed, 'r')).toBe('#aaaaaa')
    sock().deliver(bc(10, fill('r', '#bbbbbb'))) // the server applied theirs before ours
    expect(fillOf(ed, 'r')).toBe('#aaaaaa') // rolled back, theirs applied, ours replayed on top
    sock().deliver({ type: 'ack', clientSeq: 1, seq: 11 })
    expect(fillOf(ed, 'r')).toBe('#aaaaaa')
  })

  it('a remote patch the server applied AFTER ours (our ack came first): we end with theirs', () => {
    start()
    live(sync(1, [bc(1, add('r'))]))
    ed.commit(fill('r', '#aaaaaa'))
    sock().deliver({ type: 'ack', clientSeq: 1, seq: 10 })
    sock().deliver(bc(11, fill('r', '#bbbbbb')))
    expect(fillOf(ed, 'r')).toBe('#bbbbbb')
  })

  it('a remote add while two local batches are pending keeps all three, and the pending ones are still sent once', () => {
    start()
    live()
    ed.commit(add('m1'))
    ed.commit(add('m2'))
    sock().deliver(bc(7, add('theirs')))
    expect([...ed.scene.els.keys()].sort()).toEqual(['m1', 'm2', 'theirs'])
    expect(sock().ofType('ops')).toHaveLength(2) // the replay is local only
  })

  it('a pending patch to an element the remote removed is dropped quietly and nothing throws', () => {
    start()
    live(sync(1, [bc(1, add('r'))]))
    ed.commit(batch('Move', { op: 'patch', id: 'r', set: { x: 5 } }))
    expect(() =>
      sock().deliver(bc(2, batch('Del', { op: 'remove', id: 'r' }))),
    ).not.toThrow()
    expect(ed.scene.els.size).toBe(0)
    sock().deliver({ type: 'ack', clientSeq: 1, seq: 3 })
    expect(ed.scene.els.size).toBe(0)
  })

  it('a pending add the remote also made (same id) is dropped with a notice, and the remote one stays', () => {
    start()
    live()
    ed.commit(add('dup'))
    sock().deliver(bc(1, add('dup')))
    expect(ed.scene.els.size).toBe(1)
    expect(notices.some((n) => /dropped/i.test(n))).toBe(true)
  })

  it('editor and server agree element for element (ignoring v) after a mixed sequence', () => {
    start()
    live(sync(1, [bc(1, add('r'))]))
    ed.commit(fill('r', '#111111'))
    ed.commit(add('mine'))
    sock().deliver(bc(5, fill('r', '#222222')))
    sock().deliver({ type: 'ack', clientSeq: 1, seq: 6 })
    sock().deliver({ type: 'ack', clientSeq: 2, seq: 7 })
    // the server's order: add r (1), remote fill (5), our fill (6), our add (7)
    const server = [
      shape('r', { style: { ...DEFAULT_STYLE, fill: '#111111' } }),
      shape('mine'),
    ]
      .map(({ v: _v, ...e }) => e)
      .sort((a, b) => a.id.localeCompare(b.id))
    expect(strip(ed)).toEqual(server)
  })
})

describe('reject', () => {
  it('rolls the rejected batch back, replays the later pending one, and tells the user why', () => {
    start()
    live()
    ed.commit(add('a'))
    ed.commit(add('b'))
    sock().deliver({
      type: 'reject',
      clientSeq: 1,
      reason: { code: 'validation_failed', message: 'x is out of range' },
    })
    expect([...ed.scene.els.keys()]).toEqual(['b'])
    expect(notices.some((n) => n.includes('x is out of range'))).toBe(true)
    sock().deliver({ type: 'ack', clientSeq: 2, seq: 4 })
    expect([...ed.scene.els.keys()]).toEqual(['b'])
  })

  it('restores the exact pre-batch state of a patched element', () => {
    start()
    live(sync(1, [bc(1, add('r'))]))
    const before = strip(ed)
    ed.commit(fill('r', '#ff0000'))
    sock().deliver({
      type: 'reject',
      clientSeq: 1,
      reason: { code: 'validation_failed', message: 'no' },
    })
    expect(strip(ed)).toEqual(before)
  })
})

describe('offline, reconnect and resend', () => {
  it('goes offline on a drop, reconnects with exponential backoff, and is live again after a sync', () => {
    start({ backoff: { minMs: 500, maxMs: 2000 } })
    live()
    sock().drop()
    expect(statuses.at(-1)?.[0]).toBe('offline')
    expect(FakeSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(499)
    expect(FakeSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(2)
    sock().drop() // never opened
    vi.advanceTimersByTime(999)
    expect(FakeSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1) // 1000 ms: the delay doubled
    expect(FakeSocket.instances).toHaveLength(3)
    sock().drop()
    vi.advanceTimersByTime(2000) // capped at 2000
    expect(FakeSocket.instances).toHaveLength(4)
    sock().drop()
    vi.advanceTimersByTime(1999)
    expect(FakeSocket.instances).toHaveLength(4)
    vi.advanceTimersByTime(1) // still 2000: it stays at the cap
    expect(FakeSocket.instances).toHaveLength(5)
    live()
    expect(statuses.at(-1)?.[0]).toBe('live')
  })

  it('edits made while offline queue, and are sent after the sync in order', () => {
    start()
    live()
    sock().drop()
    ed.commit(add('x'))
    ed.commit(add('y'))
    vi.advanceTimersByTime(500)
    sock().open()
    expect(sock().ofType('ops')).toEqual([]) // not before the server's tail is applied
    sock().deliver(sync(3, [bc(3, add('theirs'))]))
    expect(
      sock()
        .ofType('ops')
        .map((m) => m.batch.ops[0].el.id),
    ).toEqual(['x', 'y'])
    expect([...ed.scene.els.keys()].sort()).toEqual(['theirs', 'x', 'y'])
  })

  it('does not resend or replay a batch the server already applied whose ack was lost', () => {
    start()
    live()
    const mine = add('a')
    ed.commit(mine) // sent; the connection dies before the ack arrives
    expect(sock().ofType('ops')).toHaveLength(1)
    sock().drop()
    vi.advanceTimersByTime(500)
    sock().open()
    sock().deliver(sync(1, [bc(1, mine)])) // the server's tail contains it
    expect(ed.scene.els.size).toBe(1)
    expect(sock().ofType('ops')).toEqual([])
    expect(notices).toEqual([])
  })

  it('a join after an offline gap sends the last seq the client saw', () => {
    start()
    live(sync(4, [bc(4, add('a'))]))
    sock().drop()
    vi.advanceTimersByTime(500)
    sock().open()
    expect(sock().sent).toEqual([{ type: 'join', boardId: 'b1', fromSeq: 4 }])
  })

  it('records headSeq from a sync with no ops so the next rejoin sends fromSeq', () => {
    start()
    live(sync(7, []))
    sock().drop()
    vi.advanceTimersByTime(500)
    sock().open()
    expect(sock().sent.at(-1)).toEqual({
      type: 'join',
      boardId: 'b1',
      fromSeq: 7,
    })
  })

  it('records snapshot seq from a sync so the next rejoin sends fromSeq', () => {
    start()
    live({
      type: 'sync',
      headSeq: 0,
      ops: [],
      snapshot: { seq: 5, scene: [shape('x')] },
    })
    sock().drop()
    vi.advanceTimersByTime(500)
    sock().open()
    expect(sock().sent.at(-1)).toEqual({
      type: 'join',
      boardId: 'b1',
      fromSeq: 5,
    })
  })

  it('an unknown board (4404) or a protocol error (4400) is a failure, not a reconnect loop', () => {
    for (const code of [4404, 4400]) {
      FakeSocket.instances = []
      statuses = []
      const c = start()
      sock().open()
      sock().drop(code)
      expect(statuses.at(-1)?.[0]).toBe('failed')
      vi.advanceTimersByTime(60_000)
      expect(FakeSocket.instances).toHaveLength(1)
      c.stop()
    }
  })

  it('stop() closes the socket, cancels a pending reconnect and stops sending', () => {
    const c = start()
    live()
    sock().drop()
    c.stop()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
    const c2 = start()
    live()
    c2.stop()
    expect(sock().readyState).toBe(3)
    expect(() => ed.commit(add('after'))).not.toThrow()
    expect(sock().ofType('ops')).toEqual([])
  })
})

describe('what the server batch carries (T4: author, turn and bounds reach the UI)', () => {
  it('reports every applied server batch with its author, turnId and bounds, but not our own acked edit', () => {
    const seen: unknown[] = []
    start({ onServerBatch: (sb) => seen.push(sb) })
    live()
    const AI = { kind: 'agent' as const, id: 'tutor:t1' }
    const bounds = { x: 1, y: 2, w: 3, h: 4 }
    sock().deliver({
      type: 'ops',
      seq: 1,
      batch: add('ai1'),
      author: AI,
      turnId: 't1',
      bounds,
    })
    expect(seen).toEqual([
      expect.objectContaining({ seq: 1, author: AI, turnId: 't1', bounds }),
    ])
    expect((seen[0] as { batch: Batch }).batch.ops[0]).toMatchObject({
      op: 'add',
    })
    // a batch we sent ourselves and the server echoes back is applied once and still reported (the Activity tab lists it)
    ed.commit(add('mine'))
    const mine = sock().ofType('ops')[0]
    sock().deliver({ type: 'ack', clientSeq: mine?.clientSeq, seq: 2 })
    expect(seen).toHaveLength(1)
  })

  it('reports the tail of a sync too', () => {
    const seen: number[] = []
    start({ onServerBatch: (sb) => seen.push(sb.seq) })
    live(sync(2, [bc(1, add('a')), bc(2, add('b'))]))
    expect(seen).toEqual([1, 2])
  })
})

describe('HANDOFF fixes found while wiring the dock', () => {
  it('a pending offline edit survives a snapshot sync that has no ops after it (it is resent, so it must be on screen)', () => {
    start()
    live()
    sock().drop()
    ed.commit(add('offline'))
    vi.advanceTimersByTime(500)
    sock().open()
    sock().deliver(sync(5, [], { seq: 5, scene: [shape('server')] }))
    expect([...ed.scene.els.keys()].sort()).toEqual(['offline', 'server'])
    expect(sock().ofType('ops')).toHaveLength(1)
  })

  it('drift clears the scene and rejoins from 0 instead of replaying the log over the old scene', () => {
    start()
    live(sync(1, [bc(1, add('a'))]))
    // the server sends a batch that cannot apply to our state: patching an element we do not have, as an add of an existing id
    sock().deliver(bc(2, add('a')))
    expect(sock().readyState).toBe(3) // closed with 4000 to resync
    expect(ed.scene.els.size).toBe(0)
    vi.advanceTimersByTime(500)
    sock().open()
    expect(sock().sent[0]).toEqual({ type: 'join', boardId: 'b1', fromSeq: 0 })
    sock().deliver(sync(2, [bc(1, add('a')), bc(2, fill('a', 'red'))]))
    expect([...ed.scene.els.keys()]).toEqual(['a'])
    expect(fillOf(ed, 'a')).toBe('red')
    expect(sock().sent.filter((m) => m.type === 'join')).toHaveLength(1)
  })

  it('a batch over 1 MiB is refused locally with a notice, never sent, and not resent after a reconnect', () => {
    start()
    live()
    const big = batch(
      'Big',
      ...Array.from(
        { length: 60 },
        (_, i) =>
          ({
            op: 'add',
            el: shape(`big${i}`, {
              data: { kind: 'rect', pad: 'x'.repeat(20_000) } as never,
            }),
          }) as Op,
      ),
    )
    ed.commit(big)
    expect(sock().ofType('ops')).toEqual([])
    expect(notices.join(' ')).toMatch(/too large/i)
    expect(ed.scene.els.size).toBe(0) // rolled back like a reject
    sock().drop()
    vi.advanceTimersByTime(500)
    sock().open()
    sock().deliver(sync(0))
    expect(sock().ofType('ops')).toEqual([])
  })
})

describe('idle(): the chat waits for the board to be saved before it sends', () => {
  it('resolves at once when nothing is pending, after the ack when something is, and after a timeout when the ack never comes', async () => {
    const c = start()
    live()
    let done = 0
    await c.idle().then(() => done++)
    expect(done).toBe(1)

    ed.commit(add('mine'))
    const waiting = c.idle().then(() => done++)
    await Promise.resolve()
    expect(done).toBe(1)
    const sent = sock().ofType('ops')[0]
    sock().deliver({ type: 'ack', clientSeq: sent?.clientSeq, seq: 1 })
    await waiting
    expect(done).toBe(2)

    ed.commit(add('lost'))
    const stuck = c.idle(1000).then(() => done++)
    vi.advanceTimersByTime(1000)
    await stuck
    expect(done).toBe(3)
  })
  it('a rejected edit also settles it', async () => {
    const c = start()
    live()
    ed.commit(add('bad'))
    let done = false
    const waiting = c.idle().then(() => {
      done = true
    })
    sock().deliver({
      type: 'reject',
      clientSeq: sock().ofType('ops')[0]?.clientSeq,
      reason: { message: 'no' },
    })
    await waiting
    expect(done).toBe(true)
  })
})

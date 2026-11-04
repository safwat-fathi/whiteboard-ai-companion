import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { type AddressInfo, connect as connectRaw } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyBatch,
  type Batch,
  createScene,
  type Element,
} from '@whiteboard/core'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createDiskBlobStore } from './blobs'
import { BoardService } from './board-service'
import { loadConfig } from './config'
import {
  createBlobsDb,
  createBoardsDb,
  openDatabase,
  schemaVersion,
} from './db'
import { attachGateway } from './gateway'
import { createHttpServer } from './http'

const ORIGIN = 'http://localhost:3000'
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})

// biome-ignore lint/suspicious/noExplicitAny: wire messages are inspected loosely in tests
type Msg = Record<string, any>

async function boot(existing?: { dataDir: string }) {
  const root = existing ? undefined : mkdtempSync(join(tmpdir(), 'wb-gw-'))
  const dataDir = existing?.dataDir ?? join(root as string, 'data')
  const db: Database.Database = openDatabase({ dataDir })
  let clock = 1_000
  const boards = new BoardService(createBoardsDb(db), { now: () => ++clock })
  const config = loadConfig({ PUBLIC_ORIGIN: ORIGIN, DATA_DIR: dataDir })
  const server: Server = createHttpServer({
    config,
    boards,
    blobs: createDiskBlobStore({ dataDir, db: createBlobsDb(db) }),
    schemaVersion: () => schemaVersion(db),
  })
  const gateway = attachGateway(server, { boards, config })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await gateway.close()
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
    boards.close()
    db.close()
  }
  cleanup.push(async () => {
    await stop()
    if (root) rmSync(root, { recursive: true, force: true })
  })
  return {
    boards,
    gateway,
    dataDir,
    port,
    stop,
    url: (id: string) => `ws://127.0.0.1:${port}/ws?boardId=${id}`,
  }
}

/** A connected client that records every message and close. */
type Client = {
  ws: WebSocket
  msgs: Msg[]
  closed: Promise<number>
  send: (m: unknown) => void
  next: (type: string) => Promise<Msg>
  quiet: (ms?: number) => Promise<Msg[]>
}
async function connect(
  url: string,
  origin: string | null = ORIGIN,
): Promise<Client> {
  const ws = new WebSocket(
    url,
    origin === null ? {} : { headers: { Origin: origin } },
  )
  const msgs: Msg[] = []
  const waiters: (() => void)[] = []
  ws.on('message', (d) => {
    msgs.push(JSON.parse(d.toString()))
    for (const w of waiters.splice(0)) w()
  })
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  cleanup.push(() => ws.terminate())
  const taken = new Set<Msg>()
  const next = async (type: string) => {
    for (let i = 0; i < 400; i++) {
      const hit = msgs.find((m) => m.type === type && !taken.has(m))
      if (hit) {
        taken.add(hit)
        return hit
      }
      await new Promise<void>((r) => {
        waiters.push(r)
        setTimeout(r, 25)
      })
    }
    throw new Error(
      `no ${type} message; got ${JSON.stringify(msgs.map((m) => m.type))}`,
    )
  }
  return {
    ws,
    msgs,
    closed,
    send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
    next,
    quiet: async (ms = 120) => {
      const before = msgs.length
      await new Promise((r) => setTimeout(r, ms))
      return msgs.slice(before)
    },
  }
}

/** The HTTP status of a refused upgrade. */
function refused(
  url: string,
  origin: string | null,
  extra: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { ...(origin === null ? {} : { Origin: origin }), ...extra },
    })
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0)
      ws.terminate()
    })
    ws.on('open', () => {
      ws.terminate()
      reject(new Error('the upgrade was accepted'))
    })
    ws.on('error', () => {})
  })
}

let n = 0
const rect = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'shape',
  x: 10,
  y: 20,
  w: 100,
  h: 50,
  rotation: 0,
  z: `a${String(n++).padStart(6, '0')}1`, // must not end in 0: core rejects such order keys
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
})
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
const OWNER = { kind: 'human', id: 'owner' } as const
const strip = (els: Element[]) => els.map(({ author: _a, ...e }) => e)

describe('upgrade gate (R3)', () => {
  it.each([
    ['a foreign origin', 'http://evil.test'],
    ['no origin', null],
    ['a trailing slash', `${ORIGIN}/`],
    ['another port', 'http://localhost:3001'],
    ['null', 'null'],
  ])('refuses %s with 403 and never opens a socket', async (_n, origin) => {
    const { boards, url } = await boot()
    const b = boards.createBoard('B')
    expect(await refused(url(b.id), origin)).toBe(403)
  })

  it('refuses a rebinding Host even when the Origin is right', async () => {
    const { boards, url } = await boot()
    const b = boards.createBoard('B')
    expect(await refused(url(b.id), ORIGIN, { Host: 'evil.test:4000' })).toBe(
      403,
    )
    expect(
      await refused(url(b.id), ORIGIN, { Host: 'evil.test@localhost' }),
    ).toBe(403)
  })

  it('answers a malformed request target with 400 and keeps serving', async () => {
    const { port } = await boot()
    const reply = await new Promise<string>((resolve) => {
      const s = connectRaw(port, '127.0.0.1')
      let got = ''
      s.on('data', (d) => {
        got += d
      })
      s.on('close', () => resolve(got))
      s.on('error', () => resolve(got))
      s.write(
        `GET //[ HTTP/1.1\r\nHost: localhost\r\nOrigin: ${ORIGIN}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
      )
    })
    expect(reply).toMatch(/^HTTP\/1\.1 400/)
    const health = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(health.status).toBe(200)
  })

  it('refuses a path other than /ws', async () => {
    const { boards, port } = await boot()
    const b = boards.createBoard('B')
    expect(
      await refused(`ws://127.0.0.1:${port}/elsewhere?boardId=${b.id}`, ORIGIN),
    ).toBe(404)
  })

  it('opens then closes 4404 for an unknown or missing board', async () => {
    const { url, port } = await boot()
    const c = await connect(url('nope'))
    expect(await c.closed).toBe(4404)
    const d = await connect(`ws://127.0.0.1:${port}/ws`)
    expect(await d.closed).toBe(4404)
  })
})

describe('join, ack and broadcast', () => {
  it('answers join at 0 with every op of the board', async () => {
    const { boards, url } = await boot()
    const b = boards.createBoard('B')
    for (let i = 0; i < 3; i++) boards.submit(b.id, add(`e${i}`), OWNER)
    const c = await connect(url(b.id))
    c.send({ type: 'join', boardId: b.id, fromSeq: 0 })
    const sync = await c.next('sync')
    expect(sync.headSeq).toBe(3)
    expect(sync.snapshot).toBeUndefined()
    expect(sync.ops.map((o: Msg) => o.seq)).toEqual([1, 2, 3])
    expect(sync.ops[0].author).toEqual(OWNER)
  })

  it('acks the sender, broadcasts to the others, never echoes to the sender, and derives the author', async () => {
    const { boards, url } = await boot()
    const b = boards.createBoard('B')
    const [a, c] = [await connect(url(b.id)), await connect(url(b.id))]
    for (const x of [a, c]) x.send({ type: 'join', boardId: b.id, fromSeq: 0 })
    await a.next('sync')
    await c.next('sync')
    a.send({ type: 'ops', clientSeq: 7, batch: add('x') })
    expect(await a.next('ack')).toMatchObject({ clientSeq: 7, seq: 1 })
    const got = await c.next('ops')
    expect(got).toMatchObject({
      seq: 1,
      author: OWNER,
      bounds: { x: 10, y: 20, w: 100, h: 50 },
    })
    expect(got.batch.ops[0].el.author).toEqual(OWNER) // the claimed author was replaced
    await a.quiet()
    expect(a.msgs.map((m) => m.type)).toEqual(['sync', 'ack']) // never an echo of its own batch
    expect(boards.scene(b.id).elements[0]?.author).toEqual(OWNER)
  })

  it('ordering: two clients firing 20 interleaved batches each end with the server scene and seqs 2..41 with no gap', async () => {
    const { boards, url } = await boot()
    const b = boards.createBoard('B')
    const sharedAdd = add('shared')
    boards.submit(b.id, sharedAdd, OWNER) // seq 1
    const [a, c] = [await connect(url(b.id)), await connect(url(b.id))]
    const logs = [new Map<number, unknown>(), new Map<number, unknown>()]
    for (const x of [a, c]) {
      x.send({ type: 'join', boardId: b.id, fromSeq: 0 })
      await x.next('sync')
    }
    const sent: [Map<number, unknown>, Map<number, unknown>] = [
      new Map(),
      new Map(),
    ]
    for (let i = 0; i < 20; i++) {
      const ba =
        i % 2 ? patch('shared', { 'style.fill': `#a${i}` }) : add(`a${i}`)
      const bc =
        i % 2 ? patch('shared', { 'style.fill': `#c${i}` }) : add(`c${i}`)
      sent[0].set(i, ba)
      sent[1].set(i, bc)
      a.send({ type: 'ops', clientSeq: i, batch: ba })
      c.send({ type: 'ops', clientSeq: i, batch: bc })
    }
    const clients = [a, c]
    for (const [k, x] of clients.entries()) {
      for (let i = 0; i < 20; i++) {
        const ack = await x.next('ack')
        logs[k]?.set(ack.seq, sent[k]?.get(ack.clientSeq))
      }
    }
    await a.quiet()
    await c.quiet()
    const seqs = [
      ...(logs[0] as Map<number, unknown>).keys(),
      ...(logs[1] as Map<number, unknown>).keys(),
    ].sort((x, y) => x - y)
    expect(seqs).toEqual(Array.from({ length: 40 }, (_, i) => i + 2))
    // Each client rebuilds the scene from the server's order: the other's batches arrive as `ops`, its own are acked.
    for (const [k, x] of clients.entries()) {
      const bySeq = new Map<number, Batch>(logs[k] as Map<number, Batch>)
      for (const m of x.msgs.filter((m) => m.type === 'ops'))
        bySeq.set(m.seq, m.batch)
      const scene = createScene()
      applyBatch(scene, sharedAdd as Batch)
      for (const seq of [...bySeq.keys()].sort((p, q) => p - q))
        applyBatch(scene, bySeq.get(seq) as Batch)
      expect(strip([...scene.els.values()])).toEqual(
        strip(boards.scene(b.id).elements),
      )
    }
    expect(boards.scene(b.id).headSeq).toBe(41)
  })

  it('rejects an invalid batch to the sender only and stores nothing', async () => {
    const { boards, url } = await boot()
    const b = boards.createBoard('B')
    const [a, c] = [await connect(url(b.id)), await connect(url(b.id))]
    for (const x of [a, c]) {
      x.send({ type: 'join', boardId: b.id, fromSeq: 0 })
      await x.next('sync')
    }
    a.send({
      type: 'ops',
      clientSeq: 1,
      batch: {
        batchId: 'x',
        label: 'x',
        ops: [{ op: 'add', el: rect('bad', { x: 1_000_001 }) }],
      },
    })
    const r = await a.next('reject')
    expect(r.clientSeq).toBe(1)
    expect(r.reason).toMatchObject({ code: 'validation_failed' })
    a.send({ type: 'ops', clientSeq: 2, batch: { nonsense: true } })
    expect((await a.next('reject')).reason.code).toBe('validation_failed')
    await c.quiet()
    expect(c.msgs.map((m) => m.type)).toEqual(['sync']) // the rejected batches reached nobody else
    expect(boards.scene(b.id)).toEqual({ headSeq: 0, elements: [] })
  })

  it('delivers one broadcast to ten sockets', async () => {
    const { boards, url } = await boot()
    const b = boards.createBoard('B')
    const cs = await Promise.all(
      Array.from({ length: 10 }, () => connect(url(b.id))),
    )
    for (const x of cs) {
      x.send({ type: 'join', boardId: b.id, fromSeq: 0 })
      await x.next('sync')
    }
    boards.submit(b.id, add('x'), OWNER)
    for (const x of cs) expect((await x.next('ops')).seq).toBe(1)
  })
})

describe('reconnect and restart', () => {
  it('a reconnect with fromSeq gets only the missed ops', async () => {
    const { boards, url } = await boot()
    const b = boards.createBoard('B')
    for (let i = 0; i < 40; i++) boards.submit(b.id, add(`e${i}`), OWNER)
    const c = await connect(url(b.id))
    c.send({ type: 'join', boardId: b.id, fromSeq: 30 })
    const sync = await c.next('sync')
    expect(sync.ops.map((o: Msg) => o.seq)).toEqual([
      31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
    ])
  })

  it('a client ahead of the server gets the whole scene as a snapshot', async () => {
    const { boards, url } = await boot()
    const b = boards.createBoard('B')
    boards.submit(b.id, add('only'), OWNER)
    const c = await connect(url(b.id))
    c.send({ type: 'join', boardId: b.id, fromSeq: 500 })
    const sync = await c.next('sync')
    expect(sync.snapshot.seq).toBe(1)
    expect(sync.snapshot.scene).toHaveLength(1)
    expect(sync.ops).toEqual([])
  })

  it('survives a restart: a new server over the same database serves the same scene', async () => {
    const first = await boot()
    const b = first.boards.createBoard('B')
    const c1 = await connect(first.url(b.id))
    c1.send({ type: 'join', boardId: b.id, fromSeq: 0 })
    await c1.next('sync')
    for (let i = 0; i < 5; i++) {
      c1.send({ type: 'ops', clientSeq: i, batch: add(`e${i}`) })
      await c1.next('ack')
    }
    const before = first.boards.scene(b.id)
    await first.stop()
    const second = await boot({ dataDir: first.dataDir })
    const c2 = await connect(second.url(b.id))
    c2.send({ type: 'join', boardId: b.id, fromSeq: 0 })
    const sync = await c2.next('sync')
    expect(sync.headSeq).toBe(5)
    expect(second.boards.scene(b.id)).toEqual(before)
  })
})

describe('protocol errors', () => {
  it.each([
    ['invalid JSON', '{nope'],
    ['an unknown type', JSON.stringify({ type: 'launch' })],
    [
      'ops before join',
      JSON.stringify({ type: 'ops', clientSeq: 1, batch: {} }),
    ],
    [
      'a negative fromSeq',
      JSON.stringify({ type: 'join', boardId: 'x', fromSeq: -1 }),
    ],
    [
      'a fractional clientSeq',
      JSON.stringify({ type: 'ops', clientSeq: 1.5, batch: {} }),
    ],
  ])(
    'closes 4400 on %s and keeps serving the other client',
    async (_n, raw) => {
      const { boards, url } = await boot()
      const b = boards.createBoard('B')
      const [bad, good] = [await connect(url(b.id)), await connect(url(b.id))]
      good.send({ type: 'join', boardId: b.id, fromSeq: 0 })
      await good.next('sync')
      bad.send(raw)
      expect(await bad.closed).toBe(4400)
      good.send({ type: 'ops', clientSeq: 1, batch: add('still-works') })
      expect((await good.next('ack')).seq).toBe(1)
    },
  )

  it('closes 4400 on a join for another board', async () => {
    const { boards, url } = await boot()
    const [b, other] = [boards.createBoard('B'), boards.createBoard('O')]
    const c = await connect(url(b.id))
    c.send({ type: 'join', boardId: other.id, fromSeq: 0 })
    expect(await c.closed).toBe(4400)
  })

  it('closes a binary frame with 4400', async () => {
    const { boards, url } = await boot()
    const b = boards.createBoard('B')
    const c = await connect(url(b.id))
    c.ws.send(Buffer.from([1, 2, 3]))
    expect(await c.closed).toBe(4400)
  })

  it('closes 1009 on a message over 1 MB and keeps serving the other client', async () => {
    const { boards, url } = await boot()
    const b = boards.createBoard('B')
    const [big, good] = [await connect(url(b.id)), await connect(url(b.id))]
    good.send({ type: 'join', boardId: b.id, fromSeq: 0 })
    await good.next('sync')
    big.send(
      JSON.stringify({
        type: 'ops',
        clientSeq: 1,
        batch: 'x'.repeat(2 * 1024 * 1024),
      }),
    )
    expect(await big.closed).toBe(1009)
    good.send({ type: 'ops', clientSeq: 1, batch: add('ok') })
    expect((await good.next('ack')).seq).toBe(1)
  })

  it('releases a closed socket: the subscriber count returns to 0', async () => {
    const { boards, url, gateway } = await boot()
    const b = boards.createBoard('B')
    const c = await connect(url(b.id))
    c.send({ type: 'join', boardId: b.id, fromSeq: 0 })
    await c.next('sync')
    expect(boards.subscriberCount(b.id)).toBe(1)
    expect(gateway.clients()).toBe(1)
    c.ws.close()
    await c.closed
    await new Promise((r) => setTimeout(r, 50))
    expect(boards.subscriberCount(b.id)).toBe(0)
    expect(gateway.clients()).toBe(0)
    expect(boards.submit(b.id, add('after'), OWNER).seq).toBe(1) // no dead subscriber to trip over
  })
})

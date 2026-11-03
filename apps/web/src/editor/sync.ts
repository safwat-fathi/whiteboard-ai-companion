import { type Batch, type Element, OpError } from '@whiteboard/core'
import type { Editor } from './editor'

export type SyncStatus = 'connecting' | 'live' | 'offline' | 'failed'

/** The server's broadcast of one accepted batch (also the items of a `sync` tail). */
export type ServerBatch = {
  seq: number
  batch: Batch
  author?: { kind: 'human' | 'agent'; id: string }
  turnId?: string
  bounds?: { x: number; y: number; w: number; h: number } | null
}
/** Called for every server batch applied here: the Activity tab, Follow AI and the off-screen indicator listen. */
export type ServerBatchHook = (sb: ServerBatch) => void
type Pending = { clientSeq: number; batch: Batch; inverse: Batch }

type Socket = {
  readyState: number
  send(data: string): void
  close(code?: number): void
  onopen: (() => void) | null
  onmessage: ((e: { data: string }) => void) | null
  onclose: ((e: { code: number }) => void) | null
  onerror: (() => void) | null
}

const OPEN = 1
const MAX_FRAME_BYTES = 1024 * 1024 // the server closes a socket that sends more (1009), and the resend would repeat it
const FATAL_CLOSE_CODES = new Set([4400, 4404]) // protocol error, unknown board: reconnecting would only repeat it

/**
 * Keeps an Editor in step with the board on the server (the wire protocol of docs/plans/api.md).
 *
 * Local edits apply at once (optimistic) and are queued as `pending`, each with the inverse that undoes it. The server
 * is the authority on order: when one of its batches arrives while local edits are pending, the pending edits are
 * rolled back, the server batch applied, and the pending edits replayed on top, which is exactly the order the server
 * will apply them in. A batch the server applied whose ack was lost is recognised by its batchId, not replayed twice.
 * While offline the editor stays editable; pending edits are resent after the next sync.
 */
export function createSyncClient(o: {
  url: string
  boardId: string
  editor: Editor
  onStatus: (s: SyncStatus, detail?: string) => void
  onServerBatch?: ServerBatchHook
  WebSocketImpl?: new (url: string) => Socket
  backoff?: { minMs: number; maxMs: number }
}): { start(): void; stop(): void; idle(timeoutMs?: number): Promise<void> } {
  const { editor, boardId } = o
  const Impl =
    o.WebSocketImpl ??
    (globalThis.WebSocket as unknown as new (
      url: string,
    ) => Socket)
  const { minMs, maxMs } = o.backoff ?? { minMs: 500, maxMs: 10_000 }

  const pending: Pending[] = []
  let nextClientSeq = 1
  let lastSeq = 0 // the last server seq applied here, in server order: what a rejoin asks from
  let ws: Socket | null = null
  let synced = false // true from a `sync` until the socket closes: only then are edits sent
  let stopped = false
  let delay = minMs
  let timer: ReturnType<typeof setTimeout> | undefined

  // callers waiting for every local edit to be acknowledged (or refused)
  const idleWaiters = new Set<() => void>()
  const maybeIdle = () => {
    if (pending.length > 0) return
    for (const fn of [...idleWaiters]) fn()
  }
  const send = (m: unknown) => ws?.send(JSON.stringify(m))
  const notice = (text: string) => editor.onNotice?.(text)

  /** Sends one pending edit; one that cannot fit in a frame is refused here, like a server reject. */
  function sendOps(p: Pending) {
    const frame = JSON.stringify({
      type: 'ops',
      clientSeq: p.clientSeq,
      batch: p.batch,
    })
    if (new TextEncoder().encode(frame).length > MAX_FRAME_BYTES)
      return onReject({
        clientSeq: p.clientSeq,
        reason: { message: 'it is too large to send (over 1 MiB)' },
      })
    ws?.send(frame)
  }

  // Local edits: apply (the editor already did), queue, and send if the server's tail has been applied.
  editor.onBatch = (batch, inverse) => {
    if (stopped) return
    const p = { clientSeq: nextClientSeq++, batch, inverse }
    pending.push(p)
    if (synced && ws?.readyState === OPEN) sendOps(p)
  }

  /** Undoes every pending edit, newest first (an edit with an empty inverse changed nothing). */
  function rollback() {
    for (let i = pending.length - 1; i >= 0; i--) {
      const inv = pending[i]?.inverse
      if (inv?.ops.length) editor.applyExternal(inv)
    }
  }

  /** Applies the given pending edits again, in order; one that no longer applies is dropped with a notice. */
  function replay(list: Pending[]) {
    for (const p of list) {
      try {
        p.inverse = editor.applyExternal(p.batch)
      } catch (e) {
        if (!(e instanceof OpError)) throw e
        pending.splice(pending.indexOf(p), 1)
        notice(
          `A change was dropped because it no longer applies: ${e.message}`,
        )
      }
    }
  }

  /**
   * Applies server batches in order. `replaced` means the scene was just replaced by a snapshot, so the pending edits
   * are not in it and need no rollback.
   */
  function applyServer(list: ServerBatch[], replaced = false): boolean {
    if (list.length === 0 && !replaced) return true
    if (!replaced) rollback()
    for (const sb of list) {
      const mine = pending.findIndex(
        (p) => p.batch.batchId === sb.batch.batchId,
      )
      if (mine >= 0) pending.splice(mine, 1) // the server already has it (its ack was lost): this is that edit
      try {
        editor.applyExternal(sb.batch)
      } catch (e) {
        if (!(e instanceof OpError)) throw e
        // The server's own batch does not apply to our state: we have drifted. Start over from the whole log: an empty
        // scene (the rejoin from 0 replays everything onto it) and no stale inverses for the pending edits.
        notice('Resynchronising with the server')
        editor.setScene([], undefined, editor.undo.toJSON())
        for (const p of pending) p.inverse = { ...p.inverse, ops: [] }
        lastSeq = 0
        ws?.close(4000)
        return false
      }
      lastSeq = sb.seq
      o.onServerBatch?.(sb)
    }
    replay([...pending])
    return true
  }

  function onSync(m: {
    headSeq: number
    snapshot?: { seq: number; scene: Element[] }
    ops: ServerBatch[]
  }) {
    if (m.snapshot)
      editor.setScene(m.snapshot.scene, undefined, editor.undo.toJSON())
    if (m.snapshot) lastSeq = m.snapshot.seq
    if (!applyServer(m.ops, !!m.snapshot)) return // drifted: the socket is closing and the rejoin starts from 0
    lastSeq = Math.max(lastSeq, m.headSeq)
    synced = true
    delay = minMs
    o.onStatus('live')
    for (const p of [...pending]) sendOps(p)
  }

  function onReject(m: { clientSeq: number; reason: { message?: string } }) {
    const i = pending.findIndex((p) => p.clientSeq === m.clientSeq)
    if (i < 0) return
    rollback()
    pending.splice(i, 1)
    notice(
      `A change was not accepted: ${m.reason?.message ?? 'unknown reason'}`,
    )
    replay([...pending])
    maybeIdle()
  }

  function onMessage(raw: string) {
    let m: { type?: string } & Record<string, unknown>
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    if (m.type === 'sync') onSync(m as never)
    else if (m.type === 'ops') applyServer([m as unknown as ServerBatch])
    else if (m.type === 'ack') {
      const i = pending.findIndex((p) => p.clientSeq === m.clientSeq)
      if (i >= 0) pending.splice(i, 1)
      if (typeof m.seq === 'number') lastSeq = Math.max(lastSeq, m.seq)
      maybeIdle()
    } else if (m.type === 'reject') onReject(m as never)
  }

  function connect() {
    const mine = new Impl(o.url)
    ws = mine
    mine.onopen = () => {
      if (ws === mine) send({ type: 'join', boardId, fromSeq: lastSeq })
    }
    mine.onmessage = (e) => {
      if (ws === mine) onMessage(e.data)
    }
    mine.onerror = () => {} // a close follows
    mine.onclose = (e) => {
      if (ws !== mine) return
      synced = false
      ws = null
      if (stopped) return
      if (FATAL_CLOSE_CODES.has(e.code))
        return o.onStatus(
          'failed',
          e.code === 4404 ? 'unknown board' : 'protocol error',
        )
      o.onStatus('offline')
      timer = setTimeout(connect, delay)
      delay = Math.min(delay * 2, maxMs)
    }
  }

  return {
    start() {
      stopped = false
      o.onStatus('connecting')
      connect()
    },
    /** Resolves when no local edit is waiting for the server, or after `timeoutMs` (default 4 s) whatever the state. */
    idle(timeoutMs = 4000) {
      if (pending.length === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t)
          idleWaiters.delete(done)
          resolve()
        }
        const t = setTimeout(done, timeoutMs)
        idleWaiters.add(done)
      })
    },
    stop() {
      for (const fn of [...idleWaiters]) fn()
      stopped = true
      clearTimeout(timer)
      const s = ws
      ws = null
      synced = false
      s?.close(1000)
      if (editor.onBatch) editor.onBatch = undefined
    },
  }
}

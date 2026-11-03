import { randomUUID } from 'node:crypto'
import {
  agentMayEdit,
  applyBatch,
  type Batch,
  bounds as boundsOfElement,
  createScene,
  type Element,
  OpError,
  type Scene,
  validateBatch,
} from '@whiteboard/core'
import type { BoardRow, BoardsDb, Bounds, OpRow, Scope } from './db'
import { ApiError } from './errors'
import { checkLimits } from './limits'

export type Author = { kind: 'human' | 'agent'; id: string }
export type Broadcast = {
  seq: number
  batch: Batch
  author: Author
  turnId?: string
  bounds: Bounds | null
}
export type SubmitResult = {
  seq: number
  noop: boolean
  broadcast: Broadcast | null
}
export type JoinResult = {
  headSeq: number
  snapshot?: { seq: number; scene: Element[] }
  ops: Broadcast[]
}

type Live = {
  scene: Scene
  headSeq: number
  lastSnapshotSeq: number
  lastSnapshotAt: number
  lastUsed: number
  subs: Set<(b: Broadcast) => void>
  /** Memory may be ahead of the database (a write failed): reload in place on next use, keeping the subscribers. */
  stale: boolean
}

const fromRow = (r: OpRow): Broadcast => ({
  seq: r.seq,
  batch: { batchId: r.batchId, label: r.label, ops: r.ops },
  author: { kind: r.authorKind, id: r.authorId },
  ...(r.turnId === undefined ? {} : { turnId: r.turnId }),
  bounds: r.bounds,
})

/** Union of the rects as the stored {x,y,w,h}; null for none. */
function union(rects: ReturnType<typeof boundsOfElement>[]): Bounds | null {
  if (rects.length === 0) return null
  const minX = Math.min(...rects.map((r) => r.minX))
  const minY = Math.min(...rects.map((r) => r.minY))
  const maxX = Math.max(...rects.map((r) => r.maxX))
  const maxY = Math.max(...rects.map((r) => r.maxY))
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * The board's single writer: validate, apply (core's applyBatch on an in-memory scene), stamp `seq`, store, broadcast.
 * Knows nothing about HTTP or sockets. Active boards stay in memory; a snapshot is written every `snapshotEvery`
 * batches and, via `tick()`, after `snapshotAfterMs` of activity; boards idle for `idleEvictMs` with no subscriber are evicted.
 */
export class BoardService {
  private live = new Map<string, Live>()
  private readonly now: () => number
  private readonly snapshotEvery: number
  private readonly snapshotAfterMs: number
  private readonly idleEvictMs: number

  constructor(
    private readonly db: BoardsDb,
    o: {
      now?: () => number
      snapshotEvery?: number
      snapshotAfterMs?: number
      idleEvictMs?: number
    } = {},
  ) {
    this.now = o.now ?? Date.now
    this.snapshotEvery = o.snapshotEvery ?? 500
    this.snapshotAfterMs = o.snapshotAfterMs ?? 5 * 60_000
    this.idleEvictMs = o.idleEvictMs ?? 10 * 60_000
  }

  createBoard(title: string, scope?: Scope): BoardRow {
    return this.db.createBoard({ id: randomUUID(), title, scope }, this.now())
  }
  getBoard = (id: string) => this.db.getBoard(id)
  listBoards = () => this.db.listBoards()
  updateBoard(id: string, p: { title?: string; scope?: Scope }) {
    return this.db.updateBoard(id, p, this.now())
  }
  deleteBoard(id: string): boolean {
    this.live.delete(id)
    return this.db.deleteBoard(id)
  }
  /** Number of boards held in memory (for tests and health). */
  activeCount = () => this.live.size
  /** Live subscribers of a board (0 when it is not in memory): lets tests prove a closed socket was released. */
  subscriberCount = (boardId: string) => this.live.get(boardId)?.subs.size ?? 0

  /** The current scene of a board (loaded on demand) in z order of insertion. */
  scene(boardId: string): { headSeq: number; elements: Element[] } {
    const l = this.load(boardId)
    return { headSeq: l.headSeq, elements: [...l.scene.els.values()] }
  }

  /**
   * `opts.grantedIds`: the student's elements an agent author may change this turn (what was selected when it began).
   * `opts.preserveAuthor`: keep each added element's own author; only server-side undo sets it, so a re-added tutor
   * element is still the tutor's.
   */
  submit(
    boardId: string,
    input: unknown,
    author: Author,
    turnId?: string,
    opts: { grantedIds?: ReadonlySet<string>; preserveAuthor?: boolean } = {},
  ): SubmitResult {
    const l = this.load(boardId)
    let batch: Batch
    try {
      batch = validateBatch(input)
    } catch (e) {
      throw this.invalid(e)
    }
    checkLimits(batch, l.scene.els.size)
    if (author.kind === 'agent') {
      // Edit rights: the tutor may add anything but change only its own work and what the student selected.
      const granted = opts.grantedIds ?? new Set<string>()
      for (const op of batch.ops) {
        if (op.op === 'add') continue
        const el = l.scene.els.get(op.id)
        const why = el && agentMayEdit(el, granted)
        if (why)
          throw new ApiError('validation_failed', why, {
            field: 'ops',
            id: op.id,
          })
      }
    }
    // The author of a new element is the channel's, never the client's.
    if (!opts.preserveAuthor)
      batch = {
        ...batch,
        ops: batch.ops.map((op) =>
          op.op === 'add' ? { ...op, el: { ...op.el, author } } : op,
        ),
      }
    const rects = batch.ops.flatMap((op) => {
      const cur = op.op === 'remove' ? l.scene.els.get(op.id) : undefined
      return cur ? [boundsOfElement(cur)] : []
    })
    let applied: ReturnType<typeof applyBatch>
    try {
      applied = applyBatch(l.scene, batch)
    } catch (e) {
      throw this.invalid(e)
    }
    if (applied.inverse.ops.length === 0)
      return { seq: l.headSeq, noop: true, broadcast: null } // R7: every op was dropped
    const effective = [
      ...new Set(
        applied.inverse.ops.map((o) => (o.op === 'add' ? o.el.id : o.id)),
      ),
    ]
    for (const id of effective) {
      const el = l.scene.els.get(id)
      if (el) rects.push(boundsOfElement(el))
    }
    const bounds = union(rects)
    let seq: number
    try {
      seq = this.db.appendBatch(
        boardId,
        {
          batchId: batch.batchId,
          authorKind: author.kind,
          authorId: author.id,
          turnId,
          label: batch.label,
          bounds,
          touchedIds: effective,
          ops: batch.ops,
          ...(author.kind === 'agent' ? { inverse: applied.inverse } : {}),
        },
        this.now(),
      )
    } catch (e) {
      l.stale = true // memory is ahead of the database: the next access reloads the truth into this same Live (subscribers stay attached)
      throw e
    }
    l.headSeq = seq
    l.lastUsed = this.now()
    const broadcast: Broadcast = {
      seq,
      batch,
      author,
      ...(turnId === undefined ? {} : { turnId }),
      bounds,
    }
    for (const fn of l.subs) {
      try {
        fn(broadcast)
      } catch {
        // one failing subscriber must not break the others or the write that already happened
      }
    }
    if (seq - l.lastSnapshotSeq >= this.snapshotEvery)
      this.trySnapshot(boardId, l) // the batch is already stored and sent: a failed snapshot must not turn it into an error
    return { seq, noop: false, broadcast }
  }

  /** The stored batches of a turn / of one batch, oldest first (turn undo and the Activity tab read them). */
  opsOfTurn = (boardId: string, turnId: string) =>
    this.db.opsByTurn(boardId, turnId)
  opsOfBatch = (boardId: string, batchId: string) =>
    this.db.opsByBatch(boardId, batchId)

  join(boardId: string, fromSeq: number): JoinResult {
    if (!Number.isInteger(fromSeq) || fromSeq < 0)
      throw new ApiError(
        'validation_failed',
        'fromSeq must be an integer >= 0',
        {
          field: 'fromSeq',
        },
      )
    const l = this.load(boardId)
    l.lastUsed = this.now()
    const head = l.headSeq
    const snap = this.db.latestSnapshot(boardId)
    if (fromSeq > head) {
      // The client is ahead of this server (its database was replaced): send the whole current scene.
      return {
        headSeq: head,
        snapshot: { seq: head, scene: [...l.scene.els.values()] },
        ops: [],
      }
    }
    if (snap && fromSeq < snap.seq)
      return {
        headSeq: head,
        snapshot: snap,
        ops: this.db.opsAfter(boardId, snap.seq).map(fromRow),
      }
    return {
      headSeq: head,
      ops: this.db.opsAfter(boardId, fromSeq).map(fromRow),
    }
  }

  subscribe(boardId: string, fn: (b: Broadcast) => void): () => void {
    const l = this.load(boardId)
    l.subs.add(fn)
    return () => {
      l.subs.delete(fn)
    }
  }

  /** Housekeeping the caller runs every so often: time-based snapshots and idle eviction. */
  tick(): void {
    const now = this.now()
    for (const [id, l] of this.live) {
      if (
        l.headSeq > l.lastSnapshotSeq &&
        now - l.lastSnapshotAt >= this.snapshotAfterMs
      )
        this.trySnapshot(id, l)
      if (l.subs.size === 0 && now - l.lastUsed >= this.idleEvictMs) {
        if (l.headSeq > l.lastSnapshotSeq) this.trySnapshot(id, l)
        this.live.delete(id)
      }
    }
  }

  /** Writes a snapshot for every board with unsnapshotted batches and drops everything from memory. */
  close(): void {
    for (const [id, l] of this.live)
      if (l.headSeq > l.lastSnapshotSeq) this.trySnapshot(id, l)
    this.live.clear()
  }

  /** A snapshot is an optimisation (the ops are the truth): log a failure with ids only, never throw, never snapshot stale memory. */
  private trySnapshot(boardId: string, l: Live): void {
    if (l.stale) return
    try {
      this.snapshot(boardId, l)
    } catch (e) {
      console.error(
        `snapshot failed for board ${boardId}:`,
        e instanceof Error ? e.message : String(e),
      )
    }
  }

  private snapshot(boardId: string, l: Live): void {
    this.db.saveSnapshot(boardId, l.headSeq, [...l.scene.els.values()])
    l.lastSnapshotSeq = l.headSeq
    l.lastSnapshotAt = this.now()
  }

  private load(boardId: string): Live {
    const cached = this.live.get(boardId)
    if (cached && !cached.stale) return cached
    const row = this.db.getBoard(boardId)
    if (!row) throw new ApiError('not_found', `unknown board ${boardId}`)
    const snap = this.db.latestSnapshot(boardId)
    const scene = createScene(snap?.scene ?? [])
    for (const r of this.db.opsAfter(boardId, snap?.seq ?? 0))
      applyBatch(scene, { batchId: r.batchId, label: r.label, ops: r.ops })
    const l: Live = {
      scene,
      headSeq: row.headSeq,
      lastSnapshotSeq: snap?.seq ?? 0,
      lastSnapshotAt: this.now(),
      lastUsed: this.now(),
      subs: cached?.subs ?? new Set(),
      stale: false,
    }
    if (cached)
      Object.assign(cached, l) // reload in place: closures hold `cached`, so its subscribers stay attached
    else this.live.set(boardId, l)
    return cached ?? l
  }

  private invalid(e: unknown): unknown {
    return e instanceof OpError
      ? new ApiError('validation_failed', e.message, { field: e.field })
      : e
  }
}

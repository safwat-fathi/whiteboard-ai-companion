import type { Scene } from './scene'
import type { Batch, Element, Id, Op } from './schema'

type Entry = { original: Batch; inverse: Batch }
export type UndoJSON = { undo: Entry[]; redo: Entry[]; maxDepth: number }

const eq = (a: unknown, b: unknown): boolean =>
  a === b ||
  (typeof a === 'object' &&
    typeof b === 'object' &&
    a !== null &&
    b !== null &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([k, v]) =>
      eq(v, (b as Record<string, unknown>)[k]),
    ))

// Current value at a dotted path; null when absent (same convention as patch sets).
function getPath(el: Element, key: string): unknown {
  let o: unknown = el
  for (const seg of key.split('.')) {
    if (typeof o !== 'object' || o === null || !Object.hasOwn(o, seg))
      return null
    o = (o as Record<string, unknown>)[seg]
  }
  return o
}

/**
 * Two stacks of {original, inverse}. undo()/redo() RETURN the batch to submit (append-only); the
 * caller commits it and commit calls record(), which files it on the opposite stack.
 * Ops whose target changed since are dropped and counted in `skipped`. An empty `batch.ops` means
 * nothing to apply: the caller must not submit it (validateBatch rejects it); the entry is consumed.
 */
export class UndoManager {
  private undoS: Entry[] = []
  private redoS: Entry[] = []
  private from: 'undo' | 'redo' | null = null // set between undo()/redo() and the record() that follows

  constructor(
    private scene: Scene,
    private maxDepth = 200,
  ) {}

  get canUndo() {
    return this.undoS.length > 0
  }
  get canRedo() {
    return this.redoS.length > 0
  }

  record(applied: { inverse: Batch; touched: Id[] }, original: Batch) {
    const from = this.from
    this.from = null
    if (applied.inverse.ops.length === 0) return
    const entry = { original, inverse: applied.inverse }
    if (from === 'undo') this.redoS.push(entry)
    else {
      this.undoS.push(entry)
      if (from === null) this.redoS = [] // a fresh edit clears redo
    }
    for (const s of [this.undoS, this.redoS])
      if (s.length > this.maxDepth) s.splice(0, s.length - this.maxDepth)
  }

  undo() {
    return this.step(this.undoS, 'undo')
  }
  redo() {
    return this.step(this.redoS, 'redo')
  }

  clear() {
    this.undoS = []
    this.redoS = []
    this.from = null
  }

  toJSON(): UndoJSON {
    return structuredClone({
      undo: this.undoS,
      redo: this.redoS,
      maxDepth: this.maxDepth,
    })
  }
  static fromJSON(scene: Scene, json: UndoJSON) {
    const m = new UndoManager(scene, json.maxDepth)
    m.undoS = structuredClone(json.undo)
    m.redoS = structuredClone(json.redo)
    return m
  }

  private step(stack: Entry[], dir: 'undo' | 'redo') {
    const entry = stack.pop()
    if (!entry) return null
    const { batch, skipped } = this.filter(entry)
    this.from = batch.ops.length ? dir : null
    return { batch, skipped }
  }

  // Drop inverse ops/keys whose target no longer matches what `original` left behind.
  private filter({ original, inverse }: Entry) {
    const wrote = new Map<string, unknown>() // `${id}\0${key}` -> last value written; reorder uses key '\0z'
    for (const op of original.ops) {
      if (op.op === 'patch')
        for (const [k, v] of Object.entries(op.set))
          wrote.set(`${op.id}\0${k}`, v)
      else if (op.op === 'reorder') wrote.set(`${op.id}\0\0z`, op.z)
    }
    let skipped = 0
    const ops: Op[] = []
    for (const op of inverse.ops) {
      const els = this.scene.els
      if (op.op === 'add') {
        if (els.has(op.el.id)) skipped++
        else ops.push(op)
        continue
      }
      const cur = els.get(op.id)
      if (!cur) {
        skipped++
      } else if (op.op === 'remove') {
        ops.push(op)
      } else if (op.op === 'reorder') {
        const w = wrote.get(`${op.id}\0\0z`)
        if (w !== undefined && cur.z !== w) skipped++
        else ops.push(op)
      } else {
        const set: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(op.set)) {
          const key = `${op.id}\0${k}`
          if (wrote.has(key) && !eq(getPath(cur, k), wrote.get(key))) skipped++
          else set[k] = v
        }
        if (Object.keys(set).length) ops.push({ ...op, set })
      }
    }
    return { batch: { ...inverse, ops }, skipped }
  }
}

import {
  type Camera,
  createScene,
  type Element,
  ElementSchema,
  UndoManager,
} from '@whiteboard/core'
import type { Editor } from './editor'

export const SCHEMA_VERSION = 1
const DB = 'whiteboard'
const STORE = 'boards'
const DEBOUNCE_MS = 500
const DEFAULT_CAMERA: Camera = { x: 0, y: 0, zoom: 1 }

export type BoardRecord = {
  version: number
  boardId: string
  savedAt: number
  elements: Element[]
  camera: Camera
  undo: unknown
}
export type LoadResult =
  | {
      status: 'ok'
      record: BoardRecord
      dropped: number
      undoDropped: boolean
    }
  | { status: 'empty' }
  | {
      status: 'unreadable'
      reason: 'corrupt' | 'newer-version' | 'unavailable'
      /** The stored value as found, for the backup copy. */
      raw?: unknown
    }

// --- raw IndexedDB: one database, one object store, out-of-line string keys ---
// The connection is kept open: a flush on pagehide must issue its transaction synchronously, with no
// async open() first, or the browser may tear the page down before the write is queued.
let conn: { factory: IDBFactory; db: Promise<IDBDatabase> } | undefined
function open(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined')
    return Promise.reject(new Error('no idb'))
  if (conn?.factory === indexedDB) return conn.db
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => {
      req.result.onclose = req.result.onversionchange = () => {
        conn = undefined
        req.result.close()
      }
      resolve(req.result)
    }
    req.onerror = () => {
      conn = undefined
      reject(req.error)
    }
  })
  conn = { factory: indexedDB, db }
  return db
}

async function run<T>(
  mode: IDBTransactionMode,
  op: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const req = op(tx.objectStore(STORE))
    // Resolve on tx completion: a write is durable only once the transaction commits (quota errors land here).
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = tx.onabort = () => reject(tx.error ?? req.error)
  })
}

const get = (key: string) => run('readonly', (s) => s.get(key))
const put = (key: string, value: unknown) =>
  run('readwrite', (s) => s.put(value, key))

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const validCamera = (c: unknown): c is Camera =>
  isObj(c) &&
  Number.isFinite(c.x) &&
  Number.isFinite(c.y) &&
  Number.isFinite(c.zoom) &&
  (c.zoom as number) > 0

export function saveBoard(boardId: string, record: BoardRecord): Promise<void> {
  return put(boardId, record).then(() => {})
}

export async function loadBoard(boardId: string): Promise<LoadResult> {
  let raw: unknown
  try {
    raw = await get(boardId)
  } catch {
    return { status: 'unreadable', reason: 'unavailable' }
  }
  if (raw === undefined) return { status: 'empty' }
  const bad = { status: 'unreadable', reason: 'corrupt', raw } as const
  if (
    !isObj(raw) ||
    !Number.isInteger(raw.version) ||
    !Array.isArray(raw.elements)
  )
    return bad
  if ((raw.version as number) > SCHEMA_VERSION)
    return { status: 'unreadable', reason: 'newer-version', raw }
  if ((raw.version as number) < 1) return bad

  const elements: Element[] = []
  let dropped = 0
  for (const e of raw.elements) {
    const r = ElementSchema.safeParse(e)
    if (r.success) elements.push(r.data)
    else dropped++
  }
  let undo = raw.undo
  let undoDropped = false
  try {
    UndoManager.fromJSON(createScene(), undo as never)
  } catch {
    undo = undefined
    undoDropped = true
  }
  return {
    status: 'ok',
    dropped,
    undoDropped,
    record: {
      version: SCHEMA_VERSION,
      boardId,
      savedAt: Number(raw.savedAt) || 0,
      elements,
      camera: validCamera(raw.camera) ? raw.camera : { ...DEFAULT_CAMERA },
      undo,
    },
  }
}

// --- tab lock: one writer per board ---
type Held = { released: boolean; release: () => void; done: Promise<unknown> }
const held = new Map<string, Held>()

/**
 * Takes the per-board Web Lock for the page lifetime (until `releaseBoardLock`). false = another tab holds it.
 * No `navigator.locks` (old browsers, some test envs) counts as acquired: we cannot tell, and refusing would lock users out.
 * A second call in the same page while we hold the lock returns false.
 */
export function acquireBoardLock(boardId: string): Promise<boolean> {
  const locks = globalThis.navigator?.locks
  if (!locks) return Promise.resolve(true)
  const name = `whiteboard:board:${boardId}`
  const prior = held.get(name)
  if (prior && !prior.released) return Promise.resolve(false)
  let free!: () => void
  const hold = new Promise<void>((r) => {
    free = r
  })
  const entry: Held = {
    released: false,
    release: () => {
      entry.released = true
      free()
    },
    done: Promise.resolve(),
  }
  // Registered synchronously so a release before the grant (React strict-mode remount) is still seen,
  // and the remount waits for the previous request to finish instead of racing it.
  held.set(name, entry)
  const got = new Promise<boolean>((resolve) => {
    entry.done = (prior?.done ?? Promise.resolve())
      .then(() =>
        locks.request(name, { ifAvailable: true }, (lock) => {
          resolve(!!lock)
          return lock ? hold : undefined
        }),
      )
      .catch(() => resolve(true))
  })
  void got.then((ok) => {
    if (!ok && held.get(name) === entry) held.delete(name)
  })
  return got
}

export function releaseBoardLock(boardId: string): void {
  held.get(`whiteboard:board:${boardId}`)?.release()
}

// --- autosave glue ---
export type PersistenceOpts = {
  /** Called with the error when a write fails, and with null when a later write succeeds. */
  onSaveError?: (err: unknown) => void
  onSaved?: () => void
}

/**
 * Binds an Editor to one stored board.
 *  load()  reads the record and applies it to the editor (unreadable => editor stays empty and saving is blocked).
 *  start() begins autosave: commits and camera moves, debounced 500 ms; flush on visibilitychange hidden / pagehide.
 *  stop()  flushes anything pending, then detaches all listeners (idempotent).
 *  flush() writes now if there are unsaved changes; a failed write stays pending and retries on the next change.
 *  startEmptyKeepingBackup() copies the unreadable raw record to `${boardId}:backup:${savedAt}`, then unblocks saving.
 */
export function createPersistence(
  editor: Editor,
  boardId: string,
  opts: PersistenceOpts = {},
) {
  let blocked: Extract<LoadResult, { status: 'unreadable' }> | null = null
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let chain: Promise<void> = Promise.resolve()
  let detach: (() => void) | undefined

  const flush = (): Promise<void> => {
    clearTimeout(timer)
    timer = undefined
    if (blocked || !dirty) return chain
    dirty = false
    const snap = editor.getSnapshot()
    const record: BoardRecord = {
      version: SCHEMA_VERSION,
      boardId,
      savedAt: Date.now(),
      ...snap,
    }
    chain = chain.then(() =>
      saveBoard(boardId, record).then(opts.onSaved, (err) => {
        dirty = true // keep the in-memory board; the next change retries
        opts.onSaveError?.(err)
      }),
    )
    return chain
  }
  const touch = () => {
    dirty = true
    if (blocked) return
    clearTimeout(timer)
    timer = setTimeout(flush, DEBOUNCE_MS)
  }

  return {
    async load(): Promise<LoadResult> {
      const r = await loadBoard(boardId)
      blocked = r.status === 'unreadable' ? r : null
      if (r.status === 'ok')
        editor.setScene(
          r.record.elements,
          r.record.camera,
          r.record.undo as never,
        )
      return r
    },
    start() {
      if (detach) return
      const offs = [editor.onChange(touch), editor.onCameraChange(touch)]
      const hidden = () => {
        if (document.visibilityState === 'hidden') void flush()
      }
      const pagehide = () => void flush()
      document.addEventListener('visibilitychange', hidden)
      window.addEventListener('pagehide', pagehide)
      detach = () => {
        for (const off of offs) off()
        document.removeEventListener('visibilitychange', hidden)
        window.removeEventListener('pagehide', pagehide)
      }
    },
    stop() {
      if (timer) void flush()
      detach?.()
      detach = undefined
    },
    flush,
    async startEmptyKeepingBackup(): Promise<void> {
      if (!blocked) return
      const raw = blocked.raw
      if (raw !== undefined) {
        const at = isObj(raw) && Number(raw.savedAt) ? raw.savedAt : Date.now()
        await put(`${boardId}:backup:${at}`, raw) // throws => stay blocked, original untouched
      }
      blocked = null
      touch()
    },
  }
}

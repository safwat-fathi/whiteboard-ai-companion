import {
  type Camera,
  createScene,
  type Element,
  ElementSchema,
  UndoManager,
  ZOOM_MAX,
  ZOOM_MIN,
} from '@whiteboard/core'
import type { Editor } from './editor'

export const SCHEMA_VERSION = 1
const DB = 'whiteboard'
const STORE = 'boards'
// Commits save after 200 ms of quiet, camera-only moves after 500 ms (a pending commit keeps the earlier deadline).
// Residual loss window: an edit made within ~200 ms of the tab closing/reloading. The visibilitychange-hidden and
// pagehide flushes are best effort only: Chromium may kill the page before an IndexedDB write started there commits.
// Cost ceiling: every save writes the whole board (structured clone). Measured on 20,000 shapes (BENCH=1 pnpm test):
// ElementSchema.safeParse over all ~31 ms, structuredClone ~42 ms, so load validation is well under 600 ms. Upgrade path: separate camera key, skip the full write on camera-only change,
// requestIdleCallback.
const COMMIT_MS = 200
const CAMERA_MS = 500
const RETRY_MS = 5000
const LOCK_RETRIES = 3
const LOCK_RETRY_MS = 250
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
      /** The stored value as found, for the backup copy when something was dropped. */
      raw: unknown
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
    // 'relaxed' durability returns sooner (no fsync wait); older browsers throw or ignore the option.
    let tx: IDBTransaction
    try {
      tx = db.transaction(
        STORE,
        mode,
        mode === 'readwrite' ? { durability: 'relaxed' } : undefined,
      )
    } catch {
      tx = db.transaction(STORE, mode)
    }
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
  Number.isFinite(c.zoom)
const clampCamera = (c: Camera): Camera => ({
  ...c,
  zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, c.zoom)),
})

/** Copies a stored record to `${boardId}:backup:${savedAt}-${now}`; rejects when the write fails. */
const backup = (boardId: string, raw: unknown) => {
  const at = isObj(raw) && Number(raw.savedAt) ? raw.savedAt : Date.now()
  return put(`${boardId}:backup:${at}-${Date.now()}`, raw)
}

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
    const m = UndoManager.fromJSON(createScene(), undo as never)
    undoDropped = m.dropped > 0
    undo = m.toJSON() // only the entries that passed the batch schema
  } catch {
    undo = undefined
    undoDropped = true
  }
  return {
    status: 'ok',
    dropped,
    undoDropped,
    raw,
    record: {
      version: SCHEMA_VERSION,
      boardId,
      savedAt: Number(raw.savedAt) || 0,
      elements,
      camera: validCamera(raw.camera)
        ? clampCamera(raw.camera)
        : { ...DEFAULT_CAMERA },
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
    entry.done = (async () => {
      await prior?.done
      // A same-tab reload can ask before the old page's lock is dropped: retry a denial a few times.
      for (let i = 0; ; i++) {
        let granted = false
        await locks.request(name, { ifAvailable: true }, (lock) => {
          if (!lock) return
          granted = true
          resolve(true)
          return hold
        })
        if (granted) return
        if (i >= LOCK_RETRIES || entry.released) return resolve(false)
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS))
      }
    })().catch(() => resolve(true))
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
 *          If elements or undo entries were dropped it first keeps the stored record as a backup (`canWrite` false skips that
 *          write, for a read-only tab); a failed backup blocks saving like an unreadable record.
 *  start() begins autosave: commits (200 ms) and camera moves (500 ms) debounced; flush on visibilitychange hidden / pagehide.
 *  stop()  ends an open edit (the text tool commits it), flushes anything pending, then detaches all listeners (idempotent).
 *          Call it before editor.dispose(), which cancels the tool after the listeners are gone.
 *  flush() writes now if there are unsaved changes; a failed write stays pending and retries on the next change.
 *  startEmptyKeepingBackup() copies the unreadable raw record to `${boardId}:backup:${savedAt}-${Date.now()}`; if that write fails it stays blocked.
 */
export function createPersistence(
  editor: Editor,
  boardId: string,
  opts: PersistenceOpts = {},
) {
  let blocked: Extract<LoadResult, { status: 'unreadable' }> | null = null
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = 0
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
        dirty = true // keep the in-memory board; retry on the next change or in 5 s
        if (!timer && detach) schedule(RETRY_MS)
        opts.onSaveError?.(err)
      }),
    )
    return chain
  }
  const schedule = (delay: number) => {
    if (timer && pending < delay) return // an earlier deadline is already set
    clearTimeout(timer)
    pending = delay
    timer = setTimeout(flush, delay)
  }
  const touch = (delay: number) => () => {
    dirty = true
    if (!blocked) schedule(delay)
  }

  return {
    async load(canWrite = true): Promise<LoadResult> {
      let r = await loadBoard(boardId)
      // Saving would erase what was dropped for good: keep the stored record first. If that fails, stay blocked, board untouched.
      if (r.status === 'ok' && canWrite && (r.dropped || r.undoDropped))
        try {
          await backup(boardId, r.raw)
        } catch {
          r = { status: 'unreadable', reason: 'unavailable', raw: r.raw }
        }
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
      const offs = [
        editor.onChange(touch(COMMIT_MS)),
        editor.onCameraChange(touch(CAMERA_MS)),
      ]
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
      try {
        // An open text edit commits on cancel: do it while the listeners are still attached so the flush below saves it.
        if (detach) editor.tool.onCancel?.()
      } finally {
        if (timer || dirty) void flush()
        detach?.()
        detach = undefined
      }
    },
    flush,
    async startEmptyKeepingBackup(): Promise<void> {
      if (!blocked) return
      const raw = blocked.raw
      if (raw !== undefined) await backup(boardId, raw) // throws => stay blocked, original untouched
      blocked = null
      touch(COMMIT_MS)()
    },
  }
}

import { BlobError, type BlobStore, hashBytes } from '@whiteboard/core'

const DB = 'whiteboard-blobs'
const STORE = 'blobs'

type StoredBlob = { bytes: Uint8Array; mime: string }

let conn: { factory: IDBFactory; db: Promise<IDBDatabase> } | undefined

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new BlobError('unavailable', 'Browser storage is unavailable'),
    )
  }
  if (conn?.factory === indexedDB) return conn.db
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB, 1)
    } catch {
      conn = undefined
      reject(new BlobError('unavailable', 'Browser storage is unavailable'))
      return
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => {
      req.result.onclose = req.result.onversionchange = () => {
        conn = undefined
        req.result.close()
      }
      resolve(req.result)
    }
    req.onerror = () => {
      conn = undefined
      reject(new BlobError('unavailable', 'Browser storage is unavailable'))
    }
  })
  conn = { factory: indexedDB, db }
  return db
}

function mapIdbError(err: unknown): BlobError {
  if (err instanceof BlobError) return err
  const name = (err as { name?: string } | null)?.name ?? ''
  if (name === 'QuotaExceededError') {
    return new BlobError('quota', 'Browser storage is full (quota exceeded)')
  }
  return new BlobError('unavailable', 'Browser storage is unavailable')
}

async function runTx<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(
        STORE,
        mode,
        mode === 'readwrite' ? { durability: 'relaxed' } : undefined,
      )
    } catch {
      try {
        tx = db.transaction(STORE, mode)
      } catch (e) {
        reject(mapIdbError(e))
        return
      }
    }
    let req: IDBRequest<T>
    try {
      req = op(tx.objectStore(STORE))
    } catch (e) {
      reject(mapIdbError(e))
      return
    }
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = tx.onabort = () => reject(mapIdbError(tx.error ?? req.error))
  })
}

export function createIdbBlobStore(): BlobStore {
  return {
    async has(id: string): Promise<boolean> {
      try {
        const count = await runTx('readonly', (s) => s.count(id))
        return count > 0
      } catch {
        return false
      }
    },

    async get(id: string): Promise<StoredBlob | undefined> {
      try {
        const rec = await runTx<StoredBlob | undefined>('readonly', (s) =>
          s.get(id),
        )
        if (!rec?.bytes) return undefined
        const raw = rec.bytes as ArrayBufferView | ArrayBuffer
        const view = ArrayBuffer.isView(raw)
          ? new Uint8Array(
              raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
            )
          : raw instanceof ArrayBuffer
            ? new Uint8Array(raw.slice(0))
            : null
        if (!view) return undefined
        return { bytes: view, mime: String(rec.mime) }
      } catch {
        return undefined
      }
    },

    async put(bytes: Uint8Array, mime: string): Promise<string> {
      const id = await hashBytes(bytes)
      const exists = await runTx('readonly', (s) => s.count(id))
      if (exists > 0) return id
      await runTx('readwrite', (s) =>
        s.put({ bytes: new Uint8Array(bytes), mime }, id),
      )
      return id
    },
  }
}

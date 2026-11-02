// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireBoardLock,
  createPersistence,
  loadBoard,
  releaseBoardLock,
  SCHEMA_VERSION,
  saveBoard,
} from './persist'
import { mk, put, setup } from './test-utils'

let t: ReturnType<typeof setup>
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  t = setup()
})
afterEach(() => {
  t.done()
  vi.useRealTimers()
})

const rec = (over: Record<string, unknown> = {}) => ({
  version: SCHEMA_VERSION,
  boardId: 'local',
  savedAt: 1000,
  elements: [],
  camera: { x: 0, y: 0, zoom: 1 },
  undo: { undo: [], redo: [], maxDepth: 200 },
  ...over,
})
const raw = (key: string, value: unknown) =>
  new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('whiteboard', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('boards')
    open.onsuccess = () => {
      const tx = open.result.transaction('boards', 'readwrite')
      tx.objectStore('boards').put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    }
  })
const rawGet = (key: string) =>
  new Promise<unknown>((resolve) => {
    const open = indexedDB.open('whiteboard', 1)
    open.onsuccess = () => {
      const r = open.result.transaction('boards').objectStore('boards').get(key)
      r.onsuccess = () => resolve(r.result)
    }
  })

describe('load / save', () => {
  it('empty when nothing stored', async () => {
    expect(await loadBoard('local')).toEqual({ status: 'empty' })
  })

  it('round trip restores elements, camera and a working undo stack', async () => {
    put(t.ed, mk('a', 10, 10))
    t.ed.camera = { x: 5, y: 6, zoom: 2 }
    const p = createPersistence(t.ed, 'local')
    p.start()
    await p.flush() // not dirty yet: camera set directly
    t.ed.commit({
      batchId: 'm',
      label: 'm',
      ops: [{ op: 'add', el: mk('b', 50, 50) }],
    })
    await p.flush()
    p.stop()

    const t2 = setup()
    const p2 = createPersistence(t2.ed, 'local')
    const r = await p2.load()
    expect(r.status).toBe('ok')
    expect([...t2.ed.scene.els.keys()].sort()).toEqual(['a', 'b'])
    expect(t2.ed.camera).toEqual({ x: 5, y: 6, zoom: 2 })
    t2.ed.undoOnce()
    expect([...t2.ed.scene.els.keys()]).toEqual(['a'])
    t2.done()
  })

  it('drops invalid elements and counts them', async () => {
    await raw('local', rec({ elements: [mk('a', 0, 0), { id: 'x' }] }))
    const r = await loadBoard('local')
    expect(r).toMatchObject({ status: 'ok', dropped: 1 })
    if (r.status === 'ok') expect(r.record.elements).toHaveLength(1)
  })

  it('falls back to the default camera and a fresh undo when those are invalid', async () => {
    await raw('local', rec({ camera: { x: 'a' }, undo: 'junk' }))
    const r = await loadBoard('local')
    expect(r).toMatchObject({ status: 'ok', undoDropped: true })
    if (r.status === 'ok')
      expect(r.record.camera).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('newer version is unreadable', async () => {
    await raw('local', rec({ version: 2 }))
    expect(await loadBoard('local')).toMatchObject({
      status: 'unreadable',
      reason: 'newer-version',
    })
  })

  it('missing indexedDB => unavailable, editor still works in memory', async () => {
    vi.stubGlobal('indexedDB', undefined)
    expect(await loadBoard('local')).toEqual({
      status: 'unreadable',
      reason: 'unavailable',
    })
    const p = createPersistence(t.ed, 'local')
    await p.load()
    p.start()
    expect(() => put(t.ed, mk('a', 0, 0))).not.toThrow()
    await expect(p.flush()).resolves.toBeUndefined()
    expect(t.ed.scene.els.size).toBe(1)
    p.stop()
  })
})

describe('corrupt record', () => {
  const bad = { version: 1, elements: 'nope', savedAt: 77 }
  it('is unreadable and autosave never overwrites it', async () => {
    await raw('local', bad)
    const p = createPersistence(t.ed, 'local')
    expect(await p.load()).toMatchObject({
      status: 'unreadable',
      reason: 'corrupt',
    })
    p.start()
    put(t.ed, mk('a', 0, 0))
    await p.flush()
    p.stop()
    expect(await rawGet('local')).toEqual(bad)
  })

  it('startEmptyKeepingBackup writes the backup first, then allows saving', async () => {
    await raw('local', bad)
    const p = createPersistence(t.ed, 'local')
    await p.load()
    p.start()
    await p.startEmptyKeepingBackup()
    expect(await rawGet('local:backup:77')).toEqual(bad)
    put(t.ed, mk('a', 0, 0))
    await p.flush()
    expect(await rawGet('local')).toMatchObject({
      version: 1,
      elements: [{ id: 'a' }],
    })
    p.stop()
  })
})

describe('autosave scheduling', () => {
  it('debounces many commits into one write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put')
    const p = createPersistence(t.ed, 'local')
    p.start()
    for (let i = 0; i < 5; i++) {
      put(t.ed, mk(`e${i}`, i, 0))
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(spy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    vi.useRealTimers()
    await p.flush() // waits for the in-flight write
    expect(spy).toHaveBeenCalledTimes(1)
    p.stop()
  })

  it('camera-only changes save', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = createPersistence(t.ed, 'local')
    p.start()
    t.ed.panBy(-100, 0)
    await vi.advanceTimersByTimeAsync(600)
    vi.useRealTimers()
    expect(await rawGet('local')).toMatchObject({ camera: { x: 100 } })
    p.stop()
  })

  it.each([
    [
      'visibilitychange hidden',
      () => {
        Object.defineProperty(document, 'visibilityState', {
          value: 'hidden',
          configurable: true,
        })
        document.dispatchEvent(new Event('visibilitychange'))
      },
    ],
    ['pagehide', () => window.dispatchEvent(new Event('pagehide'))],
  ])('flushes immediately on %s', async (_n, fire) => {
    const p = createPersistence(t.ed, 'local')
    p.start()
    put(t.ed, mk('a', 0, 0))
    fire()
    await p.flush()
    expect(await rawGet('local')).toMatchObject({ elements: [{ id: 'a' }] })
    p.stop()
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    })
  })

  it('a failed write notifies, keeps the board and retries on the next change', async () => {
    const onSaveError = vi.fn()
    const onSaved = vi.fn()
    const p = createPersistence(t.ed, 'local', { onSaveError, onSaved })
    p.start()
    const spy = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementationOnce(() => {
        throw new DOMException('full', 'QuotaExceededError')
      })
    put(t.ed, mk('a', 0, 0))
    await p.flush()
    expect(onSaveError).toHaveBeenCalledOnce()
    expect(t.ed.scene.els.size).toBe(1)
    spy.mockRestore()
    put(t.ed, mk('b', 20, 0))
    await p.flush()
    expect(onSaved).toHaveBeenCalledOnce()
    expect(await rawGet('local')).toMatchObject({
      elements: [{ id: 'a' }, { id: 'b' }],
    })
    p.stop()
  })
})

describe('saveBoard', () => {
  it('writes the record verbatim', async () => {
    await saveBoard('x', rec({ boardId: 'x' }) as never)
    expect(await rawGet('x')).toMatchObject({ boardId: 'x' })
  })
})

describe('acquireBoardLock', () => {
  // Minimal faithful Web Locks: exclusive, ifAvailable resolves callback(null) when held, held until callback promise settles.
  const fakeLocks = () => {
    const heldNames = new Set<string>()
    return {
      request: async (
        name: string,
        _o: unknown,
        cb: (l: unknown) => unknown,
      ) => {
        if (heldNames.has(name)) return cb(null)
        heldNames.add(name)
        try {
          return await cb({ name })
        } finally {
          heldNames.delete(name)
        }
      },
    }
  }
  it('second acquire is refused, release frees it, strict-mode style remount works', async () => {
    vi.stubGlobal('navigator', { locks: fakeLocks() })
    expect(await acquireBoardLock('b')).toBe(true)
    expect(await acquireBoardLock('b')).toBe(false)
    releaseBoardLock('b')
    expect(await acquireBoardLock('b')).toBe(true)
    // release immediately after the call, before the grant, then re-acquire at once
    const first = acquireBoardLock('c')
    releaseBoardLock('c')
    const second = acquireBoardLock('c')
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    releaseBoardLock('b')
    releaseBoardLock('c')
  })

  it('a lock held by another page refuses', async () => {
    const locks = fakeLocks()
    vi.stubGlobal('navigator', { locks })
    void locks.request('whiteboard:board:z', {}, () => new Promise(() => {}))
    expect(await acquireBoardLock('z')).toBe(false)
  })

  it('no navigator.locks counts as acquired', async () => {
    vi.stubGlobal('navigator', {})
    expect(await acquireBoardLock('d')).toBe(true)
  })
})

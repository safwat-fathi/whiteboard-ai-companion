// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { ElementSchema, ordered, ZOOM_MAX, ZOOM_MIN } from '@whiteboard/core'
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

const rawKeys = () =>
  new Promise<string[]>((resolve) => {
    const open = indexedDB.open('whiteboard', 1)
    open.onsuccess = () => {
      const r = open.result
        .transaction('boards')
        .objectStore('boards')
        .getAllKeys()
      r.onsuccess = () => resolve(r.result as string[])
    }
  })
const FAKE = {
  toFake: ['setTimeout', 'clearTimeout'] as ('setTimeout' | 'clearTimeout')[],
}

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
    const keys = await rawKeys()
    const backup = keys.find((k) => k.startsWith('local:backup:77-'))
    expect(backup).toBeDefined()
    expect(await rawGet(backup as string)).toEqual(bad)
    put(t.ed, mk('a', 0, 0))
    await p.flush()
    expect(await rawGet('local')).toMatchObject({
      version: 1,
      elements: [{ id: 'a' }],
    })
    p.stop()
  })
})

describe('stored undo history is validated entry by entry', () => {
  const entry = (
    set: Record<string, unknown>,
    back: Record<string, unknown>,
  ) => ({
    original: {
      batchId: 'o',
      label: 'Move',
      ops: [{ op: 'patch', id: 'a', set }],
    },
    inverse: {
      batchId: 'i',
      label: 'Undo Move',
      ops: [{ op: 'patch', id: 'a', set: back }],
    },
  })
  const stored = (undo: unknown) =>
    rec({ elements: [mk('a', 10, 10)], undo, savedAt: 7 })

  it('drops the bad entries, keeps the good ones, reports undoDropped and keeps a backup', async () => {
    const good = entry({ x: 10 }, { x: 0 })
    const undo = {
      undo: [good, { original: 1 }, null],
      redo: [],
      maxDepth: 200,
    }
    await raw('local', stored(undo))
    const p = createPersistence(t.ed, 'local')
    const r = await p.load()
    expect(r).toMatchObject({ status: 'ok', dropped: 0, undoDropped: true })
    expect(t.ed.undo.toJSON().undo).toEqual([good])
    expect(
      (await rawKeys()).filter((k) => k.startsWith('local:backup:7-')),
    ).toHaveLength(1)
    t.ed.undoOnce()
    expect((t.ed.scene.els.get('a') as { x: number }).x).toBe(0)
  })

  it('a stored entry that passes the schema but cannot be applied never makes undo throw', async () => {
    // the original matches the live element, so the inverse is applied; w must be >= 0, so applying it fails validation
    const undo = {
      undo: [entry({ w: 100 }, { w: -1 })],
      redo: [],
      maxDepth: 200,
    }
    await raw('local', stored(undo))
    const p = createPersistence(t.ed, 'local')
    await p.load()
    expect(() => t.ed.undoOnce()).not.toThrow()
    expect(t.ed.undo.canUndo).toBe(false) // the entry is consumed
    expect((t.ed.scene.els.get('a') as { w: number }).w).toBe(100)
  })
})

describe('stored undo entries with hostile patch paths', () => {
  it.each([
    ['a path through a number', { 'x.y': 1 }],
    ['a path through a string leaf', { 'data.kind.foo': 1 }],
    ['an unknown field', { nope: 1 }],
    ['a protected field', { id: 'z' }],
    ['__proto__', JSON.parse('{"__proto__": {"x": 1}}')],
  ])('%s: undo does not throw and changes nothing', async (_n, back) => {
    const undo = {
      undo: [
        {
          original: {
            batchId: 'o',
            label: 'Move',
            ops: [{ op: 'patch', id: 'a', set: { w: 100 } }],
          },
          inverse: {
            batchId: 'i',
            label: 'Undo Move',
            ops: [{ op: 'patch', id: 'a', set: back }],
          },
        },
      ],
      redo: [],
      maxDepth: 200,
    }
    await raw('local', rec({ elements: [mk('a', 10, 10)], undo, savedAt: 7 }))
    const p = createPersistence(t.ed, 'local')
    await p.load()
    const before = structuredClone(ordered(t.ed.scene))
    expect(() => t.ed.undoOnce()).not.toThrow()
    expect(ordered(t.ed.scene)).toEqual(before)
  })
})

describe('dropped data is backed up before saving starts', () => {
  const original = () =>
    rec({ elements: [mk('a', 0, 0), { id: 'x' }], savedAt: 42 })
  const backupKeys = async () =>
    (await rawKeys()).filter((k) => k.startsWith('local:backup:42-'))

  it('writes the stored record as found, loads the valid elements, and the next save leaves the backup alone', async () => {
    await raw('local', original())
    const p = createPersistence(t.ed, 'local')
    const r = await p.load()
    expect(r).toMatchObject({ status: 'ok', dropped: 1 })
    expect([...t.ed.scene.els.keys()]).toEqual(['a'])
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 5000)
    await createPersistence(t.ed, 'local').load() // reloaded before any save: the same backup key, not a second copy
    vi.useRealTimers()
    const [key, ...more] = await backupKeys()
    expect(more).toEqual([])
    expect(await rawGet(key as string)).toEqual(original())
    p.start()
    t.ed.panBy(5, 0)
    await p.flush()
    expect(
      ((await rawGet('local')) as { elements: unknown[] }).elements,
    ).toHaveLength(1) // the invalid element is gone from the live record
    expect(await rawGet(key as string)).toEqual(original()) // but not from the backup
    p.stop()
  })

  it.each([
    ['no savedAt', undefined],
    ['a savedAt that is not a number', 'soon'],
    ['a savedAt of 0', 0],
  ])(
    'a stored record with %s still gets one backup key, however often it is reloaded',
    async (_n, savedAt) => {
      const undated = rec({ elements: [mk('a', 0, 0), { id: 'x' }], savedAt })
      await raw('local', undated)
      for (let i = 0; i < 3; i++) {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(Date.now() + i * 5000)
        await createPersistence(t.ed, 'local').load()
        vi.useRealTimers()
      }
      expect((await rawKeys()).sort()).toEqual([
        'local',
        'local:backup:undated-dropped',
      ])
      expect(await rawGet('local:backup:undated-dropped')).toEqual(undated)
    },
  )

  it('does nothing when nothing was dropped, or when this tab may not write', async () => {
    await raw('local', rec({ elements: [mk('a', 0, 0)] }))
    await createPersistence(t.ed, 'local').load()
    expect(await rawKeys()).toEqual(['local'])
    await raw('local', original())
    await createPersistence(t.ed, 'local').load(false)
    expect(await rawKeys()).toEqual(['local'])
  })

  it('a failed backup write still loads the valid elements, blocks saving and leaves the stored record untouched', async () => {
    await raw('local', original())
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const p = createPersistence(t.ed, 'local')
    expect(await p.load()).toMatchObject({
      status: 'ok',
      dropped: 1,
      backupFailed: true,
    })
    expect([...t.ed.scene.els.keys()]).toEqual(['a']) // the board is not empty
    p.start()
    put(t.ed, mk('b', 1, 1))
    await p.flush()
    await p.startEmptyKeepingBackup() // not an unreadable record: nothing to unblock
    put(t.ed, mk('c', 2, 2))
    await p.flush()
    p.stop()
    expect(await rawGet('local')).toEqual(original())
    expect(await rawKeys()).toEqual(['local'])
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
    await loadBoard('local') // creates the database, so polling it below cannot race the first write
    vi.useFakeTimers(FAKE) // the 200 ms debounce must not be what saves
    const p = createPersistence(t.ed, 'local')
    p.start()
    put(t.ed, mk('a', 0, 0))
    fire()
    vi.useRealTimers() // drops the pending fake debounce timer; no explicit flush: only the event's own flush can write
    await vi.waitFor(async () =>
      expect(await rawGet('local')).toMatchObject({ elements: [{ id: 'a' }] }),
    )
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

describe('hardening', () => {
  it('clamps a stored zoom into range', async () => {
    for (const zoom of [1e300, 0]) {
      await raw('local', rec({ camera: { x: 1, y: 2, zoom } }))
      const r = await loadBoard('local')
      if (r.status !== 'ok') throw new Error('expected ok')
      expect(r.record.camera.zoom).toBe(zoom ? ZOOM_MAX : ZOOM_MIN)
    }
  })

  it.each([
    ['newer-version', { version: 2, elements: [] }],
    ['unavailable', null],
  ])('%s: autosave after edits never writes', async (reason, stored) => {
    if (stored) await raw('local', stored)
    else vi.stubGlobal('indexedDB', undefined)
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put')
    const p = createPersistence(t.ed, 'local')
    expect(await p.load()).toMatchObject({ status: 'unreadable', reason })
    p.start()
    put(t.ed, mk('a', 0, 0))
    t.ed.panBy(5, 5)
    await p.flush()
    p.stop()
    expect(spy).not.toHaveBeenCalled()
    if (stored) expect(await rawGet('local')).toEqual(stored)
  })

  it('a failed backup write keeps the board blocked', async () => {
    const bad = { version: 1, elements: 'nope', savedAt: 5 }
    await raw('local', bad)
    const p = createPersistence(t.ed, 'local')
    await p.load()
    p.start()
    const spy = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementationOnce(() => {
        throw new DOMException('full', 'QuotaExceededError')
      })
    await expect(p.startEmptyKeepingBackup()).rejects.toThrow()
    spy.mockRestore()
    put(t.ed, mk('a', 0, 0))
    await p.flush()
    p.stop()
    expect(await rawGet('local')).toEqual(bad)
  })

  it('retries a failed write after 5 s with no further change', async () => {
    const onSaved = vi.fn()
    const p = createPersistence(t.ed, 'local', { onSaved })
    p.start()
    await loadBoard('local') // opens the connection so writes start in microtasks
    vi.useFakeTimers(FAKE)
    const spy = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementationOnce(() => {
        throw new DOMException('full', 'QuotaExceededError')
      })
    put(t.ed, mk('a', 0, 0))
    await vi.advanceTimersByTimeAsync(200)
    expect(spy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4900)
    expect(spy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(spy).toHaveBeenCalledTimes(2)
    p.stop()
  })
})

describe('debounce deadlines', () => {
  const setupTimed = async () => {
    await loadBoard('local')
    vi.useFakeTimers(FAKE)
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put')
    const p = createPersistence(t.ed, 'local')
    p.start()
    return { spy, p }
  }
  it('commit saves at 200 ms', async () => {
    const { spy, p } = await setupTimed()
    put(t.ed, mk('a', 0, 0))
    await vi.advanceTimersByTimeAsync(199)
    expect(spy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(spy).toHaveBeenCalledTimes(1)
    p.stop()
  })
  it('camera-only saves at 500 ms', async () => {
    const { spy, p } = await setupTimed()
    t.ed.panBy(10, 0)
    await vi.advanceTimersByTimeAsync(499)
    expect(spy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(spy).toHaveBeenCalledTimes(1)
    p.stop()
  })
  it('a commit after a camera move takes the earlier deadline', async () => {
    const { spy, p } = await setupTimed()
    t.ed.panBy(10, 0)
    await vi.advanceTimersByTimeAsync(100)
    put(t.ed, mk('a', 0, 0))
    await vi.advanceTimersByTimeAsync(200)
    expect(spy).toHaveBeenCalledTimes(1)
    p.stop()
  })
})

describe('an open text draft', () => {
  const typeInto = (v: string) => {
    const ta = t.ed.host.querySelector('textarea') as HTMLTextAreaElement
    ta.value = v
    ta.dispatchEvent(new Event('input'))
  }
  const stored = async () =>
    (
      (await rawGet('local')) as
        | { elements: { id: string; data: { text?: string } }[] }
        | undefined
    )?.elements.map((e) => e.data.text)
  const startText = () => {
    t.ed.setTool('text')
    t.ed.tool.onPointerDown({
      screen: { x: 9, y: 9 },
      world: { x: 9, y: 9 },
      shift: false,
      alt: false,
      button: 0,
      pointerType: 'mouse',
    })
    t.ed.tool.onPointerUp({
      screen: { x: 9, y: 9 },
      world: { x: 9, y: 9 },
      shift: false,
      alt: false,
      button: 0,
      pointerType: 'mouse',
    })
  }

  it('is saved by the 200 ms debounce while the textarea is still open, then follows the final commit', async () => {
    await loadBoard('local') // opens the connection so writes start in microtasks
    vi.useFakeTimers(FAKE)
    const p = createPersistence(t.ed, 'local')
    p.start()
    startText()
    typeInto('مرحبا')
    await vi.advanceTimersByTimeAsync(199)
    expect(await stored()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    vi.useRealTimers()
    await p.flush()
    expect(await stored()).toEqual(['مرحبا'])
    expect(t.ed.scene.els.size).toBe(0) // never committed
    expect(t.ed.undo.canUndo).toBe(false)
    p.stop()
  })

  it('pagehide flushes the draft; an empty draft adds no element', async () => {
    // Types `v`, fires a real pagehide with the debounce timer faked and then dropped, and waits for the store: nothing
    // but the pagehide listener can have saved it (no explicit flush).
    const hideWith = async (v: string, want: string[]) => {
      vi.useFakeTimers(FAKE)
      typeInto(v)
      window.dispatchEvent(new Event('pagehide'))
      vi.useRealTimers()
      await vi.waitFor(async () => expect(await stored()).toEqual(want))
    }
    await loadBoard('local') // creates the database, so polling it cannot race the first write
    const p = createPersistence(t.ed, 'local')
    p.start()
    startText()
    await hideWith('  ', []) // a board with no elements: no empty text element
    await hideWith('hello', ['hello'])
    await hideWith('', [])
    p.stop()
  })

  it('an edit of an existing text saves its draft content in place', async () => {
    const p = createPersistence(t.ed, 'local')
    p.start()
    startText()
    typeInto('old')
    t.ed.tool.onCancel?.() // commit
    const id = [...t.ed.scene.els.keys()][0] as string
    t.ed.editText(id)
    typeInto('new text')
    await p.flush()
    expect(await stored()).toEqual(['new text'])
    expect(
      (t.ed.scene.els.get(id) as { data: { text: string } }).data.text,
    ).toBe('old')
    p.stop()
  })
})

describe('stop', () => {
  it('commits an open text edit first, then flushes, so the saved board has the edit and its undo entry', async () => {
    const p = createPersistence(t.ed, 'local')
    p.start()
    t.ed.setTool('text')
    const at = { x: 9, y: 9 }
    const e = {
      screen: at,
      world: at,
      shift: false,
      alt: false,
      button: 0,
      pointerType: 'mouse',
    }
    t.ed.tool.onPointerDown(e)
    t.ed.tool.onPointerUp(e)
    const ta = t.ed.host.querySelector('textarea') as HTMLTextAreaElement
    ta.value = 'last words'
    ta.dispatchEvent(new Event('input'))
    p.stop() // what the page's cleanup calls before dispose()
    await p.flush()
    const saved = (await rawGet('local')) as {
      elements: { data: { text: string } }[]
      undo: { undo: { original: { label: string } }[] }
    }
    expect(saved.elements.map((x) => x.data.text)).toEqual(['last words'])
    expect(saved.undo.undo.map((x) => x.original.label)).toEqual(['Add Text'])
  })
})

describe('stop when ending the open edit throws', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not rethrow, still flushes the pending change and detaches', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = createPersistence(t.ed, 'local')
    p.start()
    put(t.ed, mk('a', 0, 0))
    t.ed.setTool('select') // the Hand tool has no onCancel (the editor starts on Hand), so spy on a tool that does
    vi.spyOn(t.ed.tool, 'onCancel').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => p.stop()).not.toThrow()
    expect(err).toHaveBeenCalled() // logged, not swallowed silently
    await p.flush() // waits for the write stop() started
    expect(await rawGet('local')).toMatchObject({ elements: [{ id: 'a' }] })
    put(t.ed, mk('b', 20, 0)) // detached: this change is not picked up
    await p.flush()
    expect(await rawGet('local')).toMatchObject({ elements: [{ id: 'a' }] })
    expect(() => p.stop()).not.toThrow() // still idempotent
  })

  it('a snapshot that throws before the edit is ended is logged too, and the listeners still detach', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = createPersistence(t.ed, 'local')
    p.start()
    put(t.ed, mk('a', 0, 0))
    vi.spyOn(t.ed, 'getSnapshot').mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(() => p.stop()).not.toThrow()
    expect(err).toHaveBeenCalled()
    await p.flush()
    expect(await rawGet('local')).toMatchObject({ elements: [{ id: 'a' }] })
    put(t.ed, mk('b', 20, 0)) // detached: not picked up
    await p.flush()
    expect(await rawGet('local')).toMatchObject({ elements: [{ id: 'a' }] })
  })

  it('a snapshot that keeps throwing never escapes stop(), and the listeners are already detached when the write fails', async () => {
    vi.useFakeTimers(FAKE)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = createPersistence(t.ed, 'local')
    p.start()
    put(t.ed, mk('a', 0, 0))
    vi.spyOn(t.ed, 'getSnapshot').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => p.stop()).not.toThrow() // the final write throws too
    expect(err).toHaveBeenCalledTimes(2) // the snapshot before ending the edit, and the write
    expect(vi.getTimerCount()).toBe(0)
    put(t.ed, mk('b', 20, 0))
    expect(vi.getTimerCount()).toBe(0) // detached: this change schedules nothing
    expect(() => p.stop()).not.toThrow()
  })

  it('a commit that throws while ending a text edit saves the board with the draft, not without it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const draft = async () =>
      (
        (await rawGet('local')) as { elements: { data: { text: string } }[] }
      ).elements.map((e) => e.data.text)
    const p = createPersistence(t.ed, 'local')
    p.start()
    t.ed.setTool('text')
    const at = { x: 9, y: 9 }
    const e = {
      screen: at,
      world: at,
      shift: false,
      alt: false,
      button: 0,
      pointerType: 'mouse',
    }
    t.ed.tool.onPointerDown(e)
    t.ed.tool.onPointerUp(e)
    const ta = t.ed.host.querySelector('textarea') as HTMLTextAreaElement
    ta.value = 'saved by the debounce'
    ta.dispatchEvent(new Event('input'))
    await p.flush()
    expect(await draft()).toEqual(['saved by the debounce'])
    ta.value = 'typed after that'
    ta.dispatchEvent(new Event('input'))
    vi.spyOn(t.ed, 'commit').mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(() => p.stop()).not.toThrow()
    await p.flush()
    expect(await draft()).toEqual(['typed after that'])
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

  it('a lock held by another page refuses after the retries', async () => {
    vi.useFakeTimers(FAKE)
    const locks = fakeLocks()
    vi.stubGlobal('navigator', { locks })
    void locks.request('whiteboard:board:z', {}, () => new Promise(() => {}))
    const got = acquireBoardLock('z')
    await vi.advanceTimersByTimeAsync(749)
    let settled = false
    void got.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await got).toBe(false)
  })

  it('a lock dropped by an old page (reload) 300 ms later is acquired', async () => {
    vi.useFakeTimers(FAKE)
    const locks = fakeLocks()
    vi.stubGlobal('navigator', { locks })
    let drop!: () => void
    void locks.request(
      'whiteboard:board:r',
      {},
      () => new Promise<void>((r) => (drop = r)),
    )
    const got = acquireBoardLock('r')
    await vi.advanceTimersByTimeAsync(300)
    drop()
    await vi.advanceTimersByTimeAsync(300)
    expect(await got).toBe(true)
    releaseBoardLock('r')
  })

  it('no navigator.locks counts as acquired', async () => {
    vi.stubGlobal('navigator', {})
    expect(await acquireBoardLock('d')).toBe(true)
  })
})

// Run with BENCH=1 pnpm --filter @whiteboard/web test. Numbers are reported, not asserted.
describe('bench', () => {
  it.skipIf(!process.env.BENCH)('20k element validation and clone', () => {
    const els = Array.from({ length: 20000 }, (_, i) => mk(`e${i}`, i, i))
    let a = performance.now()
    const ok = els.filter((e) => ElementSchema.safeParse(e).success).length
    const parse = performance.now() - a
    a = performance.now()
    structuredClone(els)
    const clone = performance.now() - a
    console.log(
      `BENCH parse ${parse.toFixed(0)} ms (${ok}), clone ${clone.toFixed(0)} ms`,
    )
  })
})

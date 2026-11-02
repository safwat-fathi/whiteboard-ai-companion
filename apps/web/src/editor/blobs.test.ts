// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { type BlobError, hashBytes } from '@whiteboard/core'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdbBlobStore } from './blobs'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

describe('createIdbBlobStore', () => {
  it('stores, retrieves, checks existence, and deduplicates by SHA-256 hash', async () => {
    const store = createIdbBlobStore()
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const expectedId = await hashBytes(bytes)

    expect(await store.has(expectedId)).toBe(false)
    expect(await store.get(expectedId)).toBeUndefined()

    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put')
    const id1 = await store.put(bytes, 'image/png')
    const id2 = await store.put(bytes, 'image/png')
    expect(id1).toBe(expectedId)
    expect(id2).toBe(expectedId)
    // Second put of identical bytes is deduplicated
    expect(putSpy).toHaveBeenCalledTimes(1)
    putSpy.mockRestore()

    expect(await store.has(expectedId)).toBe(true)
    const got = await store.get(expectedId)
    expect(got).toBeDefined()
    expect(got?.mime).toBe('image/png')
    expect(Array.from(got?.bytes ?? [])).toEqual([1, 2, 3, 4, 5])
  })

  it('maps QuotaExceededError on put to BlobError("quota")', async () => {
    const store = createIdbBlobStore()
    const spy = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementationOnce(() => {
        throw new DOMException('Storage full', 'QuotaExceededError')
      })
    await expect(
      store.put(new Uint8Array([9, 8, 7]), 'image/png'),
    ).rejects.toMatchObject({
      name: 'BlobError',
      code: 'quota',
    } satisfies Partial<BlobError>)
    spy.mockRestore()
  })

  it('maps missing indexedDB to BlobError("unavailable") on put and returns undefined on get', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const store = createIdbBlobStore()
    await expect(
      store.put(new Uint8Array([1, 2]), 'image/png'),
    ).rejects.toMatchObject({
      name: 'BlobError',
      code: 'unavailable',
    } satisfies Partial<BlobError>)
    expect(await store.get('a'.repeat(64))).toBeUndefined()
    expect(await store.has('a'.repeat(64))).toBe(false)
    vi.unstubAllGlobals()
  })
})

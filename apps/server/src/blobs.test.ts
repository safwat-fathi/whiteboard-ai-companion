import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlobError, hashBytes } from '@whiteboard/core'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { gif, jpeg, png, webp } from '../../../packages/core/src/test-images'
import { createDiskBlobStore, isBlobId } from './blobs'
import { createBlobsDb, openDatabase } from './db'

const roots: string[] = []
const dbs: Database.Database[] = []
const setup = (maxBytes?: number) => {
  const root = mkdtempSync(join(tmpdir(), 'wb-blobs-'))
  roots.push(root)
  const dataDir = join(root, 'data')
  const db = openDatabase({ dataDir })
  dbs.push(db)
  const store = createDiskBlobStore({
    dataDir,
    db: createBlobsDb(db),
    maxBytes,
  })
  return { root, dataDir, db, store }
}
afterEach(() => {
  for (const d of dbs.splice(0)) if (d.open) d.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const ascii = (s: string) => new TextEncoder().encode(s)
const PNG = png(10, 10, 32, 7)
const JPEG = jpeg(10, 10, 32, 7)
const GIF = gif(10, 10, 32, 7)
const WEBP = webp(10, 10, 32, 7)
/** A PNG with a valid header and exactly `n` bytes in all. */
const pngOfSize = (n: number) => png(10, 10, n - png(10, 10).length, 7)

describe('disk blob store', () => {
  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/gif', GIF],
    ['image/webp', WEBP],
  ])(
    'stores %s and reads it back byte-equal with the sniffed type',
    async (mime, bytes) => {
      const { store } = setup()
      const id = await store.put(bytes, 'application/octet-stream') // the claimed type is ignored
      expect(id).toBe(await hashBytes(bytes))
      expect(await store.has(id)).toBe(true)
      const got = await store.get(id)
      expect(got?.mime).toBe(mime)
      expect(Array.from(got?.bytes ?? [])).toEqual(Array.from(bytes))
    },
  )

  it('lays files out as blobs/ab/cd/<id>', async () => {
    const { store, dataDir } = setup()
    const id = await store.put(PNG, 'image/png')
    expect(store.path(id)).toBe(
      join(dataDir, 'blobs', id.slice(0, 2), id.slice(2, 4), id),
    )
    expect(existsSync(store.path(id))).toBe(true)
  })

  it('stores the same bytes once: one id, one file, one row', async () => {
    const { store, db } = setup()
    const a = await store.put(PNG, 'image/png')
    const b = await store.put(PNG, 'image/png')
    expect(a).toBe(b)
    expect(db.prepare('SELECT count(*) AS n FROM blobs').get()).toEqual({
      n: 1,
    })
  })

  it('survives ten concurrent identical puts with no error, one file and no leftover temp file', async () => {
    const { store, db } = setup()
    const ids = await Promise.all(
      Array.from({ length: 10 }, () => store.put(JPEG, 'image/jpeg')),
    )
    expect(new Set(ids).size).toBe(1)
    const id = ids[0] as string
    expect(readdirSync(join(store.path(id), '..'))).toEqual([id])
    expect(db.prepare('SELECT count(*) AS n FROM blobs').get()).toEqual({
      n: 1,
    })
  })

  it('refuses SVG, HTML, text and empty input as unsupported', async () => {
    const { store, dataDir } = setup()
    for (const bad of [
      ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      ascii('<!doctype html><script>alert(1)</script>'),
      ascii('hello'),
      new Uint8Array(0),
    ])
      await expect(store.put(bad, 'image/png')).rejects.toMatchObject({
        name: 'BlobError',
        code: 'unsupported',
      })
    expect(existsSync(join(dataDir, 'blobs'))).toBe(false)
  })

  it('refuses more than maxBytes as too-large and writes nothing', async () => {
    const { store, db, dataDir } = setup(100)
    await expect(store.put(pngOfSize(101), 'image/png')).rejects.toBeInstanceOf(
      BlobError,
    )
    await expect(store.put(pngOfSize(101), 'image/png')).rejects.toMatchObject({
      code: 'too-large',
    })
    expect(await store.put(pngOfSize(100), 'image/png')).toMatch(
      /^[0-9a-f]{64}$/,
    )
    expect(db.prepare('SELECT count(*) AS n FROM blobs').get()).toEqual({
      n: 1,
    })
    expect(existsSync(dataDir)).toBe(true)
  })

  it.each([
    ['PNG wider than 8192', png(8193, 10)],
    ['JPEG taller than 8192', jpeg(10, 9000)],
    ['GIF wider than 8192', gif(10_000, 10)],
    ['WebP over both sides', webp(9000, 9000)],
    ['PNG over 40 megapixels within the side limit', png(7000, 7000)],
    ['PNG at 8192 x 8192', png(8192, 8192)],
    [
      'a decompression bomb: 100000 x 100000 in a tiny file',
      png(100_000, 100_000),
    ],
  ])(
    'refuses %s as too-large from its header and stores nothing',
    async (_n, bytes) => {
      const { store, db, dataDir } = setup()
      await expect(store.put(bytes, 'image/png')).rejects.toMatchObject({
        name: 'BlobError',
        code: 'too-large',
      })
      expect(db.prepare('SELECT count(*) AS n FROM blobs').get()).toEqual({
        n: 0,
      })
      expect(existsSync(join(dataDir, 'blobs'))).toBe(false)
    },
  )

  it.each([
    ['a truncated PNG header', png(10, 10).slice(0, 20)],
    ['a PNG of zero width', png(0, 10)],
    [
      'a JPEG with no size segment',
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0, 0, 0, 0]),
    ],
  ])('refuses %s as unsupported', async (_n, bytes) => {
    const { store } = setup()
    await expect(store.put(bytes, 'image/png')).rejects.toMatchObject({
      code: 'unsupported',
    })
  })

  it('accepts the largest allowed sizes: 8192 x 4096 and 4096 x 4096', async () => {
    const { store } = setup()
    expect(await store.put(png(8192, 4096, 8, 1), 'image/png')).toMatch(
      /^[0-9a-f]{64}$/,
    )
    expect(await store.put(png(4096, 4096, 8, 2), 'image/png')).toMatch(
      /^[0-9a-f]{64}$/,
    )
  })

  it('never reads outside blobs/: traversal-shaped ids are plain misses', async () => {
    const { store, dataDir } = setup()
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'secret'), 'top secret')
    for (const id of [
      '../../secret',
      '..%2f..%2fsecret',
      '../secret',
      'a'.repeat(63),
      `${'a'.repeat(63)}/`,
      '',
      'A'.repeat(64),
    ]) {
      expect(isBlobId(id)).toBe(false)
      expect(await store.get(id)).toBeUndefined()
      expect(await store.has(id)).toBe(false)
    }
  })

  it('even a database row cannot turn an id into a path outside blobs/', async () => {
    const { store, db } = setup()
    const name = `wb-secret-${process.pid}-${Date.now()}`
    const outside = join(tmpdir(), name) // dataDir/../.. is the temp dir
    writeFileSync(outside, 'top secret')
    try {
      const evil = `../../${name}`
      db.prepare("INSERT INTO blobs VALUES (?, 'image/png', 10, 0)").run(evil)
      expect(await store.get(evil)).toBeUndefined()
      expect(await store.has(evil)).toBe(false)
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('does not see a half-written temp file as a blob, and heals a row that lost its file write', async () => {
    const { store, db } = setup()
    const id = await hashBytes(PNG)
    const dir = join(store.path(id), '..')
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${store.path(id)}.deadbeef.tmp`, PNG.slice(0, 5)) // a crash mid-write
    expect(await store.has(id)).toBe(false)
    expect(await store.get(id)).toBeUndefined()
    // a row whose file is missing reads as absent, and a later put repairs it
    db.prepare("INSERT INTO blobs VALUES (?, 'image/png', ?, 0)").run(
      id,
      PNG.length,
    )
    expect(await store.get(id)).toBeUndefined()
    expect(await store.put(PNG, 'image/png')).toBe(id)
    expect((await store.get(id))?.bytes.length).toBe(PNG.length)
  })
})

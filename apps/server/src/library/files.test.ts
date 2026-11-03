import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { blobPath } from '../blobs'
import { createBlobsDb, openDatabase } from '../db'
import { ApiError } from '../errors'
import { putPdf } from './files'

const dirs: string[] = []
const dbs: Database.Database[] = []
const setup = () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'wb-files-')), 'data')
  dirs.push(dataDir)
  const db = openDatabase({ dataDir })
  dbs.push(db)
  const blobs = createBlobsDb(db)
  return { dataDir, blobs }
}
afterEach(() => {
  for (const d of dbs.splice(0)) if (d.open) d.close()
  for (const d of dirs.splice(0))
    rmSync(join(d, '..'), { recursive: true, force: true })
})

async function* parts(...bufs: Uint8Array[]) {
  for (const b of bufs) yield b
}
const pdf = (n = 3000) =>
  Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(n, 0x41)])
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const tmpLeft = (dataDir: string) =>
  existsSync(join(dataDir, 'tmp')) ? readdirSync(join(dataDir, 'tmp')) : []
const code = async (p: Promise<unknown>) =>
  ((await p.catch((e) => e)) as ApiError).code

describe('putPdf', () => {
  it('stores a PDF byte-equal at the blob path with a pdf row, and dedupes', async () => {
    const { dataDir, blobs } = setup()
    const bytes = pdf()
    const a = await putPdf(parts(bytes.subarray(0, 4), bytes.subarray(4)), {
      dataDir,
      blobs,
    })
    expect(a).toEqual({ id: sha(bytes), bytes: bytes.length })
    expect(readFileSync(blobPath(dataDir, a.id))).toEqual(bytes)
    expect(blobs.get(a.id)).toMatchObject({
      mime: 'application/pdf',
      bytes: bytes.length,
    })
    const b = await putPdf(parts(bytes), { dataDir, blobs })
    expect(b.id).toBe(a.id)
    expect(tmpLeft(dataDir)).toEqual([])
  })

  it('refuses HTML named .pdf and an empty body, leaving nothing behind', async () => {
    const { dataDir, blobs } = setup()
    const html = Buffer.from('<html><body>not a pdf</body></html>'.repeat(50))
    expect(await code(putPdf(parts(html), { dataDir, blobs }))).toBe(
      'validation_failed',
    )
    expect(await code(putPdf(parts(), { dataDir, blobs }))).toBe(
      'validation_failed',
    )
    expect(tmpLeft(dataDir)).toEqual([])
    expect(existsSync(join(dataDir, 'blobs'))).toBe(false)
  })

  it('accepts the header within the first 1024 bytes and refuses it after', async () => {
    const { dataDir, blobs } = setup()
    const late = Buffer.concat([Buffer.alloc(100, 0x20), pdf(50)])
    await expect(putPdf(parts(late), { dataDir, blobs })).resolves.toBeDefined()
    const tooLate = Buffer.concat([Buffer.alloc(2000, 0x20), pdf(50)])
    expect(await code(putPdf(parts(tooLate), { dataDir, blobs }))).toBe(
      'validation_failed',
    )
  })

  it('refuses a body one byte over the limit with payload_too_large and cleans up', async () => {
    const { dataDir, blobs } = setup()
    const bytes = pdf(1000)
    const max = bytes.length - 1
    const e = await putPdf(parts(bytes.subarray(0, 500), bytes.subarray(500)), {
      dataDir,
      blobs,
      maxBytes: max,
    }).catch((x) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(e.code).toBe('payload_too_large')
    expect(tmpLeft(dataDir)).toEqual([])
    expect(blobs.get(sha(bytes))).toBeUndefined()
    await expect(
      putPdf(parts(bytes), { dataDir, blobs, maxBytes: bytes.length }),
    ).resolves.toBeDefined()
  })

  it('cleans up and rethrows when the stream fails midway', async () => {
    const { dataDir, blobs } = setup()
    async function* broken() {
      yield pdf(500)
      throw new Error('socket reset')
    }
    await expect(putPdf(broken(), { dataDir, blobs })).rejects.toThrow(
      'socket reset',
    )
    expect(tmpLeft(dataDir)).toEqual([])
  })

  it('keeps one file for concurrent identical uploads', async () => {
    const { dataDir, blobs } = setup()
    const bytes = pdf(20000)
    const ids = await Promise.all(
      Array.from({ length: 8 }, () =>
        putPdf(parts(bytes.subarray(0, 9000), bytes.subarray(9000)), {
          dataDir,
          blobs,
        }),
      ),
    )
    expect(new Set(ids.map((i) => i.id)).size).toBe(1)
    expect(readFileSync(blobPath(dataDir, ids[0]?.id as string))).toEqual(bytes)
    expect(tmpLeft(dataDir)).toEqual([])
  })
})

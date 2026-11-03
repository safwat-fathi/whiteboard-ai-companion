import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { blobPath } from '../blobs'
import { loadConfig } from '../config'
import { createBlobsDb, createBooksDb, openDatabase } from '../db'
import { putPdf } from './files'
import { makeTestPdf } from './test-pdf'
import { runInWorker } from './worker'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(join(d, '..'), { recursive: true, force: true })
})

async function bookOn(disk: string, pages: string[]) {
  const dataDir = join(mkdtempSync(join(tmpdir(), disk)), 'data')
  dirs.push(dataDir)
  const db = openDatabase({ dataDir })
  const bytes = makeTestPdf({ pages })
  async function* one() {
    yield bytes
  }
  const { id } = await putPdf(one(), { dataDir, blobs: createBlobsDb(db) })
  const books = createBooksDb(db)
  books.createBook(
    { id: 'b', title: 'B', pages: pages.length, fileBlob: id },
    1,
  )
  return { dataDir, db, books }
}

describe('runInWorker', () => {
  it('ingests a book on its own thread and own connection, with the stub providers', async () => {
    const { dataDir, db, books } = await bookOn('wb-worker-', [
      'The quick brown fox jumps over the lazy dog and keeps running through the long green meadow.',
      '',
    ])
    await runInWorker({
      bookId: 'b',
      dataDir,
      config: loadConfig({ EMBED_DIMS: '16' }),
      stub: true,
    })
    expect(books.getBook('b')).toMatchObject({ status: 'ready', progress: 1 })
    expect(books.pagesDone('b')).toEqual([1, 2])
    expect(books.chunksWithoutEmbedding('b')).toEqual([])
    db.close()
  }, 30_000)

  it('rejects when the job fails, and the book is marked failed', async () => {
    const { dataDir, db, books } = await bookOn('wb-worker-', ['some text'])
    writeFileSync(
      blobPath(dataDir, books.getBook('b')?.fileBlob as string),
      '%PDF-1.7 broken',
    )
    await expect(
      runInWorker({
        bookId: 'b',
        dataDir,
        config: loadConfig({ EMBED_DIMS: '16' }),
        stub: true,
      }),
    ).rejects.toThrow(/PDF could not be read/)
    expect(books.getBook('b')).toMatchObject({ status: 'failed' })
    expect(books.getBook('b')?.error).toMatch(/^extracting: /)
    db.close()
  }, 30_000)
})

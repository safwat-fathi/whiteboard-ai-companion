import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBlobsDb,
  createBoardsDb,
  createBooksDb,
  openDatabase,
} from '../db'
import { spawnTsWorker } from './ts-worker'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(join(d, '..'), { recursive: true, force: true })
})

describe('write contention', () => {
  it('lets board batches keep landing while a worker thread inserts thousands of chunks', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'wb-contend-')), 'data')
    dirs.push(dataDir)
    const db = openDatabase({ dataDir })
    createBlobsDb(db).insert({
      id: 'a'.repeat(64),
      mime: 'application/pdf',
      bytes: 1,
      createdAt: 1,
    })
    createBooksDb(db).createBook(
      { id: 'b', title: 'B', fileBlob: 'a'.repeat(64) },
      1,
    )
    const boards = createBoardsDb(db)
    boards.createBoard({ id: 'board', title: 'T' }, 1)

    const worker = spawnTsWorker(
      new URL('./contention-worker.ts', import.meta.url),
      {
        dataDir,
        bookId: 'b',
        chunks: 5000,
      },
    )
    let inserting = false
    let finished = false
    const finishedP = new Promise<void>((resolve, reject) => {
      worker.on('message', (m: string) => {
        if (m === 'started') inserting = true
        if (m === 'done') {
          finished = true
          resolve()
        }
      })
      worker.on('error', reject)
    })
    while (!inserting) await new Promise((r) => setTimeout(r, 2))

    const ms: number[] = []
    let during = 0
    for (let i = 0; i < 200 || !finished; i++) {
      const t0 = performance.now()
      boards.appendBatch(
        'board',
        {
          batchId: `batch-${i}`,
          authorKind: 'human',
          authorId: 'owner',
          label: `Edit ${i}`,
          bounds: null,
          touchedIds: [],
          ops: [],
        },
        i,
      ) // throws SQLITE_BUSY if the worker's transactions ever hold the lock past busy_timeout
      ms.push(performance.now() - t0)
      if (!finished) during++
      await new Promise((r) => setImmediate(r))
    }
    await finishedP
    await worker.terminate()

    const p95 = [...ms].sort((a, b) => a - b)[
      Math.floor(ms.length * 0.95)
    ] as number
    expect(createBooksDb(db).chunksOf('b').length).toBe(5000)
    expect(boards.getBoard('board')?.headSeq).toBe(ms.length)
    expect(during).toBeGreaterThan(20) // the two really overlapped
    expect(p95).toBeLessThan(250) // generous: the real cost is a few ms per 200-row transaction
    db.close()
  }, 60_000)
})

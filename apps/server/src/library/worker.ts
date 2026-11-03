import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import type { Config } from '../config'
import { createBooksDb, openDatabase } from '../db'
import { runIngest } from './ingest'
import { createProviders, stubProviders } from './providers'
import { spawnTsWorker } from './ts-worker'

export type JobData = {
  bookId: string
  dataDir: string
  config: Config
  /** Offline stand-in providers (tests, the e2e gate): never set in production. */
  stub: boolean
  r4Concurrency?: number
}
type Reply = { ok: true } | { ok: false; message: string }

/**
 * Ingests one book on its own thread (library-ingestion.md "Jobs"), so parsing a PDF never blocks the WebSocket. The
 * thread opens its own SQLite connection and writes short transactions; progress is read from the database, not sent
 * back. Resolves when the book is ready, rejects with the failure (which `runIngest` has also recorded on the book).
 */
export function runInWorker(job: JobData): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = spawnTsWorker(new URL(import.meta.url), job)
    worker.once('message', (m: Reply) =>
      m.ok ? resolve() : reject(new Error(m.message)),
    )
    worker.once('error', reject)
    worker.once('exit', (code) =>
      reject(new Error(`ingest worker exited with code ${code}`)),
    ) // a no-op when the job already settled
  })
}

// The thread's own entry: `spawnTsWorker` loads this very file, with the job as workerData.
if (!isMainThread && parentPort && workerData?.__entry === import.meta.url) {
  const job = workerData as JobData
  const port = parentPort
  const db = openDatabase({ dataDir: job.dataDir })
  try {
    await runIngest(job.bookId, {
      books: createBooksDb(db),
      providers: job.stub
        ? stubProviders({ dims: job.config.embedDims })
        : createProviders({ config: job.config, env: process.env }),
      dataDir: job.dataDir,
      config: job.config,
      r4Concurrency: job.r4Concurrency,
    })
    port.postMessage({ ok: true } satisfies Reply)
  } catch (e) {
    port.postMessage({
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    } satisfies Reply)
  } finally {
    db.close()
  }
}

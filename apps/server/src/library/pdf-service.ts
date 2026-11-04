import type { Worker } from 'node:worker_threads'
import { ApiError, type ErrorCode } from '../errors'
import { type PdfOps, pdfOps, type ReadPages } from './pdf-ops'
import type { WireRequest, WireResponse } from './pdf-worker'
import { spawnTsWorker } from './ts-worker'

/**
 * Everything the HTTP routes and the tutor need from a PDF, as async calls on a file path. Parsing a PDF with pdfjs is
 * seconds of CPU for a large book; run on the server's own thread it stalls every board's WebSocket. The worker-thread
 * implementation is what the server uses; the inline one runs the same code in-process (tests, tools).
 */
export type PdfService = PdfOps & { close(): Promise<void> }

export const createInlinePdfService = (): PdfService => ({
  ...pdfOps,
  close: async () => {},
})

export type { ReadPages }

const DEFAULT_TIMEOUT_MS = 5 * 60_000 // a 2,000-page book's text pass; a hostile or broken file must not hold the thread forever

/**
 * One worker thread, started on first use and again after it dies or is killed for running too long. Jobs queue inside
 * the thread. A job that outlives `timeoutMs` kills the thread; the jobs queued behind it fail too and may be retried.
 */
export function createWorkerPdfService(
  o: { timeoutMs?: number } = {},
): PdfService {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS
  type Pending = {
    resolve: (v: unknown) => void
    reject: (e: unknown) => void
    timer: NodeJS.Timeout
  }
  const pending = new Map<number, Pending>()
  let worker: Worker | undefined
  let closed = false
  let seq = 0

  const rejectAll = (err: Error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  }
  const lost = (w: Worker, err: Error) => {
    if (worker !== w) return // an older thread's late event: its jobs were already failed
    worker = undefined
    rejectAll(err)
  }
  const spawn = (): Worker => {
    const w = spawnTsWorker(new URL('./pdf-worker.ts', import.meta.url), {})
    w.unref() // an idle PDF thread must not keep the process alive
    w.on('message', (m: WireResponse) => {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.ok) p.resolve(m.value)
      else
        p.reject(
          m.error.code
            ? new ApiError(
                m.error.code as ErrorCode,
                m.error.message,
                m.error.details,
              )
            : new Error(m.error.message),
        )
    })
    w.on('error', (e) => lost(w, e instanceof Error ? e : new Error(String(e))))
    w.on('exit', (code) =>
      lost(w, new Error(`the PDF worker exited with code ${code}`)),
    )
    worker = w
    return w
  }

  function call<K extends keyof PdfOps>(
    op: K,
    ...args: Parameters<PdfOps[K]>
  ): ReturnType<PdfOps[K]> {
    return new Promise((resolve, reject) => {
      if (closed) return reject(new Error('the PDF service is closed'))
      const w = worker ?? spawn()
      const id = ++seq
      const timer = setTimeout(() => {
        const err = new ApiError(
          'ingest_failed',
          'the PDF took too long to read',
          { step: 'timeout' },
        )
        if (worker === w) worker = undefined
        pending.delete(id)
        reject(err)
        rejectAll(err) // everything else queued in that thread dies with it
        void w.terminate()
      }, timeoutMs)
      pending.set(id, { resolve: resolve as Pending['resolve'], reject, timer })
      w.postMessage({ id, op, args } satisfies WireRequest)
    }) as ReturnType<PdfOps[K]>
  }

  return {
    pageCount: (file) => call('pageCount', file),
    analyze: (file) => call('analyze', file),
    readPages: (file, pages, width) => call('readPages', file, pages, width),
    render: (file, n, width) => call('render', file, n, width),
    async close() {
      closed = true
      const w = worker
      worker = undefined
      rejectAll(new Error('the PDF service is closed'))
      await w?.terminate()
    },
  }
}

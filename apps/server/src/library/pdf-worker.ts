import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { ApiError } from '../errors'
import { type PdfOps, pdfOps } from './pdf-ops'

export type WireRequest = {
  id: number
  op: keyof PdfOps
  args: unknown[]
}
export type WireResponse =
  | { id: number; ok: true; value: unknown }
  | {
      id: number
      ok: false
      error: { code?: string; message: string; details?: unknown }
    }

// The thread's own entry (spawnTsWorker loads this very file). Jobs run one after another: a PDF is large in memory and
// pdfjs is not worth interleaving; the point of the thread is that the server's own event loop stays free.
if (!isMainThread && parentPort && workerData?.__entry === import.meta.url) {
  const port = parentPort
  let chain: Promise<void> = Promise.resolve()
  port.on('message', (req: WireRequest) => {
    chain = chain.then(async () => {
      try {
        const run = pdfOps[req.op] as (...a: unknown[]) => Promise<unknown>
        const value = await run(...req.args)
        port.postMessage(
          { id: req.id, ok: true, value } satisfies WireResponse,
          transferables(value),
        )
      } catch (e) {
        port.postMessage({
          id: req.id,
          ok: false,
          error:
            e instanceof ApiError
              ? { code: e.code, message: e.message, details: e.details }
              : { message: e instanceof Error ? e.message : String(e) },
        } satisfies WireResponse)
      }
    })
  })
}

/** The PNG buffers in a result, moved to the caller instead of copied (they are fresh, whole ArrayBuffers). */
function transferables(value: unknown): ArrayBuffer[] {
  const bufs: ArrayBuffer[] = []
  const take = (u: unknown) => {
    if (
      u instanceof Uint8Array &&
      u.buffer instanceof ArrayBuffer &&
      u.byteOffset === 0 &&
      u.byteLength === u.buffer.byteLength
    )
      bufs.push(u.buffer)
  }
  take(value)
  if (value && typeof value === 'object' && 'pages' in value)
    for (const p of (value as { pages: { png?: unknown }[] }).pages) take(p.png)
  return bufs
}

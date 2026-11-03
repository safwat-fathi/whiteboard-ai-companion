import { Worker } from 'node:worker_threads'

/** A worker thread running the TypeScript file at `entry`, which reads `data` from `workerData`. */
export function spawnTsWorker(entry: URL, data: object): Worker {
  return new Worker(new URL('./ts-worker-boot.mjs', import.meta.url), {
    workerData: { ...data, __entry: entry.href },
  })
}

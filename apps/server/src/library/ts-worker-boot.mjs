// Starts a worker thread on a TypeScript entry: registers tsx inside the thread (a worker does not get the parent's
// loader in every setup, e.g. under Vitest), then loads the entry named by `workerData.__entry`.

import { workerData } from 'node:worker_threads'
import { register } from 'tsx/esm/api'

register()
await import(workerData.__entry)

import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { onTestFinished } from 'vitest'
import { createDiskBlobStore } from './blobs'
import { BoardService } from './board-service'
import { loadConfig } from './config'
import {
  createBlobsDb,
  createBoardsDb,
  createBooksDb,
  createMessagesDb,
  createSettingsDb,
  openDatabase,
  schemaVersion,
} from './db'
import { serverPlatform } from './export'
import { createHttpServer } from './http'
import { runIngest } from './library/ingest'
import { type Providers, stubProviders } from './library/providers'
import { createQueue } from './library/queue'
import { createVectorCache } from './library/search'
import type { StubFixture } from './tutor/stub'
import { boardToolSet } from './tutor/tools/board-tools'
import { createTutor, type TutorDeps } from './tutor/turn'

// Shared by the HTTP test files: a real server on a random port over a temp database, and a raw client.
export const ORIGIN = 'http://localhost:3000'
export type Res = {
  status: number
  headers: http.IncomingHttpHeaders
  text: string
  raw: Buffer
  // biome-ignore lint/suspicious/noExplicitAny: a test helper that reads arbitrary JSON
  json: any
}
export async function boot(
  o: {
    providers?: Partial<Providers>
    dailyBudget?: string
    maxPdfBytes?: number
    /** Extra environment for loadConfig (MAX_STEPS, TUTOR_PRICE_IN_PER_M ...). */
    env?: Record<string, string>
    /** Mounts the tutor routes. `fixtures` is the scripted model (omit for "no stub, no key"). */
    tutor?: {
      fixtures?: StubFixture[]
      tools?: TutorDeps['tools']
      /** The real board tools (the ones main.ts wires) instead of `tools`. */
      realTools?: boolean
    }
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'wb-http-'))
  const dataDir = join(root, 'data')
  const db: Database.Database = openDatabase({ dataDir })
  let clock = 1_000
  const boards = new BoardService(createBoardsDb(db), { now: () => ++clock })
  const config = loadConfig({
    PUBLIC_ORIGIN: ORIGIN,
    DATA_DIR: dataDir,
    META_API_KEY: 'sk-secret-meta-value',
    EMBED_DIMS: '16',
    DAILY_BUDGET_USD: o.dailyBudget ?? '5',
    ...o.env,
  })
  const blobsDb = createBlobsDb(db)
  const blobs = createDiskBlobStore({ dataDir, db: blobsDb })
  // The library with offline providers; its jobs run in this process (`queue.whenIdle()` waits for them).
  const booksDb = createBooksDb(db)
  const providers: Providers = {
    ...stubProviders({ dims: 16 }),
    ...o.providers,
  }
  const cache = createVectorCache(booksDb)
  const queue = createQueue(
    (id) =>
      runIngest(id, {
        books: booksDb,
        providers,
        dataDir,
        config,
        r4Concurrency: 1,
      }),
    { onDone: (id) => cache.invalidate(id), onError: () => {} },
  )
  const messagesDb = createMessagesDb(db)
  const tutor = o.tutor
    ? createTutor({
        config,
        boards,
        messages: messagesDb,
        settings: createSettingsDb(db),
        books: booksDb,
        llm: null,
        stub: o.tutor.fixtures,
        tools: o.tutor.realTools
          ? (ctx) =>
              boardToolSet({ boards, blobs, platform: serverPlatform }, ctx)
          : o.tutor.tools,
      })
    : undefined
  const server = createHttpServer({
    config,
    boards,
    blobs,
    schemaVersion: () => schemaVersion(db),
    tutor: tutor && {
      tutor,
      boards,
      messages: messagesDb,
      stub: !!o.tutor?.fixtures,
    },
    library: {
      books: booksDb,
      blobs: blobsDb,
      dataDir,
      config,
      providers,
      cache,
      enqueue: queue.enqueue,
      maxPdfBytes: o.maxPdfBytes,
    },
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const port = (server.address() as AddressInfo).port
  function call(
    method: string,
    path: string,
    o: {
      headers?: Record<string, string>
      body?: string | Buffer
      origin?: string | null
    } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = { ...o.headers }
    if (o.origin !== null && o.origin !== undefined) headers.Origin = o.origin
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method, path, headers },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const raw = Buffer.concat(chunks)
            const text = raw.toString('utf8')
            // biome-ignore lint/suspicious/noExplicitAny: a test helper that reads arbitrary JSON
            let json: any
            try {
              json = text ? JSON.parse(text) : undefined
            } catch {}
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              text,
              raw,
              json,
            })
          })
        },
      )
      req.on('error', reject)
      if (o.body !== undefined) req.write(o.body)
      req.end()
    })
  }
  const json = (
    method: string,
    path: string,
    body: unknown,
    origin: string | null = ORIGIN,
  ) =>
    call(method, path, {
      origin,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  return {
    call,
    json,
    boards,
    config,
    port,
    blobs,
    db,
    booksDb,
    queue,
    dataDir,
    messagesDb,
  }
}

/** The JSON chunks of a UI message stream body (`data: {...}` lines). */
export const sseChunks = (
  text: string,
  // biome-ignore lint/suspicious/noExplicitAny: a test helper that reads arbitrary JSON
): { type: string; data: any; [k: string]: unknown }[] =>
  text
    .split('\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)))

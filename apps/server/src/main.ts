import { fileURLToPath } from 'node:url'
import { createDiskBlobStore } from './blobs'
import { BoardService } from './board-service'
import { loadConfig } from './config'
import {
  createBlobsDb,
  createBoardsDb,
  createBooksDb,
  createMessagesDb,
  createSettingsDb,
  createUsageDb,
  openDatabase,
  schemaVersion,
} from './db'
import { serverPlatform } from './export'
import { attachGateway } from './gateway'
import { createHttpServer } from './http'
import { createSearcher } from './library/embed-search'
import { createProviders, stubProviders } from './library/providers'
import { createQueue } from './library/queue'
import { createVectorCache } from './library/search'
import { runInWorker } from './library/worker'
import { createLlm } from './tutor/llm'
import { dailyCap } from './tutor/settings'
import { loadFixtures } from './tutor/stub'
import { tutorToolSet } from './tutor/tools'
import { createTutor } from './tutor/turn'
import { createUndo } from './tutor/undo'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const config = loadConfig(process.env, repoRoot)
const db = openDatabase({ dataDir: config.dataDir })
const boards = new BoardService(createBoardsDb(db))
const blobsDb = createBlobsDb(db)
const blobs = createDiskBlobStore({ dataDir: config.dataDir, db: blobsDb })

// The library: a book's ingest job runs on a worker thread, one at a time; INGEST_STUB=1 swaps in offline providers (tests, e2e).
const booksDb = createBooksDb(db)
const interrupted = booksDb.failInterrupted('interrupted by a restart')
if (interrupted > 0)
  console.log(
    `${interrupted} book(s) were mid-job when the server stopped: marked failed (Retry resumes them)`,
  )
const stub = process.env.INGEST_STUB === '1'
const cache = createVectorCache(booksDb)
const queue = createQueue(
  (bookId) => runInWorker({ bookId, dataDir: config.dataDir, config, stub }),
  {
    onDone: (bookId) => cache.invalidate(bookId),
    onError: (bookId, e) =>
      console.error(
        `ingest of book ${bookId} failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
  },
)
// The tutor: the Meta Model API behind one adapter; TUTOR_STUB=1 swaps in a scripted model (tests, e2e) and nothing else.
const messagesDb = createMessagesDb(db)
const settingsDb = createSettingsDb(db)
const tutorStub =
  process.env.TUTOR_STUB === '1'
    ? loadFixtures(
        fileURLToPath(new URL('../test/fixtures/tutor/', import.meta.url)),
      )
    : undefined
const tutorProviders = tutorStub
  ? stubProviders({ dims: config.embedDims })
  : createProviders({ config, env: process.env })
const tutorSearch = createSearcher({
  books: booksDb,
  cache,
  providers: tutorProviders,
  config,
})
const tutor = createTutor({
  config,
  boards,
  messages: messagesDb,
  settings: settingsDb,
  books: booksDb,
  llm: process.env.META_API_KEY
    ? createLlm({
        baseUrl: config.metaBaseUrl,
        apiKey: process.env.META_API_KEY,
      })
    : null,
  stub: tutorStub,
  summarise: (prompt) => tutorProviders.complete(prompt, { maxTokens: 1200 }),
  blobs,
  tools: (ctx) =>
    tutorToolSet(
      {
        board: { boards, blobs, platform: serverPlatform },
        book: { books: booksDb, boards, search: tutorSearch },
        figure: { books: booksDb, dataDir: config.dataDir, blobs },
      },
      ctx,
    ),
})
const server = createHttpServer({
  config,
  boards,
  blobs,
  schemaVersion: () => schemaVersion(db),
  tutor: {
    tutor,
    boards,
    messages: messagesDb,
    settings: settingsDb,
    usage: createUsageDb(db),
    config,
    undo: createUndo({ boards, settings: settingsDb }),
    stub: !!tutorStub,
  },
  library: {
    books: booksDb,
    blobs: blobsDb,
    dataDir: config.dataDir,
    config,
    providers: stub
      ? stubProviders({ dims: config.embedDims })
      : createProviders({ config, env: process.env }),
    cache,
    enqueue: queue.enqueue,
    dailyCap: () => dailyCap(settingsDb, config),
  },
})

const gateway = attachGateway(server, { boards, config })
const timer = setInterval(() => boards.tick(), 30_000) // time-based snapshots and idle eviction
timer.unref()

server.listen(config.port, config.host, () => {
  console.log(
    `whiteboard server on http://${config.host}:${config.port} (data ${config.dataDir}, origin ${config.publicOrigin})`,
  )
})

let stopping = false
function stop(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`${signal}: shutting down`)
  clearInterval(timer)
  setTimeout(() => process.exit(1), 5_000).unref() // a stuck connection must not keep the process alive
  void gateway.close().then(() => {
    server.close(() => {
      boards.close()
      db.close()
      process.exit(0)
    })
    server.closeAllConnections()
  })
}
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))

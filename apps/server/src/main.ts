import { fileURLToPath } from 'node:url'
import { createDiskBlobStore } from './blobs'
import { BoardService } from './board-service'
import { loadConfig } from './config'
import {
  createBlobsDb,
  createBoardsDb,
  openDatabase,
  schemaVersion,
} from './db'
import { createHttpServer } from './http'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const config = loadConfig(process.env, repoRoot)
const db = openDatabase({ dataDir: config.dataDir })
const boards = new BoardService(createBoardsDb(db))
const blobs = createDiskBlobStore({
  dataDir: config.dataDir,
  db: createBlobsDb(db),
})
const server = createHttpServer({
  config,
  boards,
  blobs,
  schemaVersion: () => schemaVersion(db),
})

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
  server.close(() => {
    boards.close()
    db.close()
    process.exit(0)
  })
  server.closeAllConnections()
}
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))

// Test-only: inserts `chunks` chunk rows through the real BooksDb (200-row transactions) on its own connection.
import { parentPort, workerData } from 'node:worker_threads'
import { createBooksDb, openDatabase } from '../db'

const { dataDir, bookId, chunks } = workerData as {
  dataDir: string
  bookId: string
  chunks: number
}
const db = openDatabase({ dataDir })
const books = createBooksDb(db)
parentPort?.postMessage('started')
const text = 'lorem ipsum dolor sit amet '.repeat(100)
books.insertChunks(
  bookId,
  Array.from({ length: chunks }, (_, i) => ({
    sectionId: null,
    ord: i,
    pageStart: i + 1,
    pageEnd: i + 1,
    citeLabel: `p. ${i + 1}`,
    headingPath: 'H',
    text,
    textNorm: text,
    tokens: 700,
  })),
)
db.close()
parentPort?.postMessage('done')

import { randomUUID } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blobPath } from '../blobs'
import { loadConfig } from '../config'
import { type BooksDb, createBlobsDb, createBooksDb, openDatabase } from '../db'
import { ApiError } from '../errors'
import { putPdf } from './files'
import { runIngest } from './ingest'
import { openPdf } from './pdf'
import { createProviders, stubProviders } from './providers'
import { analyzePdf, estimate } from './route'

const USAGE =
  'usage: pnpm ingest <file.pdf> [--title <title>] [--r3 1-9,20] [--stub]\n       pnpm ingest --resume <bookId> [--stub]'

type Io = { log: (s: string) => void; err: (s: string) => void }
type R3Range = { from: number; to: number; rung: 'R3' }

/** "1-9,20" as page ranges for the opt-in paid rung; null when it is not that. */
export function parseRanges(spec: string): R3Range[] | null {
  const out: R3Range[] = []
  for (const part of spec.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim())
    if (!m) return null
    const from = Number(m[1])
    const to = Number(m[2] ?? m[1])
    if (from < 1 || to < from) return null
    out.push({ from, to, rung: 'R3' })
  }
  return out.length > 0 ? out : null
}

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/**
 * `pnpm ingest`: the upload path without the HTTP layer. Stores the PDF, prints what routing and embedding will cost,
 * runs the job in this process and exits 0 only when the book is ready. `--resume` runs a failed or partial book again.
 */
export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  io: Io,
  cwd: string = process.env.INIT_CWD ?? process.cwd(),
  baseDir: string = repoRoot,
): Promise<number> {
  let file: string | undefined
  let title: string | undefined
  let r3: R3Range[] | undefined
  let resumeId: string | undefined
  let stub = env.INGEST_STUB === '1'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--title') title = argv[++i]
    else if (a === '--resume') resumeId = argv[++i]
    else if (a === '--stub') stub = true
    else if (a === '--r3') {
      const ranges = parseRanges(argv[++i] ?? '')
      if (!ranges) {
        io.err('--r3 takes page ranges such as 1-9,20')
        return 1
      }
      r3 = ranges
    } else if (a.startsWith('--') || file) {
      io.err(`unexpected argument ${a}\n${USAGE}`)
      return 1
    } else file = a
  }
  if (!file && !resumeId) {
    io.err(USAGE)
    return 1
  }

  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig(env, baseDir)
  } catch (e) {
    io.err((e as Error).message)
    return 1
  }
  const db = openDatabase({ dataDir: config.dataDir })
  try {
    const books = createBooksDb(db)
    let id = resumeId
    if (resumeId) {
      if (!books.getBook(resumeId)) {
        io.err(`no book ${resumeId}`)
        return 1
      }
    } else {
      const added = await addBook(file as string, {
        books,
        db,
        config,
        cwd,
        title,
        r3,
        io,
      })
      if (typeof added === 'number') return added
      id = added
    }

    const providers = stub
      ? stubProviders({ dims: config.embedDims })
      : createProviders({ config, env })
    let last = ''
    const poll = setInterval(() => {
      const b = books.getBook(id as string)
      const line = b ? `${b.status} ${Math.round(b.progress * 100)}%` : ''
      if (line && line !== last) {
        last = line
        io.log(line)
      }
    }, 1500)
    try {
      await runIngest(id as string, {
        books,
        providers,
        dataDir: config.dataDir,
        config,
      })
    } catch (e) {
      io.err(`failed: ${e instanceof Error ? e.message : String(e)}`)
      io.err(`resume with: pnpm ingest --resume ${id}`)
      return 1
    } finally {
      clearInterval(poll)
    }
    const b = books.getBook(id as string)
    const methods = new Map<string, number>()
    for (const p of books.pagesOf(id as string))
      methods.set(p.method, (methods.get(p.method) ?? 0) + 1)
    io.log(
      `${b?.status} (book ${id}): ${[...methods].map(([m, n]) => `${m} ${n}`).join(', ')} pages, ${books.chunksOf(id as string).length} chunks`,
    )
    for (const note of [
      ...(b?.ingestMethod?.warnings?.length
        ? [`pages cut off by the model: ${b.ingestMethod.warnings.join(', ')}`]
        : []),
      ...(b?.ingestMethod?.notes ?? []),
    ])
      io.log(`note: ${note}`)
    return b?.status === 'ready' ? 0 : 1
  } finally {
    db.close()
  }
}

async function addBook(
  file: string,
  o: {
    books: BooksDb
    db: ReturnType<typeof openDatabase>
    config: ReturnType<typeof loadConfig>
    cwd: string
    title?: string
    r3?: R3Range[]
    io: Io
  },
): Promise<string | number> {
  const path = resolve(o.cwd, file)
  try {
    if (!statSync(path).isFile()) throw new Error('not a file')
  } catch {
    o.io.err(`no such file: ${path}`)
    return 1
  }
  try {
    const stored = await putPdf(createReadStream(path), {
      dataDir: o.config.dataDir,
      blobs: createBlobsDb(o.db),
    })
    const pdf = await openPdf(
      readFileSync(blobPath(o.config.dataDir, stored.id)),
    )
    try {
      const e = estimate(await analyzePdf(pdf))
      const bad = o.r3?.find((r) => r.to > pdf.numPages)
      if (bad) {
        o.io.err(
          `--r3 ${bad.from}-${bad.to} is past the last page (${pdf.numPages})`,
        )
        return 1
      }
      const name = o.title ?? basename(path).replace(/\.pdf$/i, '')
      o.io.log(
        `${name}: ${e.pages} pages. Routing: R1 ${e.r1} (free, local), R4 ${e.r4} (Muse via Meta: ${e.scanned} scanned, ${e.mathDense} math-dense).`,
      )
      o.io.log(
        `Embeddings about $${e.embedUsd.toFixed(4)} (OpenRouter). The opt-in R3 for the R4 pages would be about $${e.r3Usd.toFixed(2)}${o.r3 ? '' : ' (add --r3 1-9,20 to use it)'}.`,
      )
      const id = randomUUID()
      o.books.createBook(
        { id, title: name, pages: pdf.numPages, fileBlob: stored.id },
        Date.now(),
      )
      if (o.r3) o.books.setIngestMethod(id, { ranges: o.r3 })
      return id
    } finally {
      await pdf.close()
    }
  } catch (e) {
    o.io.err(
      e instanceof ApiError
        ? e.message
        : `could not add the book: ${(e as Error).message}`,
    )
    return 1
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  process.exit(
    await main(process.argv.slice(2), process.env, {
      log: console.log,
      err: console.error,
    }),
  )
}

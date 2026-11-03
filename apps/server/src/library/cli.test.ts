import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBooksDb, openDatabase } from '../db'
import { main } from './cli'
import { makeTestPdf } from './test-pdf'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const PROSE =
  'The quick brown fox jumps over the lazy dog and keeps running through the long green meadow.'
function rig(pages = [PROSE, '', PROSE]) {
  const root = mkdtempSync(join(tmpdir(), 'wb-cli-'))
  dirs.push(root)
  const file = join(root, 'My Book.pdf')
  writeFileSync(file, makeTestPdf({ pages }))
  const env = {
    DATA_DIR: join(root, 'data'),
    EMBED_DIMS: '16',
    INGEST_STUB: '1',
  }
  const out: string[] = []
  const err: string[] = []
  const io = {
    log: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
  }
  const books = () => {
    const db = openDatabase({ dataDir: env.DATA_DIR })
    const b = createBooksDb(db)
    return { b, close: () => db.close() }
  }
  return { root, file, env, out, err, io, books }
}

describe('ingest CLI', () => {
  it('stores the PDF, prints the estimate, ingests it and exits 0', async () => {
    const r = rig()
    const code = await main([r.file], r.env, r.io, r.root)
    expect(code).toBe(0)
    const text = r.out.join('\n')
    expect(text).toMatch(/3 pages/)
    expect(text).toMatch(/R4/)
    expect(text).toMatch(/ready/)
    const { b, close } = r.books()
    const [book] = b.listBooks()
    expect(book).toMatchObject({ title: 'My Book', status: 'ready', pages: 3 })
    expect(b.pagesOf(book?.id as string).map((p) => p.method)).toEqual([
      'R1',
      'R4',
      'R1',
    ])
    close()
  }, 30_000)

  it("takes a title and resolves a relative path against the caller's directory", async () => {
    const r = rig()
    const code = await main(
      ['My Book.pdf', '--title', 'Algebra'],
      r.env,
      r.io,
      r.root,
    )
    expect(code).toBe(0)
    const { b, close } = r.books()
    expect(b.listBooks()[0]?.title).toBe('Algebra')
    close()
  }, 30_000)

  it('sends the pages named by --r3 through R3', async () => {
    const r = rig()
    const code = await main([r.file, '--r3', '1,3'], r.env, r.io, r.root)
    expect(code).toBe(0)
    const { b, close } = r.books()
    const id = b.listBooks()[0]?.id as string
    expect(b.pagesOf(id).map((p) => p.method)).toEqual(['R3', 'R4', 'R3'])
    close()
  }, 30_000)

  it('refuses a file that is not a PDF, a missing file and a bad --r3, storing nothing', async () => {
    const r = rig()
    const html = join(r.root, 'x.pdf')
    writeFileSync(html, '<html>no</html>'.repeat(100))
    expect(await main([html], r.env, r.io, r.root)).toBe(1)
    expect(r.err.join('\n')).toMatch(/PDF/)
    expect(await main([join(r.root, 'nope.pdf')], r.env, r.io, r.root)).toBe(1)
    expect(await main([r.file, '--r3', 'x-y'], r.env, r.io, r.root)).toBe(1)
    expect(await main([], r.env, r.io, r.root)).toBe(1)
    const { b, close } = r.books()
    expect(b.listBooks()).toEqual([])
    close()
  })

  it('--resume runs an existing book again and refuses an unknown one', async () => {
    const r = rig()
    expect(await main([r.file], r.env, r.io, r.root)).toBe(0)
    const { b, close } = r.books()
    const id = b.listBooks()[0]?.id as string
    close()
    expect(await main(['--resume', id], r.env, r.io, r.root)).toBe(0)
    expect(await main(['--resume', 'nope'], r.env, r.io, r.root)).toBe(1)
  }, 30_000)
})

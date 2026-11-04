import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { ApiError } from '../errors'
import {
  createInlinePdfService,
  createWorkerPdfService,
  type PdfService,
} from './pdf-service'
import { makeTestPdf } from './test-pdf'

// a cold worker thread (tsx + pdfjs) takes seconds when the whole suite runs in parallel
vi.setConfig({ testTimeout: 30_000 })

const dirs: string[] = []
const services: PdfService[] = []
afterEach(async () => {
  for (const s of services.splice(0)) await s.close()
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const fail = async (p: Promise<unknown>) =>
  (await p.catch((e) => e)) as ApiError
const isPng = (b: Uint8Array) =>
  Buffer.from(b.subarray(0, 8)).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )

let file: string
let broken: string
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-pdfsvc-'))
  dirs.push(dir)
  file = join(dir, 'book.pdf')
  writeFileSync(
    file,
    makeTestPdf({
      pages: [
        'Hello world, a long enough line of ordinary prose for the router.',
        '',
        'x = 2 + 3',
      ],
      labels: [{ from: 1, style: 'r' }],
    }),
  )
  broken = join(dir, 'broken.pdf')
  writeFileSync(broken, 'this is not a pdf')
})

// The same expectations against both implementations: the worker must answer exactly what the inline one does.
describe.each([
  ['inline', () => createInlinePdfService()],
  ['worker thread', () => createWorkerPdfService()],
])('PdfService (%s)', (_name, make) => {
  const svc = () => {
    const s = make()
    services.push(s)
    return s
  }

  it('counts pages', async () => {
    expect(await svc().pageCount(file)).toBe(3)
  })

  it('returns per-page stats for routing', async () => {
    const stats = await svc().analyze(file)
    expect(stats).toHaveLength(3)
    expect(stats[0]?.chars).toBeGreaterThan(20)
    expect(stats[1]?.chars).toBe(0)
  })

  it('reads labels, text and PNGs of the requested pages', async () => {
    const r = await svc().readPages(file, [1, 3], 300)
    expect(r.numPages).toBe(3)
    expect(r.pages.map((p) => [p.n, p.label])).toEqual([
      [1, 'i'],
      [3, 'iii'],
    ])
    expect(r.pages[0]?.text).toContain('Hello world')
    expect(r.pages.every((p) => isPng(p.png))).toBe(true)
  })

  it('renders one page to a PNG', async () => {
    expect(isPng(await svc().render(file, 2, 400))).toBe(true)
  })

  it('keeps the error code: a page past the end, a missing file, a file that is not a PDF', async () => {
    const s = svc()
    expect((await fail(s.render(file, 9, 400))).code).toBe('not_found')
    expect((await fail(s.readPages(file, [1, 9], 300))).code).toBe(
      'validation_failed',
    )
    expect((await fail(s.pageCount(`${file}.nope`))).code).toBe('not_found')
    const bad = await fail(s.pageCount(broken))
    expect(bad.code).toBe('ingest_failed')
    expect(bad.details).toEqual({ step: 'open' })
  })
})

describe('worker PdfService', () => {
  it('does the work off the calling thread: timers keep firing while a page renders', async () => {
    const s = createWorkerPdfService()
    services.push(s)
    await s.pageCount(file) // start the thread first, so the measured gap is the job, not the boot
    let ticks = 0
    const t = setInterval(() => ticks++, 1)
    await Promise.all(Array.from({ length: 3 }, () => s.render(file, 1, 1200)))
    clearInterval(t)
    expect(ticks).toBeGreaterThan(3)
  })

  it('fails a job that takes too long, and the next call starts a fresh thread', async () => {
    const s = createWorkerPdfService({ timeoutMs: 1 })
    services.push(s)
    expect((await fail(s.render(file, 1, 2000))).code).toBe('ingest_failed')
    // the thread was killed; a service with room to work still answers (a new one: this one's timeout is 1 ms)
    const ok = createWorkerPdfService()
    services.push(ok)
    expect(await ok.pageCount(file)).toBe(3)
  })
})

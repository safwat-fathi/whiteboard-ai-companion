import { describe, expect, it, vi } from 'vitest'
import { createLibraryApi, LibraryError } from './api'

type Call = { url: string; init: RequestInit }
function fakeFetch(replies: (Response | Error)[]): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const f = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const r = replies.shift()
    if (!r) throw new Error('no reply left')
    if (r instanceof Error) throw r
    return r
  })
  return { fetch: f as unknown as typeof fetch, calls }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

describe('createLibraryApi', () => {
  it('reads a board with its scope and patches the scope; an empty base is the same origin', async () => {
    const board = {
      id: 'b 1',
      title: 'T',
      scope: { kind: 'book', bookId: 'x' },
    }
    const { fetch, calls } = fakeFetch([json(board), json(board)])
    const api = createLibraryApi('', fetch)
    expect(await api.getBoard('b 1')).toEqual(board)
    expect(calls[0]?.url).toBe('/api/boards/b%201')
    await api.setBoardScope('b 1', { kind: 'book', bookId: 'x' })
    expect(calls[1]).toMatchObject({
      url: '/api/boards/b%201',
      init: { method: 'PATCH', body: '{"scope":{"kind":"book","bookId":"x"}}' },
    })
  })

  it('lists books and trims slashes from the base URL', async () => {
    const { fetch, calls } = fakeFetch([json({ books: [{ id: 'a' }] })])
    const api = createLibraryApi('http://localhost:4000//', fetch)
    expect(await api.listBooks()).toEqual([{ id: 'a' }])
    expect(calls[0]?.url).toBe('http://localhost:4000/api/books')
  })

  it('uploads a PDF as the raw body with its type and an encoded title', async () => {
    const { fetch, calls } = fakeFetch([json({ id: 'b', title: 'A & B' }, 201)])
    const api = createLibraryApi('http://x', fetch)
    const file = new Blob(['%PDF-1.7'], { type: 'application/pdf' })
    const book = await api.upload(file, 'A & B / ج')
    expect(book.id).toBe('b')
    expect(calls[0]?.url).toBe(
      `http://x/api/books?title=${encodeURIComponent('A & B / ج')}`,
    )
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.body).toBe(file)
    expect(new Headers(calls[0]?.init.headers).get('Content-Type')).toBe(
      'application/pdf',
    )
  })

  it('posts JSON for index, retry, preview and search', async () => {
    const { fetch, calls } = fakeFetch([
      json({ id: 'b', status: 'queued' }, 202),
      json({ id: 'b', status: 'queued' }, 202),
      json({ pages: [] }),
      json({ mode: 'hybrid', hits: [] }),
    ])
    const api = createLibraryApi('http://x', fetch)
    await api.index('b', [{ from: 1, to: 9, rung: 'R3' }])
    await api.retry('b')
    await api.preview('b', [1, 2])
    await api.search({ query: 'cover up', bookId: 'b', k: 8 })
    expect(calls.map((c) => c.url)).toEqual([
      'http://x/api/books/b/index',
      'http://x/api/books/b/retry',
      'http://x/api/books/b/preview',
      'http://x/api/search',
    ])
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      methods: [{ from: 1, to: 9, rung: 'R3' }],
    })
    expect(JSON.parse(calls[2]?.init.body as string)).toEqual({ pages: [1, 2] })
    expect(JSON.parse(calls[3]?.init.body as string)).toEqual({
      query: 'cover up',
      bookId: 'b',
      k: 8,
    })
    for (const c of calls)
      expect(new Headers(c.init.headers).get('Content-Type')).toBe(
        'application/json',
      )
  })

  it('deletes with no body to read and returns the outline sections', async () => {
    const { fetch } = fakeFetch([
      new Response(null, { status: 204 }),
      json({ sections: [{ id: 1, title: 'Ch 1' }] }),
    ])
    const api = createLibraryApi('http://x', fetch)
    await expect(api.remove('b')).resolves.toBeUndefined()
    expect(await api.outline('b')).toEqual([{ id: 1, title: 'Ch 1' }])
  })

  it('turns the server error envelope into a LibraryError', async () => {
    const { fetch } = fakeFetch([
      json(
        {
          error: {
            code: 'budget_exceeded',
            message: 'this would cost $0.01',
            details: { cap: 'daily' },
          },
        },
        429,
      ),
    ])
    const err = await createLibraryApi('http://x', fetch)
      .index('b', [{ from: 1, to: 2, rung: 'R3' }])
      .catch((e) => e)
    expect(err).toBeInstanceOf(LibraryError)
    expect(err).toMatchObject({
      code: 'budget_exceeded',
      status: 429,
      message: 'this would cost $0.01',
    })
  })

  it('reports an unreachable server and an unreadable error body plainly', async () => {
    const down = createLibraryApi(
      'http://x',
      fakeFetch([new TypeError('Failed to fetch')]).fetch,
    )
    await expect(down.listBooks()).rejects.toMatchObject({
      code: 'network',
      status: 0,
    })
    const odd = createLibraryApi(
      'http://x',
      fakeFetch([new Response('<html>', { status: 502 })]).fetch,
    )
    await expect(odd.listBooks()).rejects.toMatchObject({
      code: 'http_error',
      status: 502,
    })
  })

  it('builds the URLs of the file and of a page image', () => {
    const api = createLibraryApi('http://x/', fakeFetch([]).fetch)
    expect(api.fileUrl('b')).toBe('http://x/api/books/b/file')
    expect(api.pageImageUrl('b', 7, 1200)).toBe(
      'http://x/api/books/b/pages/7/image?w=1200',
    )
    expect(api.pageImageUrl('b', 7)).toBe('http://x/api/books/b/pages/7/image')
  })

  it('creates a board with a scope and reads a page with its printed label', async () => {
    const { fetch, calls } = fakeFetch([
      json(
        {
          id: 'board-1',
          title: 'Algebra',
          scope: { kind: 'book', bookId: 'b' },
        },
        201,
      ),
      json({ page: 7, label: 'iv', text: 'hello', method: 'R1' }),
    ])
    const api = createLibraryApi('http://x', fetch)
    const board = await api.createBoard('Algebra', {
      kind: 'book',
      bookId: 'b',
    })
    expect(board.id).toBe('board-1')
    expect(calls[0]?.url).toBe('http://x/api/boards')
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      title: 'Algebra',
      scope: { kind: 'book', bookId: 'b' },
    })
    expect(await api.getPage('b', 7)).toEqual({
      page: 7,
      label: 'iv',
      text: 'hello',
      method: 'R1',
    })
    expect(calls[1]?.url).toBe('http://x/api/books/b/pages/7')
  })
})

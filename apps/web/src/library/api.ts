import type { Scope } from './scope'

// A client for the server's library routes (docs/plans/api.md). Browser only talks to our own server, never to a provider.
export type BookStatus =
  | 'uploaded'
  | 'queued'
  | 'extracting'
  | 'structuring'
  | 'embedding'
  | 'summarising'
  | 'ready'
  | 'failed'
export type Rung = 'R1' | 'R3' | 'R4'
export type PageRange = { from: number; to: number; rung: Rung }

export type Book = {
  id: string
  title: string
  author: string | null
  lang: string | null
  pages: number | null
  status: BookStatus
  progress: number
  error: string | null
  createdAt: number
  embedModel: string | null
  ingestMethod: {
    ranges?: PageRange[]
    warnings?: number[]
    notes?: string[]
  } | null
  methods: Record<Rung, number>
  chunks: number
}
export type Estimate = {
  pages: number
  r1: number
  r4: number
  scanned: number
  mathDense: number
  embedUsd: number
  r3Usd: number
  dailyRemainingUsd: number
}
export type Section = {
  id: number
  parentId: number | null
  ord: number
  level: number
  title: string
  pageStart: number | null
  pageEnd: number | null
  summary: string | null
  tokens: number | null
}
export type Hit = {
  chunkId: number
  bookId: string
  sectionId: number | null
  ord: number
  pageStart: number | null
  pageEnd: number | null
  citeLabel: string
  headingPath: string
  text: string
  score: number
  neighbor: boolean
}
export type PreviewPage = {
  page: number
  label: string
  imageUrl: string
  r1: { text: string }
  r4: { text: string; truncated: boolean } | { error: string }
}
export type PageText = {
  page: number
  label: string | null
  text: string
  method: Rung
}
export type Board = {
  id: string
  title: string
  scope?: Scope | Record<string, never>
}
export type SearchBody = {
  query: string
  bookId?: string
  sectionIds?: number[]
  k?: number
  neighbors?: boolean
}

/** What went wrong, in the server's own words (`code` is the api.md error code, or 'network' / 'http_error'). */
export class LibraryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'LibraryError'
  }
}

export type LibraryApi = ReturnType<typeof createLibraryApi>

export function createLibraryApi(
  base: string,
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  const root = base.replace(/\/+$/, '')

  async function request<T>(
    method: string,
    path: string,
    o: { body?: BodyInit; type?: string } = {},
  ): Promise<T> {
    let res: Response
    try {
      res = await fetchImpl(`${root}${path}`, {
        method,
        ...(o.type ? { headers: { 'Content-Type': o.type } } : {}),
        ...(o.body === undefined ? {} : { body: o.body }),
      })
    } catch {
      throw new LibraryError('network', 0, 'The server could not be reached.')
    }
    if (!res.ok) {
      let code = 'http_error'
      let message = `The server answered ${res.status}.`
      try {
        const e = (
          (await res.json()) as { error?: { code?: string; message?: string } }
        ).error
        if (e?.code) code = e.code
        if (e?.message) message = e.message
      } catch {}
      throw new LibraryError(code, res.status, message)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }
  const post = <T>(path: string, body: unknown) =>
    request<T>('POST', path, {
      body: JSON.stringify(body),
      type: 'application/json',
    })
  const enc = encodeURIComponent

  return {
    listBooks: async () =>
      (await request<{ books: Book[] }>('GET', '/api/books')).books,
    getBook: (id: string) => request<Book>('GET', `/api/books/${enc(id)}`),
    upload: (file: Blob, title: string) =>
      request<Book>('POST', `/api/books?title=${enc(title)}`, {
        body: file,
        type: 'application/pdf',
      }),
    estimate: (id: string) =>
      request<Estimate>('GET', `/api/books/${enc(id)}/estimate`),
    preview: async (id: string, pages: number[]) =>
      (
        await post<{ pages: PreviewPage[] }>(`/api/books/${enc(id)}/preview`, {
          pages,
        })
      ).pages,
    index: (id: string, methods?: PageRange[]) =>
      post<{ id: string; status: BookStatus }>(
        `/api/books/${enc(id)}/index`,
        methods ? { methods } : {},
      ),
    retry: (id: string) =>
      post<{ id: string; status: BookStatus }>(
        `/api/books/${enc(id)}/retry`,
        {},
      ),
    remove: (id: string) => request<void>('DELETE', `/api/books/${enc(id)}`),
    outline: async (id: string) =>
      (
        await request<{ sections: Section[] }>(
          'GET',
          `/api/books/${enc(id)}/outline`,
        )
      ).sections,
    getPage: (id: string, page: number) =>
      request<PageText>('GET', `/api/books/${enc(id)}/pages/${page}`),
    createBoard: (title: string, scope: Scope) =>
      post<Board>('/api/boards', { title, scope }),
    getBoard: (id: string) => request<Board>('GET', `/api/boards/${enc(id)}`),
    /** `{}` clears the scope (no book). */
    setBoardScope: (id: string, scope: Scope | Record<string, never>) =>
      request<Board>('PATCH', `/api/boards/${enc(id)}`, {
        body: JSON.stringify({ scope }),
        type: 'application/json',
      }),
    search: (body: SearchBody) =>
      post<{ mode: 'hybrid' | 'keyword'; hits: Hit[] }>('/api/search', body),
    fileUrl: (id: string) => `${root}/api/books/${enc(id)}/file`,
    pageImageUrl: (id: string, page: number, width?: number) =>
      `${root}/api/books/${enc(id)}/pages/${page}/image${width ? `?w=${width}` : ''}`,
  }
}

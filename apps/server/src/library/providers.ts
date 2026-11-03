import { ApiError } from '../errors'

/**
 * Everything M4 asks of an outside service, behind one injectable interface so the pipeline is tested without a network.
 * Real implementations are in `createProviders` (Task 7); `stubProviders` is the deterministic stand-in for tests and the e2e.
 */
export type Providers = {
  /** One unit-length vector per text, in order. `costUsd` is the OpenRouter bill (embeddings are the only priced call besides R3). */
  embed(texts: string[]): Promise<{ vectors: Float32Array[]; costUsd: number }>
  /** R4: one page image to Markdown + LaTeX. `truncated` is true when the model ran out of output budget. */
  transcribePage(png: Uint8Array): Promise<{ text: string; truncated: boolean }>
  /** R3 (opt-in, paid): a small PDF in, the Markdown of each of its pages out, in order. */
  ocrPages(
    pdf: Uint8Array,
    pageCount: number,
  ): Promise<{ pages: string[]; costUsd: number }>
  /** A short text completion (summaries). */
  complete(prompt: string, o?: { maxTokens?: number }): Promise<string>
}

export type FetchOptions = {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  tries?: number
  baseMs?: number
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * `fetch` that retries a 429, a 5xx or a dropped connection (4 tries, 1.5 s doubling: S4b saw a transient 429 on 5 of
 * 24 embedding batches). Anything else not ok, or running out of tries, is an `upstream_error` that names the status
 * only: never the request, so a key in a header cannot reach a log or a response.
 */
export async function retryFetch(
  url: string,
  init: RequestInit,
  o: FetchOptions = {},
): Promise<Response> {
  const doFetch = o.fetch ?? fetch
  const sleep = o.sleep ?? wait
  const tries = o.tries ?? 4
  let delay = o.baseMs ?? 1500
  let last = 'no response'
  for (let i = 0; i < tries; i++) {
    if (i > 0) {
      await sleep(delay)
      delay *= 2
    }
    try {
      const r = await doFetch(url, init)
      if (r.ok) return r
      last = `HTTP ${r.status}`
      if (r.status !== 429 && r.status < 500)
        throw new ApiError('upstream_error', `provider returned ${last}`)
    } catch (e) {
      if (e instanceof ApiError) throw e
      last = 'connection failed'
    }
  }
  throw new ApiError(
    'upstream_error',
    `provider failed after ${tries} tries (${last})`,
  )
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** A hashed bag of words, L2-normalised: texts sharing words land close, so search tests mean something. */
export function stubVector(text: string, dims: number): Float32Array {
  const v = new Float32Array(dims)
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const i = fnv1a(w) % dims
    v[i] = (v[i] ?? 0) + 1
  }
  const n = Math.hypot(...v) || 1
  for (let i = 0; i < dims; i++) v[i] = (v[i] as number) / n
  return v
}

/** Deterministic, free, offline: for unit tests and the e2e gate (never a real provider). */
export function stubProviders(o: { dims?: number } = {}): Providers {
  const dims = o.dims ?? 16
  return {
    async embed(texts) {
      return { vectors: texts.map((t) => stubVector(t, dims)), costUsd: 0 }
    },
    async transcribePage() {
      return { text: 'stub transcription', truncated: false }
    },
    async ocrPages(_pdf, pageCount) {
      return {
        pages: Array.from(
          { length: pageCount },
          (_, i) => `stub r3 page ${i + 1}`,
        ),
        costUsd: 0,
      }
    },
    async complete(prompt) {
      return `summary: ${prompt.slice(0, 40)}`
    },
  }
}

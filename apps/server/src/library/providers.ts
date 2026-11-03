import type { Config } from '../config'
import { ApiError } from '../errors'
import { cleanText } from './pdf'

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

const OPENROUTER = 'https://openrouter.ai/api/v1'
const EMBED_BATCH = 64
const EMBED_USD_PER_TOKEN = 0.01 / 1e6 // baai/bge-m3, when the response carries no cost
const R4_MAX_TOKENS = 12_000 // Muse spends reasoning tokens first: the S2 default of 4,000 cut off Arabic page 78
const R3_CARRIER_MODEL = 'anthropic/claude-haiku-5.5' // reads the parsed PDF; its answer is thrown away (S2)
// Unchanged from S2/ocr.ts, the prompt the owner validated the Arabic and CK-12 transcriptions with.
const R4_PROMPT =
  'Transcribe this textbook page to Markdown. Math as LaTeX ($...$ inline, $$...$$ display). Keep Arabic text exactly as printed (right-to-left, no translation). Keep headings, lists, tables. Output only the transcription; do not invent text that is not on the page; mark illegible parts as [illegible].'

/** The parts of an OpenAI-style reply that M4 reads. */
type ProviderJson = {
  data?: { index: number; embedding?: number[] }[]
  choices?: {
    finish_reason?: string
    message?: {
      content?: string | null
      annotations?: {
        file?: { content?: { type?: string; text?: string }[] }
      }[]
    }
  }[]
  usage?: { cost?: number; prompt_tokens?: number }
}

const need = (value: string | undefined, name: string): string => {
  if (!value) throw new ApiError('upstream_error', `${name} is not set`)
  return value
}

const unit = (v: Float32Array): Float32Array => {
  const n = Math.hypot(...v) || 1
  return v.map((x) => x / n)
}

/** The real providers: Meta Model API for vision and summaries, OpenRouter for embeddings and the opt-in R3. */
export function createProviders(o: {
  config: Pick<
    Config,
    'metaBaseUrl' | 'visionModel' | 'cheapModel' | 'embedModel' | 'embedDims'
  >
  /** Where the keys are read from (never kept in `Config`). */
  env: Record<string, string | undefined>
  openrouterBaseUrl?: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}): Providers {
  const { config, env } = o
  const openrouter = (o.openrouterBaseUrl ?? OPENROUTER).replace(/\/+$/, '')

  async function post(
    base: string,
    path: string,
    key: string,
    body: unknown,
  ): Promise<ProviderJson> {
    const r = await retryFetch(
      `${base}${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      { fetch: o.fetch, sleep: o.sleep },
    )
    try {
      return (await r.json()) as ProviderJson
    } catch {
      throw new ApiError(
        'upstream_error',
        'provider sent a reply that is not JSON',
      )
    }
  }
  /** One Meta chat completion. A 404 there is almost always a model name the API does not serve: say which setting holds it. */
  const metaChat = async (
    key: string,
    model: string,
    setting: 'VISION_MODEL' | 'CHEAP_MODEL',
    maxTokens: number,
    content: unknown,
  ) => {
    let json: ProviderJson
    try {
      json = await post(config.metaBaseUrl, '/chat/completions', key, {
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }],
      })
    } catch (e) {
      if (e instanceof ApiError && e.message.includes('HTTP 404'))
        throw new ApiError(
          'upstream_error',
          `the Meta Model API has no model "${model}": check ${setting} (api.meta.ai serves muse-spark-1.3 and muse-wonder-1.0)`,
        )
      throw e
    }
    const choice = json?.choices?.[0]
    return {
      text: String(choice?.message?.content ?? ''),
      cutOff: choice?.finish_reason === 'length',
    }
  }

  return {
    async embed(texts) {
      if (texts.length === 0) return { vectors: [], costUsd: 0 }
      const key = need(env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY')
      const vectors: Float32Array[] = []
      let costUsd = 0
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH)
        const json = await post(openrouter, '/embeddings', key, {
          model: config.embedModel,
          input: batch,
          usage: { include: true },
          provider: { data_collection: 'deny' },
        })
        const rows = [...(json?.data ?? [])].sort((a, b) => a.index - b.index)
        if (rows.length !== batch.length)
          throw new ApiError(
            'upstream_error',
            `embeddings: asked for ${batch.length} vectors, got ${rows.length}`,
          )
        for (const r of rows) {
          if (r.embedding?.length !== config.embedDims)
            throw new ApiError(
              'upstream_error',
              `embeddings: got ${r.embedding?.length} dims, expected ${config.embedDims}`,
            )
          vectors.push(unit(Float32Array.from(r.embedding)))
        }
        costUsd +=
          json.usage?.cost ??
          (json.usage?.prompt_tokens ?? 0) * EMBED_USD_PER_TOKEN
      }
      return { vectors, costUsd }
    },

    async transcribePage(png) {
      const key = need(env.META_API_KEY, 'META_API_KEY')
      const content = [
        { type: 'text', text: R4_PROMPT },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
          },
        },
      ]
      let r = await metaChat(
        key,
        config.visionModel,
        'VISION_MODEL',
        R4_MAX_TOKENS,
        content,
      )
      if (r.cutOff)
        r = await metaChat(
          key,
          config.visionModel,
          'VISION_MODEL',
          R4_MAX_TOKENS * 2,
          content,
        )
      return { text: cleanText(r.text).trim(), truncated: r.cutOff }
    },

    async ocrPages(pdf, pageCount) {
      const key = need(env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY')
      const json = await post(openrouter, '/chat/completions', key, {
        model: R3_CARRIER_MODEL,
        max_tokens: 8,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Reply OK.' },
              {
                type: 'file',
                file: {
                  filename: 'slice.pdf',
                  file_data: `data:application/pdf;base64,${Buffer.from(pdf).toString('base64')}`,
                },
              },
            ],
          },
        ],
        plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
        usage: { include: true },
        provider: { data_collection: 'deny' },
      })
      const parts: { type?: string; text?: string }[] =
        json?.choices?.[0]?.message?.annotations?.[0]?.file?.content ?? []
      // One text element per page sits between the <file ...> and </file> markers; image parts are skipped.
      const pages = parts
        .filter(
          (p) =>
            p.type === 'text' &&
            typeof p.text === 'string' &&
            !/^<\/?file[ >]/.test(p.text),
        )
        .map((p) => cleanText(p.text as string).trim())
      if (pages.length !== pageCount && pageCount !== 1)
        throw new ApiError(
          'upstream_error',
          `ocr: asked for ${pageCount} pages, got ${pages.length}`,
        )
      return {
        pages: pageCount === 1 ? [pages.join('\n\n')] : pages,
        costUsd: json?.usage?.cost ?? 0,
      }
    },

    async complete(prompt, opts) {
      const key = need(env.META_API_KEY, 'META_API_KEY')
      const r = await metaChat(
        key,
        config.cheapModel,
        'CHEAP_MODEL',
        opts?.maxTokens ?? 6000,
        prompt,
      )
      const text = cleanText(r.text).trim()
      if (!text)
        throw new ApiError(
          'upstream_error',
          'the model returned an empty completion',
        )
      return text
    },
  }
}

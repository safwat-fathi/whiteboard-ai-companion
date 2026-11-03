import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config'
import { createProviders } from './providers'

// biome-ignore lint/suspicious/noExplicitAny: the fake provider reads request bodies of every shape
type Seen = { url: string; auth: string | undefined; body: any }
type Reply = { status?: number; json: unknown }
const servers: http.Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

/** A fake provider: `handler` answers each request in turn; `seen` records what arrived. */
async function fake(handler: (n: number, seen: Seen) => Reply) {
  const seen: Seen[] = []
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const s: Seen = {
      url: req.url ?? '',
      auth: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
    }
    seen.push(s)
    const r = handler(seen.length - 1, s)
    res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(r.json))
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  servers.push(server)
  return {
    seen,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  }
}
const noSleep = async () => {}
const make = (
  meta: string,
  or: string,
  env: Record<string, string | undefined> = {
    MODEL_API_KEY: 'meta-key',
    OPENROUTER_API_KEY: 'or-key',
  },
  cfg: Record<string, string | undefined> = {},
) =>
  createProviders({
    config: loadConfig({
      META_API_BASE_URL: `${meta}/v1`,
      EMBED_DIMS: '8',
      ...cfg,
    }),
    env,
    openrouterBaseUrl: `${or}/api/v1`,
    sleep: noSleep,
  })
const chat = (content: string, finish = 'stop') => ({
  json: { choices: [{ message: { content }, finish_reason: finish }] },
})

describe('embed', () => {
  it('batches by 64, keeps order, normalises, sums the bill and asks not to be trained on', async () => {
    const or = await fake((_n, s) => ({
      json: {
        data: (s.body.input as string[])
          .map((_t, i) => ({ index: i, embedding: [3, 4, 0, 0, 0, 0, 0, 0] }))
          .reverse(),
        usage: { prompt_tokens: 10, cost: 0.001 },
      },
    }))
    const p = make('http://unused', or.url)
    const { vectors, costUsd } = await p.embed(
      Array.from({ length: 130 }, (_, i) => `text ${i}`),
    )
    expect(or.seen.map((s) => s.body.input.length)).toEqual([64, 64, 2])
    expect(or.seen[0]).toMatchObject({
      url: '/api/v1/embeddings',
      auth: 'Bearer or-key',
      body: {
        model: 'baai/bge-m3',
        provider: { data_collection: 'deny' },
      },
    })
    expect(vectors).toHaveLength(130)
    expect([...(vectors[0] as Float32Array)].slice(0, 2)).toEqual([
      expect.closeTo(0.6, 5),
      expect.closeTo(0.8, 5),
    ])
    expect(costUsd).toBeCloseTo(0.003, 10)
  })

  it('falls back to the token price when the provider reports no cost', async () => {
    const or = await fake(() => ({
      json: {
        data: [{ index: 0, embedding: [1, 0, 0, 0, 0, 0, 0, 0] }],
        usage: { prompt_tokens: 1_000_000 },
      },
    }))
    const { costUsd } = await make('http://unused', or.url).embed(['a'])
    expect(costUsd).toBeCloseTo(0.01, 10)
  })

  it('refuses a vector of the wrong size and a short reply', async () => {
    const wrong = await fake(() => ({
      json: { data: [{ index: 0, embedding: [1, 0, 0, 0] }] },
    }))
    await expect(
      make('http://unused', wrong.url).embed(['a']),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      message: expect.stringContaining('dims'),
    })
    const short = await fake(() => ({ json: { data: [] } }))
    await expect(
      make('http://unused', short.url).embed(['a']),
    ).rejects.toMatchObject({
      code: 'upstream_error',
    })
  })

  it('names the missing key and makes no request', async () => {
    const or = await fake(() => ({ json: {} }))
    const p = make('http://unused', or.url, {})
    await expect(p.embed(['a'])).rejects.toThrow(/OPENROUTER_API_KEY/)
    expect(or.seen).toHaveLength(0)
  })

  it('embeds nothing without calling out', async () => {
    const or = await fake(() => ({ json: {} }))
    expect(await make('http://unused', or.url).embed([])).toEqual({
      vectors: [],
      costUsd: 0,
    })
    expect(or.seen).toHaveLength(0)
  })
})

describe('transcribePage', () => {
  const png = new Uint8Array([137, 80, 78, 71])

  it('sends the page as an image_url in a user message to the vision model', async () => {
    const meta = await fake(() => chat('# Heading\n$$x$$'))
    const r = await make(meta.url, 'http://unused').transcribePage(png)
    expect(r).toEqual({ text: '# Heading\n$$x$$', truncated: false })
    const s = meta.seen[0] as Seen
    expect(s.url).toBe('/v1/chat/completions')
    expect(s.auth).toBe('Bearer meta-key')
    expect(s.body.model).toBe('muse-spark-1.3')
    expect(s.body.max_tokens).toBe(12000)
    const [msg] = s.body.messages
    expect(msg.role).toBe('user')
    expect(msg.content[0].text).toContain('Transcribe this textbook page')
    expect(msg.content[1].image_url.url).toBe(
      `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
    )
  })

  it('retries once with twice the budget when the answer was cut off', async () => {
    const meta = await fake((n) =>
      n === 0 ? chat('partial', 'length') : chat('whole page'),
    )
    const r = await make(meta.url, 'http://unused').transcribePage(png)
    expect(r).toEqual({ text: 'whole page', truncated: false })
    expect(meta.seen.map((s) => s.body.max_tokens)).toEqual([12000, 24000])
  })

  it('keeps the partial text and says so when it is still cut off', async () => {
    const meta = await fake(() => chat('still partial', 'length'))
    const r = await make(meta.url, 'http://unused').transcribePage(png)
    expect(r).toEqual({ text: 'still partial', truncated: true })
    expect(meta.seen).toHaveLength(2)
  })

  it('retries a 429 and strips control characters from the text', async () => {
    const meta = await fake((n) =>
      n === 0 ? { status: 429, json: {} } : chat('ok\u0001 text'),
    )
    const r = await make(meta.url, 'http://unused').transcribePage(png)
    expect(r.text).toBe('ok text')
  })

  it('names the missing key', async () => {
    await expect(
      make('http://unused', 'http://unused', {}).transcribePage(png),
    ).rejects.toThrow(/MODEL_API_KEY/)
  })

  it('says which model the Meta Model API does not know and which setting to change on a 404', async () => {
    const meta = await fake(() => ({
      status: 404,
      json: { error: { code: 'model_not_found' } },
    }))
    const p = make(meta.url, 'http://unused', undefined, {
      VISION_MODEL: 'Llama-4-Maverick-17B-128E-Instruct-FP8',
    })
    await expect(p.transcribePage(png)).rejects.toMatchObject({
      code: 'upstream_error',
      message: expect.stringMatching(/Llama-4-Maverick.*VISION_MODEL/s),
    })
    await expect(make(meta.url, 'http://unused').complete('x')).rejects.toThrow(
      /muse-spark-1\.3.*CHEAP_MODEL/s,
    )
  })
})

describe('ocrPages (R3)', () => {
  const pdf = new TextEncoder().encode('%PDF-fake')
  const file = (...parts: unknown[]) => ({
    json: {
      choices: [
        {
          message: {
            content: 'OK',
            annotations: [{ type: 'file', file: { content: parts } }],
          },
        },
      ],
      usage: { cost: 0.0021 },
    },
  })
  const t = (text: string) => ({ type: 'text', text })

  it('asks OpenRouter for mistral-ocr and returns one text per page, ignoring images and the file markers', async () => {
    const or = await fake(() =>
      file(
        t('<file name="slice.pdf">'),
        t('47\n\n# Theorem'),
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,xx' } },
        t('48\n\nProof.'),
        t('</file>'),
      ),
    )
    const r = await make('http://unused', or.url).ocrPages(pdf, 2)
    expect(r).toEqual({
      pages: ['47\n\n# Theorem', '48\n\nProof.'],
      costUsd: 0.0021,
    })
    const s = or.seen[0] as Seen
    expect(s.url).toBe('/api/v1/chat/completions')
    expect(s.auth).toBe('Bearer or-key')
    expect(s.body.plugins).toEqual([
      { id: 'file-parser', pdf: { engine: 'mistral-ocr' } },
    ])
    expect(s.body.provider).toEqual({ data_collection: 'deny' })
    expect(s.body.messages[0].content[1].file.file_data).toBe(
      `data:application/pdf;base64,${Buffer.from(pdf).toString('base64')}`,
    )
  })

  it('joins every text element for a one-page slice', async () => {
    const or = await fake(() =>
      file(t('<file name="p.pdf">'), t('a'), t('b'), t('</file>')),
    )
    const r = await make('http://unused', or.url).ocrPages(pdf, 1)
    expect(r.pages).toEqual(['a\n\nb'])
  })

  it('refuses a reply whose page count does not match a multi-page slice', async () => {
    const or = await fake(() =>
      file(t('<file name="p.pdf">'), t('a'), t('</file>')),
    )
    await expect(
      make('http://unused', or.url).ocrPages(pdf, 3),
    ).rejects.toMatchObject({
      code: 'upstream_error',
    })
  })
})

describe('complete', () => {
  it('returns the text of a short completion from the cheap model', async () => {
    const meta = await fake(() => chat('A summary.'))
    const text = await make(meta.url, 'http://unused').complete('Summarise', {
      maxTokens: 777,
    })
    expect(text).toBe('A summary.')
    expect(meta.seen[0]?.body).toMatchObject({
      model: 'muse-spark-1.3',
      max_tokens: 777,
      messages: [{ role: 'user', content: 'Summarise' }],
    })
  })

  it('asks again with twice the budget when the model spent it all reasoning and said nothing', async () => {
    const meta = await fake((n) =>
      n === 0 ? chat('', 'length') : chat('Now a summary.'),
    )
    const text = await make(meta.url, 'http://unused').complete('Summarise', {
      maxTokens: 500,
    })
    expect(text).toBe('Now a summary.')
    expect(meta.seen.map((s) => s.body.max_tokens)).toEqual([500, 1000])
  })

  it('treats an empty completion as a failure', async () => {
    const meta = await fake(() => chat('', 'length'))
    await expect(
      make(meta.url, 'http://unused').complete('x'),
    ).rejects.toMatchObject({
      code: 'upstream_error',
    })
  })
})

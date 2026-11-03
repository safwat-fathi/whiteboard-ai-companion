import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isStepCount, streamText, tool } from 'ai'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  costOf,
  createLlm,
  isMostlyArabic,
  pickModel,
  upstreamError,
  usageOf,
} from './llm'

const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

type Seen = { model: string; body: Record<string, unknown> }
/** A fake OpenAI-compatible endpoint: `plan(model)` returns an HTTP status or the text to stream. */
async function fake(plan: (model: string) => number | string) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      seen.push({ model: String(body.model), body })
      const out = plan(String(body.model))
      if (typeof out === 'number') {
        res.writeHead(out, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: `status ${out}` } }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      const base = {
        id: '1',
        object: 'chat.completion.chunk',
        created: 0,
        model: body.model,
      }
      chunk({
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: out },
            finish_reason: null,
          },
        ],
      })
      chunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })
      chunk({
        ...base,
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      })
      res.end('data: [DONE]\n\n')
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  return { seen, llm: createLlm({ baseUrl, apiKey: 'sk-test' }) }
}

const ping = tool({
  description: 'ping',
  inputSchema: z.object({}),
  execute: async () => 'pong',
})

describe('createLlm', () => {
  it('streams text, sends the tools and asks for usage, and reports cached tokens', async () => {
    const { seen, llm } = await fake(() => 'Hello there')
    const steps: ReturnType<typeof usageOf>[] = []
    const r = streamText({
      model: llm.model('m1', 'm1'),
      instructions: 'be brief',
      prompt: 'hi',
      tools: { ping },
      stopWhen: isStepCount(2),
      onStepFinish: (s) => void steps.push(usageOf(s.usage)),
    })
    expect(await r.text).toBe('Hello there')
    const body = seen[0]?.body as {
      stream_options?: { include_usage?: boolean }
      tools?: { function: { name: string } }[]
    }
    expect(body.stream_options?.include_usage).toBe(true)
    expect(body.tools?.[0]?.function.name).toBe('ping')
    expect(steps).toEqual([
      { inputTokens: 100, cachedTokens: 40, outputTokens: 20 },
    ])
  })

  it('sends reasoning_effort only when asked to', async () => {
    const { seen, llm } = await fake(() => 'ok')
    const run = (providerOptions?: { meta: { reasoningEffort: string } }) =>
      streamText({
        model: llm.model('m1', 'm1'),
        prompt: 'hi',
        ...(providerOptions ? { providerOptions } : {}),
      }).text
    await run()
    await run({ meta: { reasoningEffort: 'low' } })
    expect(seen[0]?.body.reasoning_effort).toBeUndefined()
    expect(seen[1]?.body.reasoning_effort).toBe('low')
  })

  it('retries once on the fallback model after a 5xx and says so', async () => {
    const { seen, llm } = await fake((m) =>
      m === 'primary' ? 500 : 'from fallback',
    )
    let fell = 0
    const r = streamText({
      model: llm.model('primary', 'backup', () => void fell++),
      prompt: 'hi',
      maxRetries: 0,
    })
    expect(await r.text).toBe('from fallback')
    expect(fell).toBe(1)
    expect(seen.map((s) => s.model)).toEqual(['primary', 'backup'])
  })

  it.each([402, 429])(
    'does not fall back on %i and maps it to a plain upstream error',
    async (status) => {
      const { seen, llm } = await fake(() => status)
      let err: unknown
      const r = streamText({
        model: llm.model('primary', 'backup'),
        prompt: 'hi',
        maxRetries: 0,
        onError: (e) => {
          err = e.error
        },
      })
      await r.consumeStream()
      expect(seen.map((s) => s.model)).toEqual(['primary'])
      const mapped = upstreamError(err)
      expect(mapped.code).toBe('upstream_error')
      expect(mapped.message).toMatch(
        status === 402 ? /credits/ : /rate limiting/,
      )
      expect(JSON.stringify(mapped)).not.toContain('sk-test')
    },
  )
})

describe('pure helpers', () => {
  it('costs a usage only when a price is set', () => {
    const u = { inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 500_000 }
    expect(costOf(null, u)).toBeNull()
    expect(costOf({ inPerM: 0.1, outPerM: 0.5 }, u)).toBeCloseTo(0.35, 10)
  })
  it('picks the Arabic model for mostly-Arabic text only', () => {
    const t = { model: 'en', modelAr: 'ar' } as Parameters<typeof pickModel>[0]
    expect(isMostlyArabic('اشرح لي الدالة x^2')).toBe(true)
    expect(pickModel(t, 'ما هو الجذر؟')).toBe('ar')
    expect(pickModel(t, 'What is a root? جذر')).toBe('en')
    expect(pickModel(t, '1 + 1 = 2')).toBe('en')
  })
  it('maps a missing usage to zeros', () => {
    expect(usageOf(undefined)).toEqual({
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
    })
  })
})

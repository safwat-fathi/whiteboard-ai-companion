import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../errors'
import { retryFetch, stubProviders } from './providers'

const res = (status: number, body = '') => new Response(body, { status })
const noSleep = async () => {}

describe('retryFetch', () => {
  it('retries a 429 and then succeeds', async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(200, 'ok'))
    const r = await retryFetch('http://x', {}, { fetch: f, sleep: noSleep })
    expect(await r.text()).toBe('ok')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('backs off 1.5 s, doubling, between tries', async () => {
    const waits: number[] = []
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(500))
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(200))
    await retryFetch(
      'http://x',
      {},
      { fetch: f, sleep: async (ms) => void waits.push(ms) },
    )
    expect(waits).toEqual([1500, 3000, 6000])
  })

  it('gives up after four tries with upstream_error', async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(res(429))
    const err = await retryFetch(
      'http://x',
      {},
      { fetch: f, sleep: noSleep },
    ).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('upstream_error')
    expect(f).toHaveBeenCalledTimes(4)
  })

  it('does not retry a 400 and does not leak the request headers', async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(res(400, 'bad'))
    const err = await retryFetch(
      'http://x',
      { headers: { Authorization: 'Bearer sk-secret' } },
      { fetch: f, sleep: noSleep },
    ).catch((e) => e)
    expect(err.code).toBe('upstream_error')
    expect(f).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(err.toJSON())).not.toContain('sk-secret')
  })

  it('retries a network failure', async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(res(200))
    const r = await retryFetch('http://x', {}, { fetch: f, sleep: noSleep })
    expect(r.status).toBe(200)
  })
})

describe('stubProviders', () => {
  it('embeds deterministically to unit-length vectors of the asked size', async () => {
    const p = stubProviders({ dims: 16 })
    const a = await p.embed(['the cover-up method', 'the cover-up method'])
    expect(a.vectors).toHaveLength(2)
    expect(a.vectors[0]).toHaveLength(16)
    expect(a.vectors[0]).toEqual(a.vectors[1])
    const norm = Math.hypot(...(a.vectors[0] as Float32Array))
    expect(norm).toBeCloseTo(1, 5)
    expect(a.costUsd).toBe(0)
  })

  it('puts texts that share words closer than texts that share none', async () => {
    const p = stubProviders({ dims: 64 })
    const { vectors } = await p.embed([
      'absolute value equation cases',
      'solve the absolute value equation',
      'photosynthesis light reactions chlorophyll',
    ])
    const dot = (x: Float32Array, y: Float32Array) =>
      x.reduce((s, v, i) => s + v * (y[i] as number), 0)
    const [a, b, c] = vectors as [Float32Array, Float32Array, Float32Array]
    expect(dot(a, b)).toBeGreaterThan(dot(a, c))
  })
})

import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it('has local defaults', () => {
    const c = loadConfig({})
    expect(c.port).toBe(4000)
    expect(c.host).toBe('127.0.0.1')
    expect(isAbsolute(c.dataDir)).toBe(true)
    expect(c.dataDir.endsWith('data')).toBe(true)
    expect(c.publicOrigin).toBe('http://localhost:3000')
    expect(c.keys).toEqual({ meta: false, openrouter: false })
  })

  it('resolves a relative DATA_DIR against baseDir and keeps an absolute one', () => {
    expect(loadConfig({}, '/repo').dataDir).toBe('/repo/data')
    expect(loadConfig({ DATA_DIR: './var/db' }, '/repo').dataDir).toBe(
      '/repo/var/db',
    )
    expect(loadConfig({ DATA_DIR: '/srv/wb' }, '/repo').dataDir).toBe('/srv/wb')
  })

  it('normalises PUBLIC_ORIGIN to a bare origin', () => {
    expect(
      loadConfig({ PUBLIC_ORIGIN: 'http://localhost:3000/' }).publicOrigin,
    ).toBe('http://localhost:3000')
    expect(
      loadConfig({ PUBLIC_ORIGIN: 'https://study.example.com/app?x=1' })
        .publicOrigin,
    ).toBe('https://study.example.com')
  })

  it('names the key when a value is invalid', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/)
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/)
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'nope' })).toThrow(/PUBLIC_ORIGIN/)
  })

  it('reports key presence as booleans and never keeps the value', () => {
    const c = loadConfig({
      META_API_KEY: 'sk-secret-meta',
      OPENROUTER_API_KEY: '',
    })
    expect(c.keys).toEqual({ meta: true, openrouter: false })
    expect(JSON.stringify(c)).not.toContain('sk-secret-meta')

    // Also supports MODEL_API_KEY from Meta Model Cookbook
    const cCookbook = loadConfig({
      MODEL_API_KEY: 'sk-cookbook-key',
    })
    expect(cCookbook.keys.meta).toBe(true)
    expect(JSON.stringify(cCookbook)).not.toContain('sk-cookbook-key')
  })

  it('has library defaults from .env.example', () => {
    const c = loadConfig({})
    expect(c.metaBaseUrl).toBe('https://api.meta.ai/v1')
    expect(c.cheapModel).toBe('muse-spark-1.3')
    expect(c.visionModel).toBe('muse-spark-1.3')
    expect(c.embedModel).toBe('baai/bge-m3')
    expect(c.embedDims).toBe(1024)
    expect(c.dailyBudgetUsd).toBe(5)
  })

  it('reads library settings and names the key when one is invalid', () => {
    const c = loadConfig({
      META_API_BASE_URL: 'http://localhost:9/v1/',
      CHEAP_MODEL: 'm1',
      VISION_MODEL: 'm2',
      EMBED_MODEL: 'e',
      EMBED_DIMS: '64',
      DAILY_BUDGET_USD: '0.5',
    })
    expect(c).toMatchObject({
      metaBaseUrl: 'http://localhost:9/v1',
      cheapModel: 'm1',
      visionModel: 'm2',
      embedModel: 'e',
      embedDims: 64,
      dailyBudgetUsd: 0.5,
    })
    expect(() => loadConfig({ EMBED_DIMS: '10' })).toThrow(/EMBED_DIMS/)
    expect(() => loadConfig({ EMBED_DIMS: 'x' })).toThrow(/EMBED_DIMS/)
    expect(() => loadConfig({ DAILY_BUDGET_USD: '-1' })).toThrow(
      /DAILY_BUDGET_USD/,
    )
    expect(() => loadConfig({ META_API_BASE_URL: 'nope' })).toThrow(
      /META_API_BASE_URL/,
    )
  })
  it('has tutor defaults from .env.example and no price', () => {
    const t = loadConfig({}).tutor
    expect(t).toEqual({
      model: 'muse-spark-1.3',
      modelAr: 'muse-spark-1.3',
      fallbackModel: 'muse-spark-1.3',
      maxSteps: 12,
      maxTurnCostUsd: 0.5,
      turnTimeoutMs: 120_000,
      chapterStuffMaxTokens: 60_000,
      snapshotAdapter: 'follow-up-user',
      reasoningEffort: null,
      price: null,
    })
  })

  it('reads an optional reasoning effort and refuses an unknown one', () => {
    expect(
      loadConfig({ TUTOR_REASONING_EFFORT: 'low' }).tutor.reasoningEffort,
    ).toBe('low')
    expect(() => loadConfig({ TUTOR_REASONING_EFFORT: 'max' })).toThrow(
      /TUTOR_REASONING_EFFORT/,
    )
  })

  it('reads tutor settings, a price only when one is set, and names the key when invalid', () => {
    const t = loadConfig({
      TUTOR_MODEL: 'a',
      TUTOR_MODEL_AR: 'b',
      TUTOR_FALLBACK_MODEL: 'c',
      MAX_STEPS: '2',
      MAX_TURN_COST_USD: '0.01',
      TURN_TIMEOUT_MS: '5000',
      CHAPTER_STUFF_MAX_TOKENS: '100',
      SNAPSHOT_ADAPTER: 'tool-result-image',
      TUTOR_PRICE_IN_PER_M: '0.1',
    }).tutor
    expect(t).toMatchObject({
      model: 'a',
      modelAr: 'b',
      fallbackModel: 'c',
      maxSteps: 2,
      maxTurnCostUsd: 0.01,
      turnTimeoutMs: 5000,
      chapterStuffMaxTokens: 100,
      snapshotAdapter: 'tool-result-image',
      price: { inPerM: 0.1, outPerM: 0 },
    })
    for (const bad of [
      'MAX_STEPS',
      'MAX_TURN_COST_USD',
      'TURN_TIMEOUT_MS',
      'CHAPTER_STUFF_MAX_TOKENS',
      'SNAPSHOT_ADAPTER',
      'TUTOR_PRICE_OUT_PER_M',
    ])
      expect(() => loadConfig({ [bad]: '-x' })).toThrow(new RegExp(bad))
    expect(() => loadConfig({ MAX_STEPS: '0' })).toThrow(/MAX_STEPS/)
  })
})

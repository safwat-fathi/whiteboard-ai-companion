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
  })
})

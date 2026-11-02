import { describe, expect, it, vi } from 'vitest'
import { getAsyncLoadedModules, renderMath } from './index'

const opts = { display: true, color: '#000' }

const HOSTILE: [string, string][] = [
  ['\\href{javascript:alert(1)}{x}', '\\href'],
  ['\\url{https://x.test}', '\\url'],
  ['\\require{html}', '\\require'],
  ['\\class{a}{x}', '\\class'],
  ['\\style{color:red}{x}', '\\style'],
  ['\\unicode{x41}', '\\unicode'],
  ['\\def\\a{b}', '\\def'],
  ['\\newcommand{\\a}{b}', '\\newcommand'],
  ['\\let\\a=b', '\\let'],
  ['\\input{x}', '\\input'],
  ['\\write18{ls}', '\\write'],
  ['\\ref{a}', '\\ref'],
  ['\\eqref{a}', '\\eqref'],
]

describe('Math security allowlist', () => {
  it('rejects all hostile control sequences and names the offending macro', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    for (const [latex, macro] of HOSTILE) {
      const res = await renderMath(latex, opts)
      expect(res.ok, `expected ${latex} to fail`).toBe(false)
      if (!res.ok) {
        expect(res.error).toContain(macro)
        expect(res.error).not.toMatch(/<a |href=|xlink|javascript:/i)
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    for (const mod of getAsyncLoadedModules()) {
      expect(
        mod.startsWith('@mathjax/mathjax-newcm-font/js/svg/dynamic/'),
      ).toBe(true)
    }
    fetchSpy.mockRestore()
  })

  it('rejects \\mmlToken (link, image and style holes) but keeps \\bmod, \\pmod and \\mod', async () => {
    for (const latex of [
      '\\mmlToken{mi}[href="javascript:alert(1)"]{x}',
      '\\mmlToken{mglyph}[src="http://evil"]{x}',
      '\\mmlToken{mi}[style="position:fixed"]{x}',
    ]) {
      const res = await renderMath(latex, opts)
      expect(res.ok, `expected ${latex} to fail`).toBe(false)
    }
    for (const latex of ['a \\bmod b', 'a \\equiv b \\pmod n', 'a \\mod b']) {
      const res = await renderMath(latex, opts)
      expect(res.ok, `${latex} should render`).toBe(true)
      if (res.ok) expect(res.svg).not.toMatch(/<a |href|<image/i)
    }
  })

  it('bounds macro bombs and 100-deep nested braces within 1s', async () => {
    const t0 = performance.now()
    const bomb = await renderMath(
      '\\expandafter\\expandafter\\expandafter\\a',
      opts,
    )
    expect(bomb.ok).toBe(false)
    const deep = await renderMath(`${'{'.repeat(100)}x${'}'.repeat(100)}`, opts)
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(1000)
    if (deep.ok) {
      expect(deep.svg.length).toBeLessThan(50_000)
      expect(deep.svg).not.toMatch(/<a |href|xlink|javascript:/i)
    }
  })
})

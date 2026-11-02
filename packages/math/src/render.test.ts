import { describe, expect, it } from 'vitest'
import {
  getAsyncLoadedModules,
  getConversionCount,
  isMathJaxLoaded,
  peekMath,
  renderMath,
} from './index'

const loadedAtImport = isMathJaxLoaded()
const opts = { display: true, color: '#1e1e1e' }

describe('renderMath', () => {
  it('does not load MathJax on package import or pre-MathJax guards before the first valid renderMath call', async () => {
    expect(loadedAtImport).toBe(false)
    expect(peekMath('x', opts)).toBeUndefined()
    expect(isMathJaxLoaded()).toBe(false)
    await renderMath('مرحبا', opts)
    await renderMath('x'.repeat(4001), opts)
    expect(isMathJaxLoaded()).toBe(false)
  })

  it('renders standard TeX, AMS, boldsymbol, cancel, mathtools, and mhchem equations', async () => {
    const cases = [
      '\\frac{a+b}{c+d}',
      '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}',
      '\\begin{aligned}x+y&=10\\\\x-y&=2\\end{aligned}',
      '\\mathbb{R}',
      '\\ce{2H2 + O2 -> 2H2O}',
      '\\cancel{x}',
      'f(x)\\coloneqq x^2',
      '\\boldsymbol{\\alpha}',
    ]
    for (const latex of cases) {
      const res = await renderMath(latex, opts)
      expect(res.ok, `${latex} failed: ${!res.ok ? res.error : ''}`).toBe(true)
      if (res.ok) {
        expect(res.width).toBeGreaterThan(0)
        expect(res.height).toBeGreaterThan(0)
        expect(res.depth).toBeGreaterThanOrEqual(0)
        expect(res.svg).toContain('<svg')
        expect(res.svg).toContain('#1e1e1e')
      }
    }
    expect(isMathJaxLoaded()).toBe(true)
    expect(
      getAsyncLoadedModules().every((m) =>
        m.startsWith('@mathjax/mathjax-newcm-font/js/svg/dynamic/'),
      ),
    ).toBe(true)
  })

  it('returns MathJax error messages for unbalanced braces and undefined macros', async () => {
    const brace = await renderMath('\\frac{1}{2', opts)
    expect(brace.ok).toBe(false)
    if (!brace.ok) expect(brace.error.length).toBeGreaterThan(0)

    const undef = await renderMath('\\notamacro', opts)
    expect(undef.ok).toBe(false)
    if (!undef.ok) expect(undef.error).toContain('\\notamacro')
  })

  it('rejects inputs over the 4,000 character limit', async () => {
    const long = `${'x+'.repeat(2000)}x`
    expect(long.length).toBe(4001)
    const res = await renderMath(long, opts)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('4,000')
  })

  it('memoises results, deduplicates concurrent calls, and populates peekMath', async () => {
    const latex = 'x^2 + y^2 = z^2'
    expect(peekMath(latex, opts)).toBeUndefined()
    const before = getConversionCount()
    const [r1, r2] = await Promise.all([
      renderMath(latex, opts),
      renderMath(latex, opts),
    ])
    expect(getConversionCount() - before).toBe(1)
    expect(r1).toBe(r2)
    expect(peekMath(latex, opts)).toBe(r1)
  })

  it('rejects colours that could break out of the SVG markup', async () => {
    for (const color of ['red"/><script>', '#fff;x', 'url(#a)', '']) {
      const res = await renderMath('x', { display: true, color })
      expect(res.ok, `expected colour ${color} to fail`).toBe(false)
    }
    for (const color of ['#abc', '#aabbccdd', 'rgb(1, 2, 3)', 'tomato']) {
      const res = await renderMath('x', { display: true, color })
      expect(res.ok, `expected colour ${color} to pass`).toBe(true)
    }
  })

  it('turns text the font cannot draw into an error instead of a blank box', async () => {
    for (const latex of ['\\text{你好}', 'x + \\text{😀}']) {
      const res = await renderMath(latex, opts)
      expect(res.ok, latex).toBe(false)
      if (!res.ok) expect(res.error).toContain('Unsupported characters')
    }
  })

  it('rejects formulas far larger than any real equation', async () => {
    const res = await renderMath('\\rule{500em}{500em}', opts)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('too large')
  })

  it('produces different SVGs with identical metrics for different colours', async () => {
    const latex = '\\sqrt{x + 1}'
    const black = await renderMath(latex, { display: true, color: '#000000' })
    const red = await renderMath(latex, { display: true, color: '#ff0000' })
    expect(black.ok && red.ok).toBe(true)
    if (black.ok && red.ok) {
      expect(black.svg).not.toBe(red.svg)
      expect(black.svg).toContain('#000000')
      expect(red.svg).toContain('#ff0000')
      expect(black.width).toBe(red.width)
      expect(black.height).toBe(red.height)
      expect(black.depth).toBe(red.depth)
    }
  })
})

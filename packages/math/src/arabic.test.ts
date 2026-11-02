import { describe, expect, it } from 'vitest'
import { ARABIC_ERROR, containsArabic, renderMath } from './index'

const opts = { display: true, color: '#000' }

describe('Arabic guard', () => {
  it('detects Arabic characters and Arabic-Indic digits', () => {
    expect(containsArabic('\\text{مرحبا}')).toBe(true)
    expect(containsArabic('مرحبا')).toBe(true)
    expect(containsArabic('x = ٣')).toBe(true)
    expect(containsArabic('\\text{area}')).toBe(false)
    expect(containsArabic('\\ce{H2O}')).toBe(false)
  })

  it('rejects Arabic inside \\text{}, bare Arabic, and Arabic-Indic digits with the P2 message', async () => {
    for (const input of [
      '\\text{مرحبا}',
      'مرحبا',
      'x = ٣',
      '\\text{مساحة الدائرة} = \\pi r^2',
      '\\text{السرعة}=\\frac{\\text{المسافة}}{\\text{الزمن}}',
    ]) {
      const res = await renderMath(input, opts)
      expect(res).toEqual({ ok: false, error: ARABIC_ERROR })
    }
  })

  it('allows Latin \\text{} and chemistry equations', async () => {
    const area = await renderMath('\\text{area} = \\pi r^2', opts)
    expect(area.ok).toBe(true)
    const chem = await renderMath('\\ce{H2O}', opts)
    expect(chem.ok).toBe(true)
  })
})

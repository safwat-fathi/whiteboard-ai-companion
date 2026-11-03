// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyInsert,
  createMathSymbolToolbar,
  findPlaceholderSlots,
  findPlaceholderTarget,
  getSymbolsOpen,
  isInsideMathDelimiter,
  MATH_SYMBOLS,
} from './MathSymbols'

describe('MathSymbols', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  function getSymbol(id: string) {
    const sym = MATH_SYMBOLS.find((s) => s.id === id)
    if (!sym) throw new Error(`Symbol ${id} not found`)
    return sym
  }

  it('contains exactly 24 symbols', () => {
    expect(MATH_SYMBOLS.length).toBe(24)
  })

  describe('context-aware symbols', () => {
    it('x^2 inserts x^2 when standalone, ^2 when preceded by a variable or number, and wraps selection', () => {
      const sym = getSymbol('x_squared')

      // Standalone
      expect(sym.insert({ before: '', selected: '', after: '' })).toEqual({
        text: 'x^2',
        cursorOffset: 3,
      })

      // Preceded by variable
      expect(sym.insert({ before: 'y', selected: '', after: '' })).toEqual({
        text: '^2',
        cursorOffset: 2,
      })

      // Preceded by number
      expect(sym.insert({ before: '3', selected: '', after: '' })).toEqual({
        text: '^2',
        cursorOffset: 2,
      })

      // Preceded by closing paren
      expect(sym.insert({ before: '(a+b)', selected: '', after: '' })).toEqual({
        text: '^2',
        cursorOffset: 2,
      })

      // Selection wrapping: a multi-char selection is parenthesised
      expect(sym.insert({ before: '', selected: 'z+1', after: '' })).toEqual({
        text: '(z+1)^{2}',
        cursorOffset: 9,
      })
      expect(sym.insert({ before: '', selected: 'z', after: '' }).text).toBe(
        'z^{2}',
      )

      // A trailing operator command is not a base
      expect(
        sym.insert({ before: 'a \\le ', selected: '', after: '' }).text,
      ).toBe('x^2')
    })

    it('x^□ inserts x^{} when standalone, ^{} when preceded by variable, and wraps selection', () => {
      const sym = getSymbol('x_power')

      // Standalone
      expect(sym.insert({ before: '', selected: '', after: '' })).toEqual({
        text: 'x^{}',
        cursorOffset: 3,
      })

      // Preceded by variable
      expect(sym.insert({ before: 'y', selected: '', after: '' })).toEqual({
        text: '^{}',
        cursorOffset: 2,
      })

      // Selection wrapping
      expect(sym.insert({ before: '', selected: 'w', after: '' })).toEqual({
        text: 'w^{}',
        cursorOffset: 3,
      })
    })

    it('frac inserts \\frac{}{} and wraps selection into numerator', () => {
      const sym = getSymbol('frac')
      expect(sym.insert({ before: '', selected: '', after: '' })).toEqual({
        text: '\\frac{}{}',
        cursorOffset: 6, // inside numerator
      })

      expect(sym.insert({ before: '', selected: 'num', after: '' })).toEqual({
        text: '\\frac{num}{}',
        cursorOffset: 11, // inside denominator
      })
    })

    it('sqrt inserts \\sqrt{} and wraps selection', () => {
      const sym = getSymbol('sqrt')
      expect(sym.insert({ before: '', selected: '', after: '' })).toEqual({
        text: '\\sqrt{}',
        cursorOffset: 6,
      })

      expect(sym.insert({ before: '', selected: 'x+1', after: '' })).toEqual({
        text: '\\sqrt{x+1}',
        cursorOffset: 10,
      })
    })

    it('nth_root inserts \\sqrt[]{} with cursor in root index', () => {
      const sym = getSymbol('nth_root')
      expect(sym.insert({ before: '', selected: '', after: '' })).toEqual({
        text: '\\sqrt[]{}',
        cursorOffset: 6,
      })

      expect(sym.insert({ before: '', selected: '27', after: '' })).toEqual({
        text: '\\sqrt[]{27}',
        cursorOffset: 6,
      })
    })

    it('matrix inserts 2x2 pmatrix with cursor at first cell', () => {
      const sym = getSymbol('matrix')
      const res = sym.insert({ before: '', selected: '', after: '' })
      expect(res.text).toBe('\\begin{pmatrix}  & \\\\  &  \\end{pmatrix}')
      expect(res.cursorOffset).toBe(16)
    })
  })

  describe('findPlaceholderSlots and navigation', () => {
    it('finds slots in fraction \\frac{a}{b}', () => {
      const text = '\\frac{a}{b}'
      const slots = findPlaceholderSlots(text)
      expect(slots).toEqual([
        { start: 6, end: 7 }, // 'a'
        { start: 9, end: 10 }, // 'b'
      ])
    })

    it('finds slots in \\sqrt[n]{x}', () => {
      const text = '\\sqrt[n]{x}'
      const slots = findPlaceholderSlots(text)
      expect(slots).toEqual([
        { start: 6, end: 7 }, // 'n'
        { start: 9, end: 10 }, // 'x'
      ])
    })

    it('finds slots in empty braces \\frac{}{}', () => {
      const text = '\\frac{}{}'
      const slots = findPlaceholderSlots(text)
      expect(slots).toEqual([
        { start: 6, end: 6 },
        { start: 8, end: 8 },
      ])
    })

    it('finds slots in matrix', () => {
      const text = '\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}'
      const slots = findPlaceholderSlots(text)
      expect(slots.length).toBe(4)
      const s0 = slots[0]
      const s1 = slots[1]
      const s2 = slots[2]
      const s3 = slots[3]
      if (!s0 || !s1 || !s2 || !s3) throw new Error('expected 4 slots')
      expect(text.slice(s0.start, s0.end)).toBe('1')
      expect(text.slice(s1.start, s1.end)).toBe('2')
      expect(text.slice(s2.start, s2.end)).toBe('3')
      expect(text.slice(s3.start, s3.end)).toBe('4')
    })

    it('findPlaceholderTarget navigates forward and stops at the last slot', () => {
      const text = '\\frac{a}{b}'
      // At position 0, next slot is slot 1 ('a')
      const target1 = findPlaceholderTarget(text, 0, 0, false)
      expect(target1).toEqual({ start: 6, end: 7 })

      // At position 6, next slot is slot 2 ('b')
      const target2 = findPlaceholderTarget(text, 6, 7, false)
      expect(target2).toEqual({ start: 9, end: 10 })

      // Past the last slot: null, so Tab moves focus on (no keyboard trap)
      expect(findPlaceholderTarget(text, 9, 10, false)).toBeNull()
      expect(findPlaceholderTarget('no slots here', 0, 0, false)).toBeNull()
    })

    it('findPlaceholderTarget navigates backward and stops at the first slot', () => {
      const text = '\\frac{a}{b}'
      // At position 9, prev slot is slot 1 ('a')
      const targetPrev = findPlaceholderTarget(text, 9, 10, true)
      expect(targetPrev).toEqual({ start: 6, end: 7 })

      // Inside the first slot there is nothing before it
      expect(findPlaceholderTarget(text, 6, 7, true)).toBeNull()
      expect(findPlaceholderTarget(text, 7, 7, true)).toBeNull()
    })
  })

  describe('every symbol', () => {
    it('puts the cursor in the first empty slot of a template', () => {
      for (const sym of MATH_SYMBOLS) {
        const { text, cursorOffset } = sym.insert({
          before: '',
          selected: '',
          after: '',
        })
        const first = findPlaceholderSlots(text)[0]
        if (first && first.start === first.end && !text.includes('pmatrix'))
          expect(cursorOffset, sym.id).toBe(first.start)
        expect(cursorOffset, sym.id).toBeLessThanOrEqual(text.length)
      }
    })

    it('never deletes the selection', () => {
      for (const sym of MATH_SYMBOLS) {
        const { text, cursor } = applyInsert(sym, 'a+b', 0, 3)
        expect(text, sym.id).toContain('a+b')
        expect(cursor, sym.id).toBeLessThanOrEqual(text.length)
      }
      expect(applyInsert(getSymbol('pi'), 'a+b', 0, 3).text).toBe('a+b\\pi ')
    })
  })

  describe('applyInsert in chat prose', () => {
    it('wraps in $…$ and ignores the prose before it', () => {
      const v = 'Solve the equation '
      expect(
        applyInsert(getSymbol('x_squared'), v, v.length, v.length, true),
      ).toEqual({ text: '$x^2$', cursor: 4 })
    })

    it('does not glue onto a closed $x$ (would read as $$)', () => {
      const v = '$x$'
      const r = applyInsert(getSymbol('pi'), v, 3, 3, true)
      expect(v + r.text).toBe('$x$ $\\pi $')
    })
  })

  describe('createMathSymbolToolbar and localStorage', () => {
    it('creates toolbar with 24 buttons and toggle chevron', () => {
      const onInsert = vi.fn()
      const toolbar = createMathSymbolToolbar({ onInsert })

      expect(
        toolbar.root.querySelector('[data-testid="math-symbol-grid"]'),
      ).not.toBeNull()
      expect(toolbar.toggleBtn).not.toBeNull()

      const btns = toolbar.root.querySelectorAll('[data-testid^="math-sym-"]')
      expect(btns.length).toBe(24)

      // Clicking a symbol invokes onInsert
      const x2Btn = toolbar.root.querySelector(
        '[data-testid="math-sym-x_squared"]',
      ) as HTMLButtonElement
      x2Btn.click()
      expect(onInsert).toHaveBeenCalledWith(MATH_SYMBOLS[0])
    })

    it('persists open/closed state to localStorage', () => {
      expect(getSymbolsOpen()).toBe(true)

      const toolbar = createMathSymbolToolbar({ onInsert: vi.fn() })
      expect(toolbar.isOpen()).toBe(true)

      // Toggle closed
      toolbar.toggleBtn.click()
      expect(toolbar.isOpen()).toBe(false)
      expect(getSymbolsOpen()).toBe(false)

      // Create new toolbar - remembers closed
      const toolbar2 = createMathSymbolToolbar({ onInsert: vi.fn() })
      expect(toolbar2.isOpen()).toBe(false)

      // Toggle open
      toolbar2.toggleBtn.click()
      expect(toolbar2.isOpen()).toBe(true)
      expect(getSymbolsOpen()).toBe(true)
    })
  })

  describe('isInsideMathDelimiter', () => {
    it('detects inline math and block math delimiters', () => {
      expect(isInsideMathDelimiter('hello world', 5)).toBe(false)
      expect(isInsideMathDelimiter('hello $x', 8)).toBe(true)
      expect(isInsideMathDelimiter('hello $x$ world', 12)).toBe(false)
      expect(isInsideMathDelimiter('solve $$x^2', 11)).toBe(true)
      expect(isInsideMathDelimiter('solve $$x^2$$ done', 16)).toBe(false)
      expect(isInsideMathDelimiter('cost is \\$5 for it', 12)).toBe(false)
    })
  })
})

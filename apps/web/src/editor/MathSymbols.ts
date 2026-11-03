export type MathSymbolContext = {
  before: string
  selected: string
  after: string
}

export type MathSymbolInsertResult = {
  text: string
  cursorOffset: number
}

export type MathSymbolDef = {
  id: string
  label: string
  svg: string
  insert: (ctx: MathSymbolContext) => MathSymbolInsertResult
}

const STORAGE_KEY = 'whiteboard:math-symbols-open'

export function getSymbolsOpen(): boolean {
  try {
    const val = localStorage.getItem(STORAGE_KEY)
    return val === null ? true : val === 'true'
  } catch {
    return true
  }
}

export function setSymbolsOpen(open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(open))
  } catch {}
}

function hasExpressionBefore(before: string): boolean {
  const t = before.trimEnd()
  return /[a-zA-Z0-9)\]}]$/.test(t) && !/\\(le|ge|cdot|div|to)$/.test(t)
}

// "z+1" must become "(z+1)^…", or the exponent binds to the last character only.
const base = (selected: string): string =>
  selected.length > 1 ? `(${selected})` : selected

export const MATH_SYMBOLS: readonly MathSymbolDef[] = [
  // --- Row 1 ---
  {
    id: 'x_squared',
    label: 'x squared',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><text x="7" y="16" font-family="'Times New Roman', Cambria, serif" font-size="14" font-style="italic" fill="currentColor">x</text><text x="16" y="9" font-family="'Times New Roman', Cambria, serif" font-size="10" fill="currentColor">2</text></svg>`,
    insert: ({ before, selected }) => {
      if (selected) {
        const text = `${base(selected)}^{2}`
        return { text, cursorOffset: text.length }
      }
      if (hasExpressionBefore(before)) {
        return { text: '^2', cursorOffset: 2 }
      }
      return { text: 'x^2', cursorOffset: 3 }
    },
  },
  {
    id: 'x_power',
    label: 'power',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><text x="6" y="16" font-family="'Times New Roman', Cambria, serif" font-size="14" font-style="italic" fill="currentColor">x</text><rect x="15" y="3" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="0.9" stroke-dasharray="1.5,1.2" opacity="0.6"/></svg>`,
    insert: ({ before, selected }) => {
      if (selected) {
        const b = base(selected)
        return { text: `${b}^{}`, cursorOffset: b.length + 2 }
      }
      if (hasExpressionBefore(before)) {
        return { text: '^{}', cursorOffset: 2 }
      }
      return { text: 'x^{}', cursorOffset: 3 }
    },
  },
  {
    id: 'log_base',
    label: 'log base',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><text x="3" y="14" font-family="'Times New Roman', Cambria, serif" font-size="12" fill="currentColor">log</text><rect x="19" y="11" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="0.8" stroke-dasharray="1.5,1.2" opacity="0.6"/></svg>`,
    insert: ({ selected }) => {
      if (selected) {
        return {
          text: `\\log_{${selected}}`,
          cursorOffset: 6 + selected.length + 1,
        }
      }
      return { text: '\\log_{}', cursorOffset: 6 }
    },
  },
  {
    id: 'sqrt',
    label: 'square root',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><path d="M 4 12 L 6 12 L 8.5 18 L 12 5 L 24 5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><rect x="14" y="8" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="0.9" stroke-dasharray="1.5,1.2" opacity="0.6"/></svg>`,
    insert: ({ selected }) => {
      if (selected) {
        const text = `\\sqrt{${selected}}`
        return { text, cursorOffset: text.length }
      }
      return { text: '\\sqrt{}', cursorOffset: 6 }
    },
  },
  {
    id: 'nth_root',
    label: 'n-th root',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><path d="M 3 13 L 5 13 L 7.5 19 L 11 6 L 25 6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><rect x="3" y="4" width="5" height="5" rx="0.8" fill="none" stroke="currentColor" stroke-width="0.8" stroke-dasharray="1.2,1" opacity="0.6"/><rect x="13.5" y="9" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="0.9" stroke-dasharray="1.5,1.2" opacity="0.6"/></svg>`,
    insert: ({ selected }) => {
      if (selected) {
        return { text: `\\sqrt[]{${selected}}`, cursorOffset: 6 }
      }
      return { text: '\\sqrt[]{}', cursorOffset: 6 }
    },
  },
  {
    id: 'le',
    label: 'less than or equal',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><path d="M 19 6 L 9 11 L 19 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><line x1="9" y1="19" x2="19" y2="19" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
    insert: () => ({ text: '\\le ', cursorOffset: 4 }),
  },
  {
    id: 'ge',
    label: 'greater than or equal',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><path d="M 9 6 L 19 11 L 9 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><line x1="9" y1="19" x2="19" y2="19" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
    insert: () => ({ text: '\\ge ', cursorOffset: 4 }),
  },
  {
    id: 'frac',
    label: 'fraction',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><line x1="5" y1="11" x2="23" y2="11" stroke="currentColor" stroke-width="1.2"/><rect x="10.5" y="2" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="0.8" stroke-dasharray="1.5,1.2" opacity="0.6"/><rect x="10.5" y="13" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="0.8" stroke-dasharray="1.5,1.2" opacity="0.6"/></svg>`,
    insert: ({ selected }) => {
      if (selected) {
        return {
          text: `\\frac{${selected}}{}`,
          cursorOffset: 6 + selected.length + 2,
        }
      }
      return { text: '\\frac{}{}', cursorOffset: 6 }
    },
  },
  {
    id: 'cdot',
    label: 'multiplication dot',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><circle cx="14" cy="11" r="2.2" fill="currentColor"/></svg>`,
    insert: () => ({ text: '\\cdot ', cursorOffset: 6 }),
  },
  {
    id: 'div',
    label: 'division',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><line x1="6" y1="11" x2="22" y2="11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="14" cy="6" r="1.6" fill="currentColor"/><circle cx="14" cy="16" r="1.6" fill="currentColor"/></svg>`,
    insert: () => ({ text: '\\div ', cursorOffset: 5 }),
  },
  {
    id: 'degree',
    label: 'degree',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><text x="7" y="16" font-family="'Times New Roman', Cambria, serif" font-size="14" font-style="italic" fill="currentColor">x</text><circle cx="18" cy="6" r="2" fill="none" stroke="currentColor" stroke-width="1"/></svg>`,
    insert: ({ before, selected }) => {
      if (selected) {
        const text = `${base(selected)}^{\\circ}`
        return { text, cursorOffset: text.length }
      }
      if (hasExpressionBefore(before)) {
        return { text: '^{\\circ}', cursorOffset: 8 }
      }
      return { text: 'x^{\\circ}', cursorOffset: 9 }
    },
  },
  {
    id: 'pi',
    label: 'pi',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><text x="9" y="16" font-family="'Times New Roman', Cambria, serif" font-size="15" font-style="italic" fill="currentColor">π</text></svg>`,
    insert: () => ({ text: '\\pi ', cursorOffset: 4 }),
  },

  // --- Row 2 ---
  {
    id: 'prime',
    label: 'derivative prime',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><text x="4" y="15" font-family="'Times New Roman', Cambria, serif" font-size="15" fill="currentColor">(</text><rect x="9.5" y="6" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="0.8" stroke-dasharray="1.5,1.2" opacity="0.6"/><text x="17.5" y="15" font-family="'Times New Roman', Cambria, serif" font-size="15" fill="currentColor">)</text><text x="21.5" y="9" font-family="'Times New Roman', Cambria, serif" font-size="12" fill="currentColor">′</text></svg>`,
    insert: ({ selected }) => {
      if (selected) {
        const text = `(${selected})'`
        return { text, cursorOffset: text.length }
      }
      return { text: "()'", cursorOffset: 1 }
    },
  },
  {
    id: 'd_dx',
    label: 'd/dx derivative',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><line x1="4" y1="11" x2="24" y2="11" stroke="currentColor" stroke-width="1.1"/><text x="11.5" y="9" font-family="'Times New Roman', Cambria, serif" font-size="10" font-style="italic" fill="currentColor">d</text><text x="8" y="19" font-family="'Times New Roman', Cambria, serif" font-size="9" font-style="italic" fill="currentColor">dx</text></svg>`,
    insert: () => ({ text: '\\frac{d}{dx} ', cursorOffset: 12 }),
  },
  {
    id: 'partial_dx',
    label: 'partial derivative',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><line x1="4" y1="11" x2="24" y2="11" stroke="currentColor" stroke-width="1.1"/><text x="11" y="9" font-family="'Times New Roman', Cambria, serif" font-size="10" fill="currentColor">∂</text><text x="7.5" y="19" font-family="'Times New Roman', Cambria, serif" font-size="9" fill="currentColor">∂<tspan font-style="italic">x</tspan></text></svg>`,
    insert: () => ({
      text: '\\frac{\\partial}{\\partial x} ',
      cursorOffset: 27, // after the closing brace, like d/dx
    }),
  },
  {
    id: 'integral',
    label: 'integral',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><text x="10" y="17" font-family="'Times New Roman', Cambria, serif" font-size="17" fill="currentColor">∫</text></svg>`,
    insert: () => ({ text: '\\int ', cursorOffset: 5 }),
  },
  {
    id: 'definite_integral',
    label: 'definite integral',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><text x="6" y="16" font-family="'Times New Roman', Cambria, serif" font-size="16" fill="currentColor">∫</text><rect x="15" y="2" width="6" height="6" rx="0.8" fill="none" stroke="currentColor" stroke-width="0.8" stroke-dasharray="1.2,1" opacity="0.6"/><rect x="14" y="13" width="6" height="6" rx="0.8" fill="none" stroke="currentColor" stroke-width="0.8" stroke-dasharray="1.2,1" opacity="0.6"/></svg>`,
    insert: ({ selected }) => {
      if (selected) {
        return { text: `\\int_{}^{${selected}}`, cursorOffset: 6 }
      }
      return { text: '\\int_{}^{}', cursorOffset: 6 }
    },
  },
  {
    id: 'limit',
    label: 'limit',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><text x="5" y="15" font-family="'Times New Roman', Cambria, serif" font-size="12" fill="currentColor">lim</text></svg>`,
    insert: () => ({ text: '\\lim_{}', cursorOffset: 6 }),
  },
  {
    id: 'sum',
    label: 'summation',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><text x="8" y="17" font-family="'Times New Roman', Cambria, serif" font-size="16" fill="currentColor">∑</text></svg>`,
    insert: () => ({ text: '\\sum_{}^{}', cursorOffset: 6 }),
  },
  {
    id: 'infinity',
    label: 'infinity',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><text x="7" y="15" font-family="'Times New Roman', Cambria, serif" font-size="15" fill="currentColor">∞</text></svg>`,
    insert: () => ({ text: '\\infty ', cursorOffset: 7 }),
  },
  {
    id: 'theta',
    label: 'theta',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><text x="9" y="16" font-family="'Times New Roman', Cambria, serif" font-size="14" font-style="italic" fill="currentColor">θ</text></svg>`,
    insert: () => ({ text: '\\theta ', cursorOffset: 7 }),
  },
  {
    id: 'f_circ_g',
    label: 'function composition (f ∘ g)',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><text x="1.5" y="14" font-family="'Times New Roman', Cambria, serif" font-size="10.5" fill="currentColor">(<tspan font-style="italic">f</tspan>∘<tspan font-style="italic">g</tspan>)</text></svg>`,
    insert: () => ({ text: '(f \\circ g)', cursorOffset: 11 }),
  },
  {
    id: 'f_x',
    label: 'f(x)',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><text x="4.5" y="15" font-family="'Times New Roman', Cambria, serif" font-size="12" fill="currentColor"><tspan font-style="italic">f</tspan>(<tspan font-style="italic">x</tspan>)</text></svg>`,
    insert: ({ selected }) => {
      if (selected) {
        const text = `f(${selected})`
        return { text, cursorOffset: text.length }
      }
      return { text: 'f(x)', cursorOffset: 4 }
    },
  },
  {
    id: 'matrix',
    label: 'matrix',
    svg: `<svg viewBox="0 0 28 22" width="28" height="22" fill="none"><path d="M 6 4 C 4 7, 4 15, 6 18" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M 22 4 C 24 7, 24 15, 22 18" fill="none" stroke="currentColor" stroke-width="1.1"/><rect x="7.5" y="5" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="0.7" stroke-dasharray="1,0.8" opacity="0.6"/><rect x="16" y="5" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="0.7" stroke-dasharray="1,0.8" opacity="0.6"/><rect x="7.5" y="12.5" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="0.7" stroke-dasharray="1,0.8" opacity="0.6"/><rect x="16" y="12.5" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="0.7" stroke-dasharray="1,0.8" opacity="0.6"/><circle cx="14" cy="7.2" r="0.6" fill="currentColor" opacity="0.5"/><circle cx="9.7" cy="11" r="0.6" fill="currentColor" opacity="0.5"/><circle cx="18.2" cy="11" r="0.6" fill="currentColor" opacity="0.5"/><circle cx="14" cy="14.7" r="0.6" fill="currentColor" opacity="0.5"/></svg>`,
    insert: () => ({
      text: '\\begin{pmatrix}  & \\\\  &  \\end{pmatrix}',
      cursorOffset: 16, // right after '\begin{pmatrix} '
    }),
  },
]

export type PlaceholderSlot = {
  start: number
  end: number
}

/**
 * Finds template argument slots ({}, [], or matrix cells) in a LaTeX string.
 */
export function findPlaceholderSlots(text: string): PlaceholderSlot[] {
  const slots: PlaceholderSlot[] = []

  // 1. Matrix cells: inside \begin{pmatrix} ... \end{pmatrix}
  const matrixRegex = /\\begin\{pmatrix\}([\s\S]*?)\\end\{pmatrix\}/g
  for (const match of text.matchAll(matrixRegex)) {
    const startOfBody = (match.index ?? 0) + '\\begin{pmatrix}'.length
    const body = match[1] ?? ''
    const rowSegments = body.split('\\\\')
    let segOffset = 0
    for (const row of rowSegments) {
      const cells = row.split('&')
      let cellOffset = 0
      for (const cell of cells) {
        const trimmedStart = cell.search(/\S/)
        const s =
          startOfBody +
          segOffset +
          cellOffset +
          (trimmedStart === -1 ? 1 : trimmedStart)
        const trimmedEnd = cell.trimEnd().length
        const e =
          startOfBody +
          segOffset +
          cellOffset +
          (trimmedStart === -1 ? 1 : trimmedEnd)
        slots.push({ start: s, end: Math.max(s, e) })
        cellOffset += cell.length + 1 // +1 for '&'
      }
      segOffset += row.length + 2 // +2 for '\\'
    }
  }

  // 2. Leaf braces '{}' and Brackets '[]' for commands (skipping \begin{env} and \end{env})
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '{') {
      const prefix = text.slice(0, i)
      if (prefix.endsWith('\\begin') || prefix.endsWith('\\end')) {
        i++
        continue
      }
      let depth = 1
      let j = i + 1
      let hasChildBrace = false
      while (j < text.length && depth > 0) {
        if (text[j] === '{' && text[j - 1] !== '\\') {
          depth++
          hasChildBrace = true
        } else if (text[j] === '}' && text[j - 1] !== '\\') {
          depth--
        }
        j++
      }
      if (depth === 0 && !hasChildBrace) {
        slots.push({ start: i + 1, end: j - 1 })
      }
      i++
      continue
    } else if (
      ch === '[' &&
      (text.slice(0, i).endsWith('\\sqrt') ||
        text.slice(0, i).endsWith('\\sqrt '))
    ) {
      let depth = 1
      let j = i + 1
      while (j < text.length && depth > 0) {
        if (text[j] === '[' && text[j - 1] !== '\\') depth++
        else if (text[j] === ']' && text[j - 1] !== '\\') depth--
        j++
      }
      if (depth === 0) {
        slots.push({ start: i + 1, end: j - 1 })
      }
      i = j
      continue
    }
    i++
  }

  // Sort slots by start position
  slots.sort((a, b) => a.start - b.start)
  return slots
}

/**
 * Finds the next or previous placeholder slot to jump to, or null past the
 * last/first one so Tab/Shift+Tab fall through to normal focus movement.
 */
export function findPlaceholderTarget(
  text: string,
  cursorStart: number,
  _cursorEnd: number,
  reverse = false,
): PlaceholderSlot | null {
  const slots = findPlaceholderSlots(text)
  if (!reverse) return slots.find((s) => s.start > cursorStart) ?? null
  return [...slots].reverse().find((s) => s.end < cursorStart) ?? null
}

/**
 * What to put in place of [start, end) when `sym` is clicked, and where the
 * cursor goes inside it. `prose` = a chat message outside $…$: the symbol is
 * wrapped in $…$ and sees no preceding expression. A symbol that ignores the
 * selection keeps it instead of deleting it.
 */
export function applyInsert(
  sym: MathSymbolDef,
  value: string,
  start: number,
  end: number,
  prose = false,
): { text: string; cursor: number } {
  const before = value.slice(0, start)
  const selected = value.slice(start, end)
  const after = value.slice(end)
  const ctx = { before: prose ? '' : before, selected, after }
  const res = sym.insert(ctx)
  let text = res.text
  let cursor = res.cursorOffset
  if (selected && text === sym.insert({ ...ctx, selected: '' }).text) {
    text = selected + text
    cursor += selected.length
  }
  if (prose) {
    // "$x$" + "$…$" would read as a "$$" display delimiter
    const lead = before.endsWith('$') ? ' ' : ''
    text = `${lead}$${text}$`
    cursor += lead.length + 1
  }
  return { text, cursor }
}

/**
 * Replace [start, end) of a textarea. execCommand keeps the native undo stack
 * and fires `input`; jsdom has none, so fall back to setRangeText + `input`.
 */
export function replaceRange(
  ta: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
  cursor: number,
): void {
  if (
    ta.maxLength >= 0 &&
    ta.value.length - (end - start) + text.length > ta.maxLength
  )
    return
  ta.focus({ preventScroll: true })
  ta.setSelectionRange(start, end)
  if (!document.execCommand?.('insertText', false, text)) {
    ta.setRangeText(text, start, end, 'end')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }
  ta.setSelectionRange(start + cursor, start + cursor)
}

/**
 * Checks whether a given position in markdown text is inside LaTeX math delimiters ($...$ or $$...$$).
 */
export function isInsideMathDelimiter(text: string, pos: number): boolean {
  let inInline = false
  let inBlock = false
  let i = 0
  const max = Math.min(pos, text.length)
  while (i < max) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === '$') {
      if (text[i + 1] === '$') {
        inBlock = !inBlock
        i += 2
        continue
      }
      if (!inBlock) {
        inInline = !inInline
      }
      i++
      continue
    }
    i++
  }
  return inInline || inBlock
}

export type MathSymbolToolbarHandle = {
  readonly root: HTMLElement
  readonly toggleBtn: HTMLButtonElement
  isOpen(): boolean
  setOpen(open: boolean): void
}

/**
 * Builds the symbol toolbar element with 24 buttons and a collapse chevron.
 */
export function createMathSymbolToolbar(options: {
  onInsert: (symbol: MathSymbolDef) => void
}): MathSymbolToolbarHandle {
  let open = getSymbolsOpen()

  const root = document.createElement('div')
  root.setAttribute('data-testid', 'math-symbol-toolbar')
  root.style.cssText =
    'display:flex;flex-direction:column;align-items:center;width:100%;box-sizing:border-box;'

  const grid = document.createElement('div')
  grid.setAttribute('data-testid', 'math-symbol-grid')
  grid.style.cssText =
    'display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:3px;width:100%;padding:4px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;box-sizing:border-box;overflow:hidden;'

  for (const sym of MATH_SYMBOLS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.setAttribute('data-testid', `math-sym-${sym.id}`)
    btn.setAttribute('aria-label', sym.label)
    btn.title = sym.label
    btn.style.cssText =
      'display:flex;align-items:center;justify-content:center;height:28px;min-width:0;width:100%;padding:1px;background:#fff;border:1px solid #e2e8f0;border-radius:4px;color:#0f172a;cursor:pointer;user-select:none;box-sizing:border-box;transition:background 0.15s,border-color 0.15s;outline:none;'

    btn.innerHTML = sym.svg
    const svgEl = btn.querySelector('svg')
    if (svgEl) {
      svgEl.setAttribute('width', '100%')
      svgEl.setAttribute('height', '100%')
      svgEl.style.cssText =
        'max-width:24px;max-height:20px;display:block;pointer-events:none;margin:auto;'
    }

    btn.addEventListener('mouseenter', () => {
      btn.style.background = '#f1f5f9'
      btn.style.borderColor = '#94a3b8'
    })
    btn.addEventListener('mouseleave', () => {
      btn.style.background = '#fff'
      btn.style.borderColor = '#e2e8f0'
    })
    btn.addEventListener('mousedown', (e) => {
      // Prevent textarea from blurring
      e.preventDefault()
    })
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      options.onInsert(sym)
    })

    grid.append(btn)
  }

  const toggleBtn = document.createElement('button')
  toggleBtn.type = 'button'
  toggleBtn.setAttribute('data-testid', 'math-symbol-toggle')
  toggleBtn.setAttribute('aria-label', 'Toggle symbol keyboard')
  toggleBtn.style.cssText =
    'display:flex;align-items:center;justify-content:center;height:14px;padding:2px 16px;margin-top:3px;margin-bottom:1px;background:none;border:none;cursor:pointer;outline:none;'

  const chevronSvg = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'svg',
  )
  chevronSvg.setAttribute('viewBox', '0 0 16 10')
  chevronSvg.setAttribute('width', '16')
  chevronSvg.setAttribute('height', '10')
  chevronSvg.style.cssText = 'transition:transform 0.2s ease;'

  const chevronPath = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'path',
  )
  chevronPath.setAttribute('d', 'M 2 2 L 8 8 L 14 2')
  chevronPath.setAttribute('fill', 'none')
  chevronPath.setAttribute('stroke', '#f43f5e') // Pinkish red matching screenshot
  chevronPath.setAttribute('stroke-width', '2')
  chevronPath.setAttribute('stroke-linecap', 'round')
  chevronPath.setAttribute('stroke-linejoin', 'round')
  chevronSvg.append(chevronPath)
  toggleBtn.append(chevronSvg)

  const syncState = () => {
    grid.style.display = open ? 'grid' : 'none'
    toggleBtn.setAttribute('aria-expanded', String(open))
    // When open, chevron points down (rotates 0). When closed, points up/down
    chevronSvg.style.transform = open ? 'rotate(0deg)' : 'rotate(180deg)'
  }

  toggleBtn.addEventListener('mousedown', (e) => {
    e.preventDefault()
  })

  toggleBtn.addEventListener('click', (e) => {
    e.preventDefault()
    open = !open
    setSymbolsOpen(open)
    syncState()
  })

  syncState()
  root.append(grid, toggleBtn)

  return {
    root,
    toggleBtn,
    isOpen: () => open,
    setOpen: (v: boolean) => {
      open = v
      setSymbolsOpen(open)
      syncState()
    },
  }
}

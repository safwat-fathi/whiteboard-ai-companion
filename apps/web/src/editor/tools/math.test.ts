// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { fitMath, ordered } from '@whiteboard/core'
import { ARABIC_ERROR } from '@whiteboard/math'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '../editor'
import { createPersistence } from '../persist'
import { drag, ev, ptr, setup } from '../test-utils'

vi.mock('@whiteboard/core', async (orig) => ({
  ...(await orig<typeof import('@whiteboard/core')>()),
  render: vi.fn(),
}))

let ed: Editor
let done: () => void
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  ;({ ed, done } = setup())
})
afterEach(() => {
  done()
  vi.useRealTimers()
})

const els = () => ordered(ed.scene)
const box = () =>
  ed.host.querySelector('[data-testid="math-editor"]') as HTMLElement | null
const area = () =>
  ed.host.querySelector('textarea[aria-label="LaTeX"]') as HTMLTextAreaElement
const errEl = () =>
  ed.host.querySelector('[data-testid="math-error"]') as HTMLElement | null
const displayBtn = () =>
  ed.host.querySelector(
    'button[aria-label="Display mode"]',
  ) as HTMLButtonElement
const sizeInput = () =>
  ed.host.querySelector('input[aria-label="Font size"]') as HTMLInputElement

const type = (s: string) => {
  area().value = s
  area().dispatchEvent(new Event('input', { bubbles: true }))
}
const press = (k: string, init: KeyboardEventInit = {}) =>
  area().dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }),
  )
const cmdEnter = () => press('Enter', { metaKey: true })
const esc = () => press('Escape')
const start = (x = 10, y = 20) => {
  ed.setTool('math')
  drag(ed.tool, [[x, y]])
}

describe('math tool', () => {
  it('the key M selects the math tool, but typing m in a text editor does not switch tools', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }))
    expect(ed.tool.id).toBe('math')

    // Open text tool and type 'm' inside its textarea
    ed.setTool('text')
    drag(ed.tool, [[10, 20]])
    const ta = ed.host.querySelector('textarea') as HTMLTextAreaElement
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }))
    expect(ed.tool.id).toBe('text')
  })

  it('place, type \\frac{a}{b}, Cmd+Enter creates one element with w, h > 0 and one undo step', async () => {
    vi.useFakeTimers()
    const commit = vi.spyOn(ed, 'commit')
    start(15, 25)
    expect(box()).not.toBeNull()
    expect(area().dir).toBe('ltr')
    expect(area().getAttribute('spellcheck')).toBe('false')
    expect(area().getAttribute('autocapitalize')).toBe('off')

    type('\\frac{a}{b}')
    await vi.advanceTimersByTimeAsync(160)
    cmdEnter()

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[0].label).toBe('Add Math')
    const [m] = els()
    expect(m?.type).toBe('math')
    if (m?.type !== 'math') throw new Error('expected math')
    expect(m.data.latex).toBe('\\frac{a}{b}')
    expect(m.data.display).toBe(true)
    expect(m.data.size).toBe(28)
    expect([m.x, m.y]).toEqual([15, 25])
    expect(m.w).toBeGreaterThan(0)
    expect(m.h).toBeGreaterThan(0)
    const entry = ed.platform.math?.peek('\\frac{a}{b}', true, m.style.stroke)
    if (entry?.ok) {
      expect({ w: m.w, h: m.h }).toEqual(fitMath(entry, 28))
    }
    expect(box()).toBeNull()
    expect(ed.tool.id).toBe('select')

    ed.undoOnce()
    expect(els()).toEqual([])
  })

  it('Esc on new creates nothing; Esc on an existing element changes nothing', async () => {
    vi.useFakeTimers()
    const commit = vi.spyOn(ed, 'commit')
    start(10, 20)
    type('x^2')
    esc()
    expect(commit).not.toHaveBeenCalled()
    expect(els()).toEqual([])
    expect(box()).toBeNull()

    // Seed an existing math element
    start(10, 20)
    type('x^2')
    await vi.advanceTimersByTimeAsync(160)
    cmdEnter()
    const seeded = structuredClone(els()[0])
    if (!seeded) throw new Error('expected seeded element')

    commit.mockClear()
    ed.editMath(seeded.id)
    expect(ed.hidden).toBe(seeded.id)
    type('y^3 + z^4')
    displayBtn().click()
    sizeInput().value = '40'
    sizeInput().dispatchEvent(new Event('input', { bubbles: true }))
    esc()

    expect(commit).not.toHaveBeenCalled()
    expect(ed.hidden).toBeNull()
    expect(els()[0]).toEqual(seeded)
  })

  it('click-away commits and empty commit deletes (existing) or creates nothing (new)', async () => {
    vi.useFakeTimers()
    const commit = vi.spyOn(ed, 'commit')

    // Empty commit on new creates nothing
    start(10, 20)
    type('   ')
    ed.tool.onPointerDown(ev(300, 300))
    expect(commit).not.toHaveBeenCalled()
    expect(els()).toEqual([])

    // Click-away on non-empty new commits Add Math
    start(10, 20)
    type('x + 1')
    await vi.advanceTimersByTimeAsync(160)
    ed.tool.onPointerDown(ev(300, 300))
    expect(commit).toHaveBeenCalledTimes(1)
    expect(els()).toHaveLength(1)
    const id = els()[0]?.id as string

    // Double-click in select opens editMath; empty commit deletes existing
    ed.setTool('select')
    ptr('dblclick', 12, 22)
    expect(box()).not.toBeNull()
    type('')
    cmdEnter()
    expect(commit).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: 'Delete Math' }),
    )
    expect(els()).toEqual([])
    ed.undoOnce()
    expect(els().map((e) => e.id)).toEqual([id])
  })

  it('invalid \\frac{ commits with red source and the error text shown while typing', async () => {
    vi.useFakeTimers()
    start(10, 20)
    type('\\frac{')
    await vi.advanceTimersByTimeAsync(160)

    expect(errEl()?.textContent?.length).toBeGreaterThan(0)
    cmdEnter()

    const [m] = els()
    expect(m?.type).toBe('math')
    if (m?.type !== 'math') throw new Error('expected math')
    expect(m.data.latex).toBe('\\frac{')
    expect(m.w).toBeGreaterThan(0)
    expect(m.h).toBeGreaterThan(0)
    const entry = ed.platform.math?.peek('\\frac{', true, m.style.stroke)
    expect(entry?.ok).toBe(false)
  })

  it('Arabic input shows the P2 message and still commits as an error element', async () => {
    vi.useFakeTimers()
    start(10, 20)
    type('x + \\text{مرحبا}')
    await vi.advanceTimersByTimeAsync(160)

    expect(errEl()?.textContent).toBe(ARABIC_ERROR)
    cmdEnter()

    const [m] = els()
    expect(m?.type).toBe('math')
    if (m?.type !== 'math') throw new Error('expected math')
    expect(m.data.latex).toBe('x + \\text{مرحبا}')
    expect(m.w).toBeGreaterThan(0)
    expect(m.h).toBeGreaterThan(0)
  })

  it('preview debounce: <= 1 render per 150 ms window and stale results dropped', async () => {
    vi.useFakeTimers()
    const callbacks: Array<() => void> = []
    const entries = new Map<
      string,
      ReturnType<NonNullable<typeof ed.platform.math>['peek']>
    >()
    const requestSpy = vi.fn(
      (latex: string, display: boolean, color: string, cb: () => void) => {
        const k = `${display ? 1 : 0}|${color}|${latex}`
        callbacks.push(() => {
          entries.set(k, {
            ok: false,
            error: `error-for:${latex}`,
          })
          cb()
        })
      },
    )
    ed.platform.math = {
      peek: (latex, display, color) =>
        entries.get(`${display ? 1 : 0}|${color}|${latex}`),
      request: requestSpy,
    }

    start(10, 20)
    type('a')
    await vi.advanceTimersByTimeAsync(50)
    type('ab')
    await vi.advanceTimersByTimeAsync(50)
    type('abc')
    await vi.advanceTimersByTimeAsync(100)
    // Only 100 ms since 'abc', no request should have fired yet
    expect(requestSpy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50)
    // Exactly 1 request for the 3 rapid keystrokes in the 150 ms window
    expect(requestSpy).toHaveBeenCalledTimes(1)
    expect(requestSpy.mock.calls[0]?.[0]).toBe('abc')

    // Now type 'xyz' and let its request fire BEFORE 'abc' resolves
    type('xyz')
    await vi.advanceTimersByTimeAsync(150)
    expect(requestSpy).toHaveBeenCalledTimes(2)
    expect(requestSpy.mock.calls[1]?.[0]).toBe('xyz')

    // Resolve the second ('xyz') first, then the stale first ('abc')
    callbacks[1]?.()
    expect(errEl()?.textContent).toBe('error-for:xyz')
    callbacks[0]?.()
    // Stale result from 'abc' must be dropped and not overwrite 'xyz'
    expect(errEl()?.textContent).toBe('error-for:xyz')
  })

  it('refits the box to the equation when the renderer answers after the commit', async () => {
    start(10, 20)
    type('\\frac{a}{b}')
    cmdEnter() // before the 150 ms preview and before MathJax has loaded: sized from the source text
    const first = els()[0]
    if (first?.type !== 'math') throw new Error('expected math')

    await vi.waitFor(() => {
      const entry = ed.platform.math?.peek(
        '\\frac{a}{b}',
        true,
        first.style.stroke,
      )
      expect(entry?.ok).toBe(true)
      if (!entry?.ok) return
      const fit = fitMath(entry, 28)
      expect(els()[0]).toMatchObject({ w: fit.w, h: fit.h })
    })
    expect(els()[0]?.id).toBe(first.id)
  })

  it('resize keeps the aspect and size patch is atomic with w/h', async () => {
    vi.useFakeTimers()
    start(10, 20)
    type('\\frac{a}{b}')
    await vi.advanceTimersByTimeAsync(160)
    cmdEnter()

    const m = els()[0]
    if (m?.type !== 'math') throw new Error('expected math')
    const ratio = m.w / m.h
    const origSize = m.data.size

    const commit = vi.spyOn(ed, 'commit')
    ed.setTool('select')
    ed.selection.add(m.id)
    // Drag the SE handle to double the width
    drag(ed.tool, [
      [m.x + m.w, m.y + m.h],
      [m.x + m.w * 2, m.y + m.h * 2],
    ])

    expect(commit).toHaveBeenCalledTimes(1)
    const batch = commit.mock.calls[0]?.[0]
    expect(batch?.label).toBe('Resize')
    expect(batch?.ops).toHaveLength(1)
    const op = batch?.ops[0]
    expect(op?.op).toBe('patch')
    if (op?.op === 'patch') {
      expect(op.set).toHaveProperty('w')
      expect(op.set).toHaveProperty('h')
      expect(op.set).toHaveProperty('data.size')
    }

    const after = els()[0]
    if (after?.type !== 'math') throw new Error('expected math')
    expect(after.w / after.h).toBeCloseTo(ratio, 3)
    expect(after.data.size).toBe(Math.round(origSize * (after.w / m.w)))

    // One undo restores w, h and data.size together
    ed.undoOnce()
    const restored = els()[0]
    if (restored?.type !== 'math') throw new Error('expected math')
    expect([restored.w, restored.h, restored.data.size]).toEqual([
      m.w,
      m.h,
      origSize,
    ])
  })

  it('draft survives a simulated reload', async () => {
    const p = createPersistence(ed, 'local')
    await p.load()
    p.start()

    start(12, 34)
    type('E = mc^2')
    // Flush autosave while the math editor is still open (uncommitted)
    await p.flush()
    expect(ed.scene.els.size).toBe(0)

    // Simulated reload in a fresh editor without calling p.stop()
    const t2 = setup()
    const p2 = createPersistence(t2.ed, 'local')
    const loaded = await p2.load()
    expect(loaded.status).toBe('ok')
    const restored = ordered(t2.ed.scene)
    expect(restored).toHaveLength(1)
    expect(restored[0]?.type).toBe('math')
    if (restored[0]?.type === 'math') {
      expect(restored[0].data.latex).toBe('E = mc^2')
    }
    t2.done()
    p.stop()
  })

  it('editing existing math patches data.latex, data.display, data.size, w, h in one batch and hides element while open', async () => {
    vi.useFakeTimers()
    start(10, 20)
    type('x')
    await vi.advanceTimersByTimeAsync(160)
    cmdEnter()

    const m = els()[0]
    if (m?.type !== 'math') throw new Error('expected math')

    const commit = vi.spyOn(ed, 'commit')
    // Double-click with math tool also opens it
    ed.setTool('math')
    ed.tool.onDoubleClick?.(ev(m.x + 2, m.y + 2))
    expect(ed.hidden).toBe(m.id)
    expect(area().value).toBe('x')

    type('\\sum_{i=1}^n i')
    displayBtn().click() // toggle to inline (false)
    sizeInput().value = '36'
    sizeInput().dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(160)
    cmdEnter()

    expect(ed.hidden).toBeNull()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[0].label).toBe('Edit Math')
    const after = els()[0]
    if (after?.type !== 'math') throw new Error('expected math')
    expect(after.data).toEqual({
      latex: '\\sum_{i=1}^n i',
      display: false,
      size: 36,
    })
    ed.undoOnce()
    const back = els()[0]
    if (back?.type !== 'math') throw new Error('expected math')
    expect(back.data).toEqual(m.data)
    expect([back.w, back.h]).toEqual([m.w, m.h])
  })
})

describe('author', () => {
  it('a new equation carries Editor.author', () => {
    ed.author = { kind: 'human', id: 'owner' }
    start()
    type('x^2')
    cmdEnter()
    expect(els()[0]?.author).toEqual({ kind: 'human', id: 'owner' })
  })
})

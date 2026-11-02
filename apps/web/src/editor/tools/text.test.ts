// @vitest-environment jsdom
import { layoutText, ordered } from '@whiteboard/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '../editor'
import { drag, ev, key, ptr, setup } from '../test-utils'

let ed: Editor
let done: () => void
beforeEach(() => {
  ;({ ed, done } = setup())
})
afterEach(() => done())

const els = () => ordered(ed.scene)
const area = () => ed.host.querySelector('textarea') as HTMLTextAreaElement
const type = (s: string) => {
  area().value = s
  area().dispatchEvent(new Event('input'))
}
const blur = () => area().dispatchEvent(new FocusEvent('blur'))
const start = (x = 10, y = 20) => {
  ed.setTool('text')
  drag(ed.tool, [[x, y]])
}
const seedText = (text = 'old') => {
  start(5, 6)
  type(text)
  blur()
  return els()[0]
}

describe('text tool', () => {
  it('click opens an uncommitted textarea; typing then blur commits one Add Text batch', () => {
    const commit = vi.spyOn(ed, 'commit')
    start()
    expect(commit).not.toHaveBeenCalled()
    expect(els()).toEqual([])
    type('hello')
    expect(commit).not.toHaveBeenCalled()
    blur()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[0].label).toBe('Add Text')
    const [t] = els()
    expect(t?.type === 'text' && t.data.text).toBe('hello')
    expect([t?.x, t?.y]).toEqual([10, 20])
    expect(area()).toBeNull()
    expect(ed.tool.id).toBe('select')
    ed.undoOnce()
    expect(els()).toEqual([])
  })

  it('the key T selects the text tool', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }))
    expect(ed.tool.id).toBe('text')
  })

  it.each(['', '   ', ' \n\t '])('blank %j commits nothing', (s) => {
    const commit = vi.spyOn(ed, 'commit')
    start()
    type(s)
    blur()
    expect(commit).not.toHaveBeenCalled()
    expect(els()).toEqual([])
  })

  it('w/h follow the layout', () => {
    start()
    type('ab\ncdef')
    blur()
    const t = els()[0]
    if (t?.type !== 'text') throw new Error('no text')
    const l = layoutText(t, ed.platform)
    expect([t.w, t.h]).toEqual([l.width, l.height])
    expect(l.height).toBeCloseTo(2 * 24 * 1.4)
  })

  it('editing existing text commits one Edit Text patch; undo restores text and w/h', () => {
    const before = seedText('old')
    const commit = vi.spyOn(ed, 'commit')
    ed.editText(before?.id as string)
    expect(ed.hidden).toBe(before?.id)
    expect(area().value).toBe('old')
    type('a much longer line')
    blur()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[0].label).toBe('Edit Text')
    const after = els()[0]
    expect(after?.type === 'text' && after.data.text).toBe('a much longer line')
    expect(after?.w).toBeGreaterThan(before?.w ?? 0)
    expect(ed.hidden).toBeNull()
    ed.undoOnce()
    const back = els()[0]
    expect(back?.type === 'text' && back.data.text).toBe('old')
    expect([back?.w, back?.h]).toEqual([before?.w, before?.h])
  })

  it('unchanged text commits nothing; blanking existing text commits Delete Text', () => {
    const t = seedText('old')
    const commit = vi.spyOn(ed, 'commit')
    ed.editText(t?.id as string)
    blur()
    expect(commit).not.toHaveBeenCalled()
    ed.editText(t?.id as string)
    type('  ')
    blur()
    expect(commit.mock.calls[0]?.[0].label).toBe('Delete Text')
    expect(els()).toEqual([])
    ed.undoOnce()
    expect(els()).toHaveLength(1)
  })

  it('dir follows the first strong character while auto', () => {
    start()
    type('م')
    expect(area().dir).toBe('rtl')
    expect(area().style.textAlign).toBe('right')
    type('a')
    expect(area().dir).toBe('ltr')
    type('123 مرحبا')
    expect(area().dir).toBe('rtl')
    blur()
    const t = els()[0]
    expect(t?.type === 'text' && t.data.align).toBe('right')
  })

  it('scales the textarea with zoom and positions it at the element', () => {
    ed.camera = { x: 0, y: 0, zoom: 2 }
    start(10, 20)
    expect(area().style.fontSize).toBe('48px')
    expect(area().style.left).toBe('20px')
    expect(area().style.top).toBe('40px')
    expect(area().style.lineHeight).toBe('1.4')
  })

  it('keeps logical order for emoji ZWJ, combining marks, mixed scripts and RTL line breaks', () => {
    const s = ['👨‍👩‍👧‍👦 é', 'مَرْحَبًا hello مرحبا', 'עברית\nمرحبا world'].join(
      '\n',
    )
    start()
    type(s)
    blur()
    const t = els()[0]
    expect(t?.type === 'text' && t.data.text).toBe(s)
  })

  it('a 10,000 character paste commits with finite w/h', () => {
    start()
    type('مرحبا hello '.repeat(834).slice(0, 10_000))
    blur()
    const t = els()[0]
    expect(t?.type === 'text' && t.data.text).toHaveLength(10_000)
    expect(Number.isFinite(t?.w)).toBe(true)
    expect(Number.isFinite(t?.h)).toBe(true)
    expect(t?.w).toBeGreaterThanOrEqual(1)
    expect(t?.h).toBeGreaterThanOrEqual(1)
  })

  it('Esc and Ctrl/Cmd+Enter commit; plain Enter does not', () => {
    const press = (k: string, init: KeyboardEventInit = {}) =>
      area().dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }),
      )
    start()
    type('one')
    press('Enter')
    expect(area()).not.toBeNull()
    press('Escape')
    expect(els()).toHaveLength(1)
    expect(area()).toBeNull()
    start(50, 50)
    type('two')
    press('Enter', { ctrlKey: true })
    expect(els()).toHaveLength(2)
    start(90, 90)
    type('three')
    press('Enter', { metaKey: true })
    expect(els()).toHaveLength(3)
  })

  it('clicking the canvas while editing commits', () => {
    start()
    type('x')
    ed.tool.onPointerDown(ev(300, 300))
    expect(els()).toHaveLength(1)
    expect(area()).toBeNull()
  })

  it('select: double-click on text enters edit mode; Enter does too; shapes do not', () => {
    const t = seedText('abc')
    ed.setTool('select')
    ptr('dblclick', (t?.x ?? 0) + 2, (t?.y ?? 0) + 2)
    expect(area().value).toBe('abc')
    expect(ed.tool.id).toBe('text')
    blur()
    expect(ed.tool.id).toBe('select')
    expect([...ed.selection]).toEqual([t?.id])
    expect(key(ed.tool, 'Enter')).toBe(true)
    expect(area().value).toBe('abc')
    blur()
    ed.selection.clear()
    expect(key(ed.tool, 'Enter')).toBeFalsy()
    expect(area()).toBeNull()
  })

  it('readOnly is inert', () => {
    const t = seedText('abc')
    ed.setTool('select')
    ed.readOnly = true
    ptr('dblclick', (t?.x ?? 0) + 2, (t?.y ?? 0) + 2)
    ed.editText(t?.id as string)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }))
    expect(area()).toBeNull()
    expect(ed.tool.id).toBe('select')
  })

  it('dispose removes the textarea', () => {
    start()
    type('x')
    const host = ed.host
    ed.dispose()
    expect(host.querySelector('textarea')).toBeNull()
  })
})

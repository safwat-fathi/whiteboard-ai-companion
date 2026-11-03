// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { SelectionToolbar, toolbarPosition } from './SelectionToolbar'

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const host = { left: 0, right: 900, top: 0 }
describe('toolbarPosition', () => {
  it('sits centred above the selection', () => {
    expect(toolbarPosition({ x: 400, top: 300 }, host)).toEqual({
      left: 352,
      top: 260,
    })
  })
  it('stays inside the board on both sides', () => {
    expect(toolbarPosition({ x: 5, top: 300 }, host).left).toBe(8)
    expect(toolbarPosition({ x: 899, top: 300 }, host).left).toBe(900 - 96 - 8)
  })
  it('drops below the selection when there is no room above', () => {
    expect(toolbarPosition({ x: 400, top: 20 }, host)).toEqual({
      left: 352,
      top: 28,
    })
  })
})

describe('SelectionToolbar', () => {
  // a stand-in editor: the real one needs a canvas
  function fakeEditor(selected: string[]) {
    const listeners = new Set<() => void>()
    const sel = new Set(selected)
    const ed = {
      readOnly: false,
      selection: sel,
      scene: {
        els: new Map([
          [
            'a',
            {
              id: 'a',
              type: 'shape',
              x: 100,
              y: 200,
              w: 100,
              h: 50,
              rotation: 0,
              style: { strokeWidth: 2 },
              data: { kind: 'rect' },
            },
          ],
        ]),
      },
      host: { getBoundingClientRect: () => ({ left: 0, right: 900, top: 0 }) },
      worldToClient: (p: { x: number; y: number }) => ({
        x: p.x + 10,
        y: p.y + 20,
      }),
      onSelectionChange: (fn: () => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      onChange: () => () => {},
      onCameraChange: () => () => {},
    }
    return {
      ed,
      fire: () =>
        act(async () => {
          for (const fn of listeners) fn()
        }),
    }
  }
  async function mount(ed: unknown, onAsk: () => void) {
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    await act(async () =>
      root.render(
        createElement(SelectionToolbar, { editor: ed as never, onAsk }),
      ),
    )
    return { el, unmount: () => act(async () => root.unmount()) }
  }

  it('shows Ask AI over a selection, asks on click, and disappears when the selection goes', async () => {
    const { ed, fire } = fakeEditor(['a'])
    const onAsk = vi.fn()
    const m = await mount(ed, onAsk)
    const bar = m.el.querySelector('[role="toolbar"]') as HTMLElement
    expect(bar.getAttribute('aria-label')).toBe('Selection')
    await act(async () =>
      (bar.querySelector('button') as HTMLButtonElement).click(),
    )
    expect(onAsk).toHaveBeenCalledOnce()
    ed.selection.clear()
    await fire()
    expect(m.el.querySelector('[role="toolbar"]')).toBeNull()
    await m.unmount()
  })
  it('does not show on a read-only board or with nothing selected', async () => {
    const { ed } = fakeEditor([])
    const m = await mount(ed, () => {})
    expect(m.el.querySelector('[role="toolbar"]')).toBeNull()
    await m.unmount()
    const ro = fakeEditor(['a'])
    ro.ed.readOnly = true
    const m2 = await mount(ro.ed, () => {})
    expect(m2.el.querySelector('[role="toolbar"]')).toBeNull()
    await m2.unmount()
  })
})

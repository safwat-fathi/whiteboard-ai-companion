// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Toolbar } from '../app/Toolbar'
import type { Editor } from './editor/editor'
import { setup } from './editor/test-utils'

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) f()
})

/** A real Editor and a mounted Toolbar. `editor: null` is the loading state. */
async function mount(opts: { editor?: boolean; readOnly?: boolean } = {}) {
  const t = setup()
  cleanups.push(t.done)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  cleanups.push(() => {
    act(() => root.unmount())
    host.remove()
  })
  const render = (editor: Editor | null, readOnly: boolean) =>
    act(async () => {
      root.render(createElement(Toolbar, { editor, readOnly }))
    })
  await render(opts.editor === false ? null : t.ed, opts.readOnly ?? false)
  const buttons = () => [...host.querySelectorAll('button')]
  const btn = (name: string) =>
    host.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement
  return { ed: t.ed, btn, buttons, render }
}

describe('Toolbar', () => {
  it('names each tool with its key, marks the active tool and follows the editor', async () => {
    const { ed, btn } = await mount()
    expect(btn('Rectangle').title).toBe('Rectangle (R)')
    expect(btn('Triangle').title).toBe('Triangle') // no shortcut
    expect(btn('Hand').getAttribute('aria-pressed')).toBe('true') // the Editor starts on Hand
    await act(async () => btn('Rectangle').click())
    expect(ed.tool.id).toBe('rect')
    expect(btn('Rectangle').getAttribute('aria-pressed')).toBe('true')
    expect(btn('Hand').getAttribute('aria-pressed')).toBe('false')
    await act(async () => ed.setTool('arrow')) // a shortcut, or a tool finishing
    expect(btn('Arrow').getAttribute('aria-pressed')).toBe('true')
    expect(btn('Rectangle').getAttribute('aria-pressed')).toBe('false')
  })

  it('does not take focus from the canvas or a text field, and runs undo and redo', async () => {
    const { ed, btn } = await mount()
    const undo = vi.spyOn(ed, 'undoOnce')
    const redo = vi.spyOn(ed, 'redoOnce')
    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    })
    btn('Undo').dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    await act(async () => btn('Undo').click())
    await act(async () => btn('Redo').click())
    expect(undo).toHaveBeenCalledTimes(1)
    expect(redo).toHaveBeenCalledTimes(1)
  })

  it('is disabled while loading and when read-only', async () => {
    const { ed, buttons, render } = await mount({ editor: false })
    expect(buttons()).toHaveLength(11)
    expect(buttons().every((b) => b.disabled)).toBe(true)
    await render(ed, false)
    expect(buttons().some((b) => b.disabled)).toBe(false)
    await render(ed, true)
    expect(buttons().every((b) => b.disabled)).toBe(true)
  })
})

// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clampDock,
  DOCK_DEFAULT,
  DOCK_MAX,
  DOCK_MIN,
  Dock,
  SHEET_H,
  STRIP_W,
  useDockLayout,
} from './Dock'

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const probe = { mounts: 0, unmounts: 0 }
function Probe() {
  useEffect(() => {
    probe.mounts++
    return () => {
      probe.unmounts++
    }
  }, [])
  return createElement('p', null, 'chat pane')
}

function Harness({ enabled = true }: { enabled?: boolean }) {
  const layout = useDockLayout(enabled)
  return createElement(
    'div',
    null,
    createElement('output', { id: 'inset' }, JSON.stringify(layout.inset)),
    createElement(Dock, {
      layout,
      panes: {
        chat: createElement(Probe),
        activity: createElement('p', null, 'activity pane'),
        source: createElement('p', null, 'source pane'),
      },
    }),
  )
}

let host: HTMLDivElement
let unmount: (() => Promise<void>) | undefined
async function mount(enabled = true) {
  host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(Harness, { enabled })))
  unmount = async () => {
    await act(async () => root.unmount())
    host.remove()
  }
}
const inset = () =>
  JSON.parse(host.querySelector('#inset')?.textContent ?? '{}')
const q = <T extends Element>(sel: string) => host.querySelector(sel) as T
const tab = (name: string) => q<HTMLButtonElement>(`#dock-tab-${name}`)
const pane = (name: string) => q<HTMLElement>(`#dock-pane-${name}`)
const key = (el: Element, k: string) =>
  act(async () => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
    )
  })
const click = (el: Element) => act(async () => (el as HTMLElement).click())

beforeEach(() => localStorage.clear())
afterEach(async () => {
  await unmount?.()
  unmount = undefined
  vi.unstubAllGlobals()
})

describe('clampDock', () => {
  it('keeps the width between 320 and 560 and whole', () => {
    expect([clampDock(100), clampDock(321.6), clampDock(9999)]).toEqual([
      DOCK_MIN,
      322,
      DOCK_MAX,
    ])
  })
})

describe('Dock', () => {
  it('is a labelled region with a tablist; the chat pane shows first and the others are hidden but mounted', async () => {
    await mount()
    expect(q('aside').getAttribute('aria-label')).toBe('Tutor')
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(3)
    expect(tab('chat').getAttribute('aria-selected')).toBe('true')
    expect(pane('chat').hidden).toBe(false)
    expect(pane('activity').hidden).toBe(true)
    expect(pane('activity').textContent).toBe('activity pane')
    expect(inset()).toEqual({ right: DOCK_DEFAULT, bottom: 0 })
  })

  it('a click and the arrow, Home and End keys move between tabs with roving tabindex', async () => {
    await mount()
    await click(tab('source'))
    expect(pane('source').hidden).toBe(false)
    expect(pane('chat').hidden).toBe(true)
    await key(tab('source'), 'ArrowRight') // wraps to the first
    expect(tab('chat').getAttribute('aria-selected')).toBe('true')
    expect(tab('chat').tabIndex).toBe(0)
    expect(tab('source').tabIndex).toBe(-1)
    await key(tab('chat'), 'End')
    expect(tab('source').getAttribute('aria-selected')).toBe('true')
    await key(tab('source'), 'ArrowLeft')
    expect(tab('activity').getAttribute('aria-selected')).toBe('true')
    await key(tab('activity'), 'Home')
    expect(tab('chat').getAttribute('aria-selected')).toBe('true')
  })

  it('collapses to a strip that gives the board its width back, and reopens', async () => {
    await mount()
    await click(q('[aria-label="Collapse the tutor"]'))
    expect(inset().right).toBe(STRIP_W)
    expect(
      q<HTMLElement>('[role="tablist"]').closest('aside')?.style.display,
    ).toBe('none')
    await click(q('[aria-label="Open the tutor"]'))
    expect(inset().right).toBe(DOCK_DEFAULT)
    expect(
      q<HTMLElement>('[role="tablist"]').closest('aside')?.style.display,
    ).toBe('flex')
  })

  it('collapsing keeps the panes mounted, so a running turn is not aborted', async () => {
    probe.mounts = probe.unmounts = 0
    await mount()
    await click(q('[aria-label="Collapse the tutor"]'))
    await click(q('[aria-label="Open the tutor"]'))
    expect(probe).toEqual({ mounts: 1, unmounts: 0 })
  })

  it('resizes with the keyboard, within 320 to 560, and remembers width and collapsed state', async () => {
    await mount()
    const sep = q('[role="separator"]')
    expect(sep.getAttribute('aria-valuenow')).toBe(String(DOCK_DEFAULT))
    await key(sep, 'ArrowLeft') // wider
    expect(inset().right).toBe(DOCK_DEFAULT + 16)
    for (let i = 0; i < 40; i++) await key(sep, 'ArrowLeft')
    expect(inset().right).toBe(DOCK_MAX)
    for (let i = 0; i < 60; i++) await key(sep, 'ArrowRight')
    expect(inset().right).toBe(DOCK_MIN)
    await click(q('[aria-label="Collapse the tutor"]'))
    expect(JSON.parse(localStorage.getItem('whiteboard:dock') ?? '{}')).toEqual(
      { width: DOCK_MIN, collapsed: true },
    )
    await unmount?.()
    await mount() // a new page load restores it
    expect(inset().right).toBe(STRIP_W)
  })

  it('is a bottom sheet on a narrow screen: no resize handle, the board loses height not width', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }))
    await mount()
    expect(host.querySelector('[role="separator"]')).toBeNull()
    expect(inset()).toEqual({ right: 0, bottom: SHEET_H })
  })

  it('takes no room when disabled (local mode has no dock)', async () => {
    await mount(false)
    expect(inset()).toEqual({ right: 0, bottom: 0 })
  })
})

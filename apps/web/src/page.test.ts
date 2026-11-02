// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Notices } from '../app/Notice'

const order: string[] = []
vi.mock('./editor/editor', () => ({
  Editor: class {
    readOnly = false
    tool = { id: 'hand' }
    tools = {}
    onToolChange() {
      return () => {}
    }
    dispose() {}
  },
}))
vi.mock('./editor/fonts', () => ({ loadFonts: async () => {} }))
vi.mock('./editor/platform', () => ({ browserPlatform: () => ({}) }))
vi.mock('./editor/persist', () => ({
  acquireBoardLock: async () => {
    order.push('lock')
    return true
  },
  releaseBoardLock: () => {},
  createPersistence: () => ({
    load: async () => {
      order.push('load')
      return { status: 'empty' }
    },
    start: () => {},
    stop: () => {},
  }),
}))

describe('Notices', () => {
  it('renders an empty live region when there are no notes', () => {
    const html = renderToStaticMarkup(createElement(Notices, { notes: [] }))
    expect(html).toContain('aria-live="polite"')
    expect(html).not.toContain('role=')
  })
  it('uses alert for problems and status for info', () => {
    const html = renderToStaticMarkup(
      createElement(Notices, {
        notes: [
          { key: 'a', text: 'Could not save', role: 'alert' },
          { key: 'b', text: '2 dropped', role: 'status' },
        ],
      }),
    )
    expect(html).toMatch(/role="alert"[^>]*>Could not save/)
    expect(html).toMatch(/role="status"[^>]*>2 dropped/)
  })
})

describe('Page', () => {
  it('takes the board lock before loading', async () => {
    const { default: Page } = await import('../app/page')
    ;(
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(Page))
    })
    await vi.waitFor(() => expect(order).toContain('load'))
    expect(order.slice(0, 2)).toEqual(['lock', 'load'])
    await act(async () => root.unmount())
  })
})

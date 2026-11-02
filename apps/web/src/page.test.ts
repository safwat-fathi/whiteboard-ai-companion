// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Notices } from '../app/Notice'

const order: string[] = []
// What the mocked persistence does; reset before every test.
const ctl = { load: (): unknown => ({ status: 'empty' }), stop: () => {} }
beforeEach(() => {
  order.length = 0
  ctl.load = () => ({ status: 'empty' })
  ctl.stop = () => {}
})
vi.mock('./editor/editor', () => ({
  Editor: class {
    readOnly = false
    tool = { id: 'hand' }
    tools = {}
    onToolChange() {
      return () => {}
    }
    dispose() {
      order.push('dispose')
    }
  },
}))
vi.mock('./editor/fonts', () => ({ loadFonts: async () => {} }))
vi.mock('./editor/platform', () => ({ browserPlatform: () => ({}) }))
vi.mock('./editor/persist', () => ({
  acquireBoardLock: async () => {
    order.push('lock')
    return true
  },
  releaseBoardLock: () => {
    order.push('release')
  },
  createPersistence: () => ({
    load: async () => {
      order.push('load')
      return ctl.load()
    },
    start: () => {},
    stop: () => {
      order.push('stop')
      ctl.stop()
    },
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
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  const mount = async () => {
    const { default: Page } = await import('../app/page')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(Page))
    })
    await vi.waitFor(() => expect(order).toContain('load'))
    return {
      host,
      unmount: async () => {
        try {
          await act(async () => root.unmount())
        } finally {
          host.remove()
        }
      },
    }
  }
  const loaded = (over: Record<string, unknown>) => ({
    status: 'ok',
    dropped: 2,
    undoDropped: true,
    raw: {},
    record: {},
    ...over,
  })

  it('takes the board lock before loading', async () => {
    const page = await mount()
    expect(order.slice(0, 2)).toEqual(['lock', 'load'])
    await page.unmount()
  })

  it('a failed backup of dropped data shows one alert with Reload instead of the "dropped" notes', async () => {
    // control: the same load with a backup that worked says what was dropped
    ctl.load = () => loaded({})
    const ok = await mount()
    await vi.waitFor(() =>
      expect(ok.host.textContent).toContain('2 invalid elements were dropped'),
    )
    expect(ok.host.textContent).toContain('undo history')
    expect(ok.host.textContent).not.toContain('NOT being saved')
    await ok.unmount()

    order.length = 0
    ctl.load = () => loaded({ backupFailed: true })
    const failed = await mount()
    const alert = await vi.waitFor(() => {
      const a = failed.host.querySelector('[role="alert"]')
      expect(a?.textContent).toContain('changes are NOT being saved')
      return a as Element
    })
    expect(alert.querySelector('button')?.textContent).toBe('Reload')
    expect(failed.host.textContent).not.toContain('invalid elements')
    expect(failed.host.textContent).not.toContain('undo history')
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    ;(alert.querySelector('button') as HTMLButtonElement).click()
    vi.unstubAllGlobals()
    expect(reload).toHaveBeenCalledOnce()
    await failed.unmount()
  })

  it('cleanup runs stop, dispose and releaseBoardLock in that order even when stop throws', async () => {
    ctl.stop = () => {
      throw new Error('boom')
    }
    const page = await mount()
    order.length = 0
    await expect(page.unmount()).rejects.toThrow('boom') // still reported, but only after the steps ran
    expect(order).toEqual(['stop', 'dispose', 'release'])
  })
})

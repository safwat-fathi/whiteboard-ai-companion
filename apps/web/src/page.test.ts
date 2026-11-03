// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Notices } from '../app/Notice'

const nav = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace }),
  useParams: () => ({}),
}))

const order: string[] = []
// What the mocked persistence does; reset before every test.
const ctl = { load: (): unknown => ({ status: 'empty' }), stop: () => {} }
const syncCtl = {
  // biome-ignore lint/suspicious/noExplicitAny: test control
  opts: null as any,
  onStatus: (_s: string, _d?: string) => {},
  stop: () => {},
}
// biome-ignore lint/suspicious/noExplicitAny: test spy
const instances: { editor?: any } = {}

beforeEach(() => {
  order.length = 0
  ctl.load = () => ({ status: 'empty' })
  ctl.stop = () => {}
  syncCtl.opts = null
  syncCtl.onStatus = () => {}
  syncCtl.stop = () => {}
  instances.editor = undefined
})
vi.mock('./editor/editor', () => ({
  Editor: class {
    readOnly = false
    tool = { id: 'hand' }
    tools = {}
    author: unknown = { kind: 'human', id: 'local' }
    blobs: unknown
    constructor(_host: HTMLElement, options?: { blobs?: unknown }) {
      this.blobs = options?.blobs
      instances.editor = this
    }
    onToolChange() {
      return () => {}
    }
    selection = new Set<string>()
    scene = { els: new Map() }
    host = document.createElement('div')
    index = { pick: () => null }
    camera = { x: 0, y: 0, zoom: 1 }
    viewport = { width: 800, height: 600, dpr: 1 }
    screenToWorldPoint() {
      return { x: 0, y: 0 }
    }
    onSelectionChange() {
      return () => {}
    }
    onChange() {
      return () => {}
    }
    onCameraChange() {
      return () => {}
    }
    dispose() {
      order.push('dispose')
    }
  },
}))
vi.mock('./editor/fonts', () => ({ loadFonts: async () => {} }))
vi.mock('./editor/platform', () => ({ browserPlatform: () => ({}) }))
vi.mock('./editor/sync', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: mock options
  createSyncClient: (opts: any) => {
    syncCtl.opts = opts
    syncCtl.onStatus = opts.onStatus
    order.push('sync-create')
    return {
      start: () => {
        order.push('sync-start')
      },
      stop: () => {
        order.push('sync-stop')
        syncCtl.stop()
      },
    }
  },
}))
vi.mock('./editor/blobs-http', () => ({
  createHttpBlobStore: (base: string) => ({ kind: 'http-blobs', base }),
}))
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

  describe('server mode (NEXT_PUBLIC_API_BASE set)', () => {
    const originalApiBase = process.env.NEXT_PUBLIC_API_BASE
    beforeEach(() => {
      process.env.NEXT_PUBLIC_API_BASE = 'http://localhost:4000'
      localStorage.clear()
    })
    afterEach(() => {
      if (originalApiBase === undefined) {
        delete process.env.NEXT_PUBLIC_API_BASE
      } else {
        process.env.NEXT_PUBLIC_API_BASE = originalApiBase
      }
      vi.unstubAllGlobals()
    })

    const mountServer = async (boardId = 'board-123') => {
      const { Workspace } = await import('./workspace/Workspace')
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      await act(async () => {
        root.render(createElement(Workspace, { boardId }))
      })
      await vi.waitFor(() => expect(order).toContain('sync-start'))
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

    it('starts without acquiring board lock, sets owner author and http blob store, and connects sync client', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/api/boards/board-123'))
          return new Response(
            JSON.stringify({ id: 'board-123', title: 'Algebra' }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          )
        return new Response('Not found', { status: 404 })
      })
      vi.stubGlobal('fetch', mockFetch)

      const page = await mountServer()
      expect(order).not.toContain('lock')
      expect(order).not.toContain('load')
      expect(instances.editor?.author).toEqual({
        kind: 'human',
        id: 'owner',
      })
      expect(instances.editor?.blobs).toEqual({
        kind: 'http-blobs',
        base: 'http://localhost:4000',
      })
      expect(syncCtl.opts.boardId).toBe('board-123')
      expect(syncCtl.opts.url).toBe('ws://localhost:4000/ws?boardId=board-123')
      expect(page.host.querySelector('header')?.textContent).toContain(
        'Algebra',
      )
      expect(
        page.host.querySelector('aside[aria-label="Tutor"]'),
      ).not.toBeNull()

      // Editor is read-only initially until sync goes live
      expect(instances.editor?.readOnly).toBe(true)
      await act(async () => {
        syncCtl.onStatus('live')
      })
      expect(instances.editor?.readOnly).toBe(false)

      // Offline shows alert
      await act(async () => {
        syncCtl.onStatus('offline')
      })
      const alert = page.host.querySelector(
        '[aria-live="polite"] [role="alert"]',
      ) // the notices, not a dock panel
      expect(alert?.textContent).toContain('Offline: changes are not saved')

      // Back to live clears alert
      await act(async () => {
        syncCtl.onStatus('live')
      })
      expect(
        page.host.querySelector('[aria-live="polite"] [role="alert"]'),
      ).toBeNull()

      order.length = 0
      await page.unmount()
      expect(order).toEqual(['sync-stop', 'dispose'])
      expect(order).not.toContain('release')
    })
  })
})

describe('Home (the "/" route)', () => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  const replace = nav.replace
  const original = process.env.NEXT_PUBLIC_API_BASE
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_API_BASE
    else process.env.NEXT_PUBLIC_API_BASE = original
    vi.unstubAllGlobals()
    replace.mockReset()
    localStorage.clear()
  })
  const mountHome = async () => {
    const { default: Home } = await import('../app/page')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(Home))
    })
    return {
      host,
      unmount: async () => {
        await act(async () => root.unmount())
        host.remove()
      },
    }
  }
  const boardsFetch = (existing: { id: string }[]) =>
    vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (!url.endsWith('/api/boards'))
        return new Response('nope', { status: 404 })
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
      return init?.method === 'POST'
        ? json({ id: 'new-board-456' }, 201)
        : json({ boards: existing })
    })

  it('server mode opens the remembered board at its own URL', async () => {
    process.env.NEXT_PUBLIC_API_BASE = 'http://localhost:4000'
    localStorage.setItem('whiteboard:boardId', 'b2')
    vi.stubGlobal('fetch', boardsFetch([{ id: 'b1' }, { id: 'b2' }]))
    const page = await mountHome()
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/boards/b2'))
    await page.unmount()
  })

  it('server mode creates a Main board when there is none, and an empty base still means server mode', async () => {
    process.env.NEXT_PUBLIC_API_BASE = ''
    vi.stubGlobal('fetch', boardsFetch([]))
    const page = await mountHome()
    await vi.waitFor(() =>
      expect(replace).toHaveBeenCalledWith('/boards/new-board-456'),
    )
    expect(localStorage.getItem('whiteboard:boardId')).toBe('new-board-456')
    await page.unmount()
  })

  it('shows an alert with Reload when the server cannot be reached', async () => {
    process.env.NEXT_PUBLIC_API_BASE = 'http://localhost:4000'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const page = await mountHome()
    await vi.waitFor(() =>
      expect(page.host.querySelector('[role="alert"]')?.textContent).toMatch(
        /Reload/,
      ),
    )
    expect(replace).not.toHaveBeenCalled()
    await page.unmount()
  })
})

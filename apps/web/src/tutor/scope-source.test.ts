// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Book, LibraryApi, Section } from '../library/api'
import { ScopeChip } from './ScopeChip'
import { SourceTab } from './SourceTab'

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const sec = (id: number, title: string, parentId: number | null): Section => ({
  id,
  parentId,
  ord: id,
  level: parentId === null ? 1 : 2,
  title,
  pageStart: id * 10,
  pageEnd: id * 10 + 9,
  summary: null,
  tokens: null,
})
const bio = { id: 'bk1', title: 'Biology', pages: 120, status: 'ready' } as Book
const other = {
  id: 'bk2',
  title: 'Algebra',
  pages: 300,
  status: 'ready',
} as Book
const failed = {
  id: 'bk3',
  title: 'Broken',
  pages: 5,
  status: 'failed',
} as Book

function fakeApi(over: Partial<LibraryApi> = {}) {
  const calls: { setScope: unknown[] } = { setScope: [] }
  const api = {
    getBook: async (id: string) =>
      [bio, other].find((b) => b.id === id) as Book,
    listBooks: async () => [bio, other, failed],
    outline: async (id: string) =>
      id === 'bk1'
        ? [
            sec(1, 'Photosynthesis', null),
            sec(2, 'Light', 1),
            sec(3, 'Respiration', null),
          ]
        : [sec(5, 'Equations', null)],
    setBoardScope: async (_id: string, scope: unknown) => {
      calls.setScope.push(scope)
      return {} as never
    },
    getPage: async () =>
      ({ page: 1, label: 'iv', text: '', method: 'R1' }) as never,
    pageImageUrl: (id: string, page: number) => `/img/${id}/${page}`,
    ...over,
  } as unknown as LibraryApi
  return { api, calls }
}

let unmount: (() => Promise<void>) | undefined
let host: HTMLDivElement
async function mount(el: ReturnType<typeof createElement>) {
  host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(el))
  await act(async () => {})
  unmount = async () => {
    await act(async () => root.unmount())
    host.remove()
  }
}
afterEach(async () => {
  await unmount?.()
  unmount = undefined
})
const q = <T extends Element>(s: string) => host.querySelector(s) as T
const button = (label: string) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement
const click = (el: Element) => act(async () => (el as HTMLElement).click())

describe('ScopeChip', () => {
  it('shows what the board studies, from the book title and the chosen sections', async () => {
    const { api } = fakeApi()
    await mount(
      createElement(ScopeChip, {
        api,
        boardId: 'b',
        scope: { kind: 'chapter', bookId: 'bk1', sectionIds: [1, 3] },
        onChange: () => {},
      }),
    )
    expect(q('button').textContent).toBe('Biology: Photosynthesis, Respiration')
  })
  it('says "No book" without a scope', async () => {
    const { api } = fakeApi()
    await mount(
      createElement(ScopeChip, {
        api,
        boardId: 'b',
        scope: null,
        onChange: () => {},
      }),
    )
    expect(q('button').textContent).toBe('No book')
  })

  it('picks another book and sections, saves the scope on the board and reports it', async () => {
    const { api, calls } = fakeApi()
    const onChange = vi.fn()
    await mount(
      createElement(ScopeChip, { api, boardId: 'b9', scope: null, onChange }),
    )
    await click(q('button'))
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const select = dialog.querySelector('select') as HTMLSelectElement
    // only books that are ready are offered
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Choose a book…',
      'Biology',
      'Algebra',
    ])
    expect(button('Use this').disabled).toBe(true)
    await act(async () => {
      select.value = 'bk1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {})
    await click(dialog.querySelector('input[type="checkbox"]') as Element) // Photosynthesis
    await click(button('Use this'))
    expect(calls.setScope).toEqual([
      { kind: 'chapter', bookId: 'bk1', sectionIds: [1] },
    ])
    expect(onChange).toHaveBeenCalledWith({
      kind: 'chapter',
      bookId: 'bk1',
      sectionIds: [1],
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('"No book" clears the scope; a failed save keeps the dialog open and says why', async () => {
    const { api, calls } = fakeApi()
    const onChange = vi.fn()
    await mount(
      createElement(ScopeChip, {
        api,
        boardId: 'b',
        scope: { kind: 'book', bookId: 'bk1' },
        onChange,
      }),
    )
    await click(q('button'))
    await click(button('No book'))
    expect(calls.setScope).toEqual([{}])
    expect(onChange).toHaveBeenCalledWith(null)
    await unmount?.()
    const bad = fakeApi({
      setBoardScope: async () => {
        throw new Error('The server could not be reached.')
      },
    })
    await mount(
      createElement(ScopeChip, {
        api: bad.api,
        boardId: 'b',
        scope: { kind: 'book', bookId: 'bk1' },
        onChange,
      }),
    )
    await click(q('button'))
    await click(button('No book'))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'could not be reached',
    )
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
})

describe('SourceTab', () => {
  it('explains itself before any citation is opened', async () => {
    const { api } = fakeApi()
    await mount(
      createElement(SourceTab, { api, source: null, onPage: () => {} }),
    )
    expect(host.textContent).toMatch(/Open a citation/)
  })
  it('shows the cited page in the viewer, with the printed label, and follows page changes', async () => {
    const { api } = fakeApi()
    const onPage = vi.fn()
    await mount(
      createElement(SourceTab, {
        api,
        source: { bookId: 'bk1', page: 41 },
        onPage,
      }),
    )
    await act(async () => {})
    const img = q<HTMLImageElement>('img')
    expect(img.getAttribute('src')).toBe('/img/bk1/41')
    expect(host.textContent).toMatch(/iv/)
    await click(button('Next'))
    expect(onPage).toHaveBeenCalledWith(42)
  })
  it('says so when the book is gone', async () => {
    const { api } = fakeApi({
      getBook: async () => {
        throw new Error('gone')
      },
    })
    await mount(
      createElement(SourceTab, {
        api,
        source: { bookId: 'zz', page: 1 },
        onPage: () => {},
      }),
    )
    await act(async () => {})
    expect(q('[role="alert"]').textContent).toMatch(/not available/)
  })
})

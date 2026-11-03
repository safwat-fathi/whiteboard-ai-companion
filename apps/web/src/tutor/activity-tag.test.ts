// @vitest-environment jsdom
import type { ActivityTurn } from '@whiteboard/core'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActivityTab } from './ActivityTab'
import { AiTag } from './AiTag'

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let unmount: (() => Promise<void>) | undefined
let host: HTMLDivElement
async function mount(el: ReturnType<typeof createElement>) {
  host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(el))
  unmount = async () => {
    await act(async () => root.unmount())
    host.remove()
  }
}
afterEach(async () => {
  await unmount?.()
  unmount = undefined
})
const btn = (label: string, within: ParentNode = document) =>
  [...within.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement
const click = (el: Element) => act(async () => (el as HTMLElement).click())

const turn = (
  id: string,
  text: string,
  over: Partial<ActivityTurn> = {},
): ActivityTurn => ({
  turnId: id,
  startedAt: Date.UTC(2026, 10, 3, 9, 30),
  userText: text,
  status: 'done',
  bounds: { x: 0, y: 0, w: 300, h: 200 },
  batches: [
    {
      batchId: `${id}-1`,
      seq: 1,
      label: 'Add text',
      bounds: { x: 0, y: 0, w: 100, h: 30 },
      count: 1,
      touchedIds: ['t1'],
    },
    {
      batchId: `${id}-2`,
      seq: 2,
      label: 'Add diagram',
      bounds: { x: 0, y: 100, w: 300, h: 100 },
      count: 9,
      touchedIds: ['d1', 'd2'],
    },
  ],
  ...over,
})

describe('ActivityTab', () => {
  const props = {
    hasMore: false,
    loadMore: () => {},
    failed: false,
    onLocate: () => {},
  }

  it('explains itself when the tutor has done nothing', async () => {
    await mount(createElement(ActivityTab, { ...props, turns: [] }))
    expect(host.textContent).toMatch(/will be listed here/)
  })

  it('lists each turn with what was asked, its state and its batches', async () => {
    await mount(
      createElement(ActivityTab, {
        ...props,
        turns: [
          turn('t2', 'Explain the Calvin cycle', { status: 'running' }),
          turn('t1', 'Draw the chloroplast', { status: 'stopped' }),
        ],
      }),
    )
    const rows = host.querySelectorAll('ol > li')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('Explain the Calvin cycle')
    expect(rows[0]?.textContent).toContain('working…')
    expect(rows[1]?.textContent).toContain('stopped · 2 changes')
    expect(rows[1]?.textContent).toContain('Add diagram · 9 elements')
    expect(btn('Undo turn', rows[0] as Element)).toBeUndefined() // not while it is still working
  })

  it('locates a whole turn or one batch, using the elements each touched', async () => {
    const onLocate = vi.fn()
    await mount(
      createElement(ActivityTab, {
        ...props,
        onLocate,
        turns: [turn('t1', 'q')],
      }),
    )
    await click(btn('Locate turn'))
    expect(onLocate).toHaveBeenLastCalledWith([
      { ids: ['t1'], bounds: { x: 0, y: 0, w: 100, h: 30 } },
      { ids: ['d1', 'd2'], bounds: { x: 0, y: 100, w: 300, h: 100 } },
    ])
    await click(btn('Locate', host.querySelectorAll('ul li')[1] as Element))
    expect(onLocate).toHaveBeenLastCalledWith([
      { ids: ['d1', 'd2'], bounds: { x: 0, y: 100, w: 300, h: 100 } },
    ])
  })

  it('undoes a turn or a batch and says what happened', async () => {
    const undo = {
      turn: vi.fn(async () => ({ undone: 2, skipped: 0 })),
      batch: vi.fn(async () => ({ undone: 1, skipped: 1 })),
    }
    await mount(
      createElement(ActivityTab, { ...props, undo, turns: [turn('t1', 'q')] }),
    )
    await click(btn('Undo', host.querySelectorAll('ul li')[0] as Element))
    expect(undo.batch).toHaveBeenCalledWith('t1-1')
    expect(host.textContent).toContain(
      'Undid 1 change. 1 change was kept because you edited it afterwards.',
    )
    await click(btn('Undo turn'))
    expect(undo.turn).toHaveBeenCalledWith('t1')
    expect(host.textContent).toContain('Undid 2 changes.')
  })

  it('shows earlier work on request, and an alert when it cannot load', async () => {
    const loadMore = vi.fn()
    await mount(
      createElement(ActivityTab, {
        ...props,
        hasMore: true,
        loadMore,
        turns: [turn('t1', 'q')],
      }),
    )
    await click(btn('Show earlier work'))
    expect(loadMore).toHaveBeenCalled()
    await unmount?.()
    await mount(
      createElement(ActivityTab, { ...props, failed: true, turns: [] }),
    )
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(
      /could not be loaded/,
    )
  })
})

describe('AiTag', () => {
  function fakeEditor(
    pickResult: { author: { kind: string; id: string } } | null,
  ) {
    const el = document.createElement('div')
    document.body.append(el)
    return {
      host: el,
      index: { pick: () => pickResult },
      camera: { x: 0, y: 0, zoom: 1 },
      scene: { els: new Map() },
      screenToWorldPoint: (x: number, y: number) => ({ x, y }),
    }
  }
  const move = (el: HTMLElement) =>
    act(
      async () =>
        void el.dispatchEvent(
          new MouseEvent('pointermove', {
            clientX: 50,
            clientY: 60,
            bubbles: true,
          }),
        ),
    )

  it('tags what the AI drew with what it was asked, and offers Show in chat', async () => {
    const ed = fakeEditor({ author: { kind: 'agent', id: 'tutor:t7' } })
    const onShow = vi.fn()
    await mount(
      createElement(AiTag, {
        editor: ed as never,
        labelOf: (t: string) =>
          t === 't7' ? 'Draw the chloroplast' : undefined,
        onShow,
      }),
    )
    expect(host.textContent).toBe('')
    await move(ed.host)
    expect(host.textContent).toContain('AI · Draw the chloroplast')
    await click(btn('Show in chat', host))
    expect(onShow).toHaveBeenCalledWith('t7')
  })

  it("does not tag the student's own elements or empty canvas", async () => {
    const mine = fakeEditor({ author: { kind: 'human', id: 'owner' } })
    await mount(
      createElement(AiTag, {
        editor: mine as never,
        labelOf: () => undefined,
        onShow: () => {},
      }),
    )
    await move(mine.host)
    expect(host.textContent).toBe('')
    await unmount?.()
    const empty = fakeEditor(null)
    await mount(
      createElement(AiTag, {
        editor: empty as never,
        labelOf: () => undefined,
        onShow: () => {},
      }),
    )
    await move(empty.host)
    expect(host.textContent).toBe('')
  })

  it('falls back to a bare "AI" when the turn is not in the list yet', async () => {
    const ed = fakeEditor({ author: { kind: 'agent', id: 'tutor:unknown' } })
    await mount(
      createElement(AiTag, {
        editor: ed as never,
        labelOf: () => undefined,
        onShow: () => {},
      }),
    )
    await move(ed.host)
    expect(host.textContent).toMatch(/^AIShow in chat$/)
  })

  it('keeps position stationary when pointer moves within the same turn element', async () => {
    const ed = fakeEditor({ author: { kind: 'agent', id: 'tutor:t7' } })
    await mount(
      createElement(AiTag, {
        editor: ed as never,
        labelOf: () => 'Chloroplast',
        onShow: () => {},
      }),
    )
    await move(ed.host)
    const fieldset = host.querySelector('fieldset') as HTMLElement
    expect(fieldset).not.toBeNull()
    const initialLeft = fieldset.style.left
    const initialTop = fieldset.style.top
    // the pointer is at (50, 60): the tag starts 12 px away, outside its 8 px invisible hit margin, so it never sits under the pointer
    expect(initialLeft).toBe('62px')
    expect(initialTop).toBe('72px')

    // Move pointer slightly toward the button (e.g. clientX: 70, clientY: 75)
    await act(
      async () =>
        void ed.host.dispatchEvent(
          new MouseEvent('pointermove', {
            clientX: 70,
            clientY: 75,
            bubbles: true,
          }),
        ),
    )
    // Position must stay frozen so the user can easily click "Show in chat"
    expect(fieldset.style.left).toBe(initialLeft)
    expect(fieldset.style.top).toBe(initialTop)
  })

  it('goes away shortly after the pointer leaves the element', async () => {
    vi.useFakeTimers()
    const ed = fakeEditor({ author: { kind: 'agent', id: 'tutor:t7' } })
    await mount(
      createElement(AiTag, {
        editor: ed as never,
        labelOf: () => 'x',
        onShow: () => {},
      }),
    )
    await move(ed.host)
    expect(host.textContent).toContain('AI')
    ;(ed.index as { pick: () => unknown }).pick = () => null
    await move(ed.host)
    await act(async () => void vi.advanceTimersByTime(300))
    expect(host.textContent).toBe('')
    vi.useRealTimers()
  })
})

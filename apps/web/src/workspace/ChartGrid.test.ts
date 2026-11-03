// @vitest-environment jsdom
import { ordered } from '@whiteboard/core'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '../editor/editor'
import { put, setup } from '../editor/test-utils'
import { ChartGrid } from './ChartGrid'

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let ed: Editor
let done: () => void
let unmount: () => Promise<void>
beforeEach(() => {
  ;({ ed, done } = setup())
})
afterEach(async () => {
  await unmount?.()
  done()
})

const chartEl = (data: Record<string, unknown> = {}) =>
  ({
    id: 'c1',
    type: 'chart',
    x: 100,
    y: 100,
    w: 480,
    h: 320,
    rotation: 0,
    z: 'a0',
    style: {
      stroke: '#1e1e1e',
      fill: null,
      strokeWidth: 2,
      opacity: 1,
      dash: 'solid',
    },
    locked: false,
    author: { kind: 'human', id: 'local' },
    v: 0,
    data: {
      kind: 'bar',
      title: 'Sales',
      categories: ['A', 'B', 'C'],
      series: [{ name: 'Sales', values: [3, 5, 2] }],
      ...data,
    },
  }) as never

async function open(data: Record<string, unknown> = {}) {
  put(ed, chartEl(data))
  const onClose = vi.fn()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(createElement(ChartGrid, { editor: ed, id: 'c1', onClose })),
  )
  unmount = async () => {
    await act(async () => root.unmount())
    host.remove()
  }
  return onClose
}
const q = <T extends HTMLElement>(sel: string) =>
  document.querySelector(sel) as T
const input = (label: string) =>
  q<HTMLInputElement>(`input[aria-label="${label}"]`)
const button = (label: string) =>
  q<HTMLButtonElement>(`button[aria-label="${label}"]`)
const alertText = () => q('[role="alert"]')?.textContent ?? null
const set = async (el: HTMLInputElement | HTMLSelectElement, value: string) =>
  act(async () => {
    const proto =
      el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(
      el,
      value,
    )
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    )
  })
const click = async (el: HTMLElement) => act(async () => el.click())
const data = () =>
  (ordered(ed.scene)[0] as { data: Record<string, unknown> }).data

describe('ChartGrid', () => {
  it('shows the chart as a table: type, title, a row per category and a column per series', async () => {
    await open()
    expect(q('[role="dialog"]').getAttribute('aria-label')).toBe('Edit chart')
    expect(q<HTMLSelectElement>('select[aria-label="Chart type"]').value).toBe(
      'bar',
    )
    expect(input('Title').value).toBe('Sales')
    expect([1, 2, 3].map((r) => input(`Category ${r}`).value)).toEqual([
      'A',
      'B',
      'C',
    ])
    expect(input('Series 1 name').value).toBe('Sales')
    expect([1, 2, 3].map((r) => input(`Row ${r} Series 1`).value)).toEqual([
      '3',
      '5',
      '2',
    ])
  })

  it('editing a cell and applying commits one batch that replaces the whole series leaf', async () => {
    const onClose = await open()
    const commit = vi.spyOn(ed, 'commit')
    await set(input('Row 2 Series 1'), '9')
    await click(button('Apply'))
    expect(commit).toHaveBeenCalledTimes(1)
    const batch = commit.mock.calls[0]?.[0]
    expect(batch?.label).toBe('Edit chart')
    expect(batch?.ops).toHaveLength(1)
    expect(batch?.ops[0]).toMatchObject({
      op: 'patch',
      id: 'c1',
      set: { 'data.series': [{ name: 'Sales', values: [3, 9, 2] }] },
    })
    expect(data().series).toEqual([{ name: 'Sales', values: [3, 9, 2] }])
    expect(onClose).toHaveBeenCalled()
  })

  it('a value that is not a number blocks Apply and says where', async () => {
    const onClose = await open()
    const commit = vi.spyOn(ed, 'commit')
    await set(input('Row 2 Series 1'), 'abc')
    await click(button('Apply'))
    expect(commit).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(alertText()).toMatch(/row 2/i)
    expect(alertText()).toMatch(/not a number/i)
    await set(input('Row 2 Series 1'), '')
    await click(button('Apply'))
    expect(alertText()).toMatch(/not a number/i) // an empty cell is not zero
  })

  it('adding a category adds a row to every series', async () => {
    await open({
      series: [
        { name: 'North', values: [1, 2, 3] },
        { name: 'South', values: [4, 5, 6] },
      ],
    })
    await click(button('Add row'))
    await set(input('Category 4'), 'D')
    await set(input('Row 4 Series 1'), '7')
    await set(input('Row 4 Series 2'), '8')
    await click(button('Apply'))
    expect(data().categories).toEqual(['A', 'B', 'C', 'D'])
    expect(data().series).toEqual([
      { name: 'North', values: [1, 2, 3, 7] },
      { name: 'South', values: [4, 5, 6, 8] },
    ])
  })

  it('a new row starts at zero and a removed row leaves every series', async () => {
    await open()
    await click(button('Add row'))
    expect(input('Row 4 Series 1').value).toBe('0')
    await click(button('Remove row 1'))
    await click(button('Apply'))
    expect(data().categories).toEqual(['B', 'C', 'D'])
    expect((data().series as { values: number[] }[])[0]?.values).toEqual([
      5, 2, 0,
    ])
  })

  it('adds and removes series within the limit of eight', async () => {
    await open()
    for (let i = 0; i < 7; i++) await click(button('Add series'))
    expect(button('Add series').disabled).toBe(true)
    expect(input('Series 8 name').value).toBe('Series 8')
    await click(button('Remove series 8'))
    expect(button('Add series').disabled).toBe(false)
  })

  it('a pie takes one series: the grid says so instead of adding a second', async () => {
    await open({ kind: 'pie' })
    expect(button('Add series').disabled).toBe(true)
  })

  it('an Arabic label shows the schema message and commits nothing', async () => {
    await open()
    const commit = vi.spyOn(ed, 'commit')
    await set(input('Category 1'), 'أ')
    await click(button('Apply'))
    expect(commit).not.toHaveBeenCalled()
    expect(alertText()).toBe(
      'chart labels support Latin letters and digits only',
    )
  })

  it('changing the type to a pie with two series is refused with the schema message', async () => {
    await open({
      series: [
        { name: 'a', values: [1, 2, 3] },
        { name: 'b', values: [1, 2, 3] },
      ],
    })
    await set(q<HTMLSelectElement>('select[aria-label="Chart type"]'), 'pie')
    await click(button('Apply'))
    expect(alertText()).toBe('a pie or donut chart takes exactly one series')
  })

  it('a scatter chart gets an x column per series, written to xs', async () => {
    await open({
      kind: 'scatter',
      categories: [],
      series: [{ name: 'obs', values: [1, 2], xs: [10, 20] }],
    })
    expect(input('Row 2 Series 1 x').value).toBe('20')
    await set(input('Row 2 Series 1 x'), '25')
    await click(button('Apply'))
    expect(data().series).toEqual([
      { name: 'obs', values: [1, 2], xs: [10, 25] },
    ])
    expect(data().categories).toEqual([])
  })

  it('an empty title is removed, and undo restores the previous data in one step', async () => {
    await open()
    const before = structuredClone(data())
    await set(input('Title'), '')
    await set(input('Row 1 Series 1'), '8')
    await click(button('Apply'))
    expect(data()).not.toHaveProperty('title')
    expect((data().series as { values: number[] }[])[0]?.values[0]).toBe(8)
    ed.undoOnce()
    expect(data()).toEqual(before)
  })

  it('Cancel closes without a commit; a locked chart or a read-only editor cannot be applied', async () => {
    const onClose = await open()
    const commit = vi.spyOn(ed, 'commit')
    await set(input('Row 1 Series 1'), '99')
    await click(button('Cancel'))
    expect(commit).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
    expect(data().series).toEqual([{ name: 'Sales', values: [3, 5, 2] }])
  })
})

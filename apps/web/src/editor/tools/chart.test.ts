// @vitest-environment jsdom
import { ordered } from '@whiteboard/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '../editor'
import { drag, ev, put, setup } from '../test-utils'

let ed: Editor
let done: () => void
beforeEach(() => {
  ;({ ed, done } = setup())
})
afterEach(() => done())

const els = () => ordered(ed.scene)
const click = (x = 300, y = 200) => {
  ed.setTool('chart')
  drag(ed.tool, [[x, y]])
}
const chartEl = (over: Record<string, unknown> = {}) =>
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
      categories: ['A', 'B', 'C'],
      series: [{ name: 'Sales', values: [3, 5, 2] }],
    },
    ...over,
  }) as never

describe('chart tool', () => {
  it('the key C selects the chart tool', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }))
    expect(ed.tool.id).toBe('chart')
  })

  it('a click adds one default bar chart centred on it, selects it, opens its grid and hands over to select', () => {
    const edit = vi.fn()
    ed.onEditChart = edit
    const commit = vi.spyOn(ed, 'commit')
    click(300, 200)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[0].label).toBe('Add Chart')
    expect(els()).toHaveLength(1)
    const [c] = els()
    expect(c).toMatchObject({
      type: 'chart',
      x: 60,
      y: 40,
      w: 480,
      h: 320,
      rotation: 0,
      locked: false,
      data: {
        kind: 'bar',
        categories: ['A', 'B', 'C'],
        series: [{ name: 'Series 1', values: [3, 5, 2] }],
      },
    })
    expect(c?.author).toEqual(ed.author)
    expect([...ed.selection]).toEqual([c?.id])
    expect(edit).toHaveBeenCalledWith(c?.id)
    expect(ed.tool.id).toBe('select')
  })

  it('stacks above what is already there', () => {
    put(ed, chartEl({ z: 'a5' }))
    click()
    const added = els().find((e) => e.id !== 'c1')
    expect((added?.z ?? '') > 'a5').toBe(true)
  })

  it('does nothing in a read-only editor', () => {
    ed.readOnly = true
    click()
    expect(els()).toHaveLength(0)
  })

  it('undo removes the chart in one step', () => {
    click()
    expect(els()).toHaveLength(1)
    ed.undoOnce()
    expect(els()).toHaveLength(0)
  })
})

describe('opening the grid on an existing chart', () => {
  it('a double-click with the select tool opens it', () => {
    put(ed, chartEl())
    const edit = vi.fn()
    ed.onEditChart = edit
    ed.setTool('select')
    ed.tool.onDoubleClick?.(ev(300, 250))
    expect(edit).toHaveBeenCalledWith('c1')
  })

  it('Enter on a single selected chart opens it', () => {
    put(ed, chartEl())
    const edit = vi.fn()
    ed.onEditChart = edit
    ed.setTool('select')
    ed.selection.add('c1')
    expect(
      ed.tool.onKey?.(new KeyboardEvent('keydown', { key: 'Enter' })),
    ).toBe(true)
    expect(edit).toHaveBeenCalledWith('c1')
  })

  it('a locked chart, a read-only editor and a missing id open nothing', () => {
    put(ed, chartEl({ locked: true }))
    const edit = vi.fn()
    ed.onEditChart = edit
    ed.editChart('c1')
    ed.editChart('nope')
    ed.readOnly = true
    ed.editChart('c1')
    expect(edit).not.toHaveBeenCalled()
  })
})

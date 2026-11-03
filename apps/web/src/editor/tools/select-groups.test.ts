// @vitest-environment jsdom
import { type Element, ordered } from '@whiteboard/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '../editor'
import { drag, ev, key, mk, put, setup } from '../test-utils'

let ed: Editor
let done: () => void
beforeEach(() => {
  ;({ ed, done } = setup())
  ed.setTool('select')
})
afterEach(() => done())

const get = (id: string) => ed.scene.els.get(id) as Element
const sel = (...ids: string[]) => {
  ed.selection.clear()
  for (const i of ids) ed.selection.add(i)
}
const ids = () => [...ed.selection].sort()
const groupEl = () => ordered(ed.scene).find((e) => e.type === 'group')
const ctrl = (k: string, shift = false) =>
  key(ed.tool, k, { ctrlKey: true, shiftKey: shift })
// a at 0..100 x 0..60, b at 300..400 x 0..60, c far away
const three = () => put(ed, mk('a', 0, 0), mk('b', 300, 0), mk('c', 600, 300))
const grouped = () => {
  three()
  sel('a', 'b')
  ctrl('g')
}

describe('groups in the select tool', () => {
  it('Ctrl+G groups the selection in one batch, and one undo takes it back', () => {
    three()
    sel('a', 'b')
    const commit = vi.spyOn(ed, 'commit')
    expect(ctrl('g')).toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[0].label).toBe('Group')
    const g = groupEl() as Element
    expect(g).toMatchObject({ x: 0, y: 0, w: 400, h: 60 })
    expect(get('a').parentId).toBe(g.id)
    expect(ids()).toEqual(['a', 'b']) // the selection stays the members
    ed.undoOnce()
    expect(groupEl()).toBeUndefined()
    expect(get('a').parentId).toBeUndefined()
  })

  it('does nothing for one element or a locked member', () => {
    put(ed, mk('a', 0, 0), mk('k', 300, 0, 100, 60, { locked: true }))
    sel('a')
    ctrl('g')
    sel('a', 'k')
    ctrl('g')
    expect(groupEl()).toBeUndefined()
  })

  it('clicking a member selects the whole group; shift-click toggles the whole group', () => {
    grouped()
    sel()
    drag(ed.tool, [[10, 10]])
    expect(ids()).toEqual(['a', 'b'])
    drag(ed.tool, [[610, 310]]) // c alone
    expect(ids()).toEqual(['c'])
    drag(ed.tool, [[310, 10]], { shift: true })
    expect(ids()).toEqual(['a', 'b', 'c'])
    drag(ed.tool, [[10, 10]], { shift: true })
    expect(ids()).toEqual(['c'])
  })

  it('the group itself is never hit or selected', () => {
    grouped()
    sel()
    drag(ed.tool, [[200, 30]]) // between a and b, inside the group box
    expect(ed.selection.size).toBe(0)
  })

  it('a marquee over one member selects the whole group', () => {
    grouped()
    sel()
    drag(ed.tool, [
      [-20, -20],
      [120, 80],
    ])
    expect(ids()).toEqual(['a', 'b'])
  })

  it('dragging a member moves the group and its box in one batch, one undo restores', () => {
    grouped()
    const g = groupEl() as Element
    sel()
    const commit = vi.spyOn(ed, 'commit')
    drag(ed.tool, [
      [10, 10],
      [60, 50],
    ])
    expect(commit).toHaveBeenCalledTimes(1)
    expect([get('a').x, get('a').y, get('b').x, get('b').y]).toEqual([
      50, 40, 350, 40,
    ])
    expect([get(g.id).x, get(g.id).y]).toEqual([50, 40])
    expect(get('c').x).toBe(600)
    ed.undoOnce()
    expect([get('a').x, get('b').x, get(g.id).x]).toEqual([0, 300, 0])
  })

  it('Delete removes the members and the group; one undo brings all back', () => {
    grouped()
    sel('a', 'b')
    key(ed.tool, 'Delete')
    expect(ordered(ed.scene).map((e) => e.id)).toEqual(['c'])
    ed.undoOnce()
    expect(ordered(ed.scene)).toHaveLength(4)
    expect(groupEl()).toBeDefined()
  })

  it('Ctrl+Shift+G ungroups one level; then a click picks one element', () => {
    grouped()
    sel('a', 'b')
    expect(ctrl('g', true)).toBe(true)
    expect(groupEl()).toBeUndefined()
    sel()
    drag(ed.tool, [[10, 10]])
    expect(ids()).toEqual(['a'])
  })
})

describe('resizing a selection of several', () => {
  // the selection box is 0..400 x 0..60; its se handle is at (400, 60)
  it('dragging a corner scales every member about the opposite corner, in one batch and one undo', () => {
    three()
    sel('a', 'b')
    const commit = vi.spyOn(ed, 'commit')
    drag(ed.tool, [
      [400, 60],
      [800, 120],
    ])
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[0].label).toBe('Resize')
    expect(get('a')).toMatchObject({ x: 0, y: 0, w: 200, h: 120 })
    expect(get('b')).toMatchObject({ x: 600, y: 0, w: 200, h: 120 })
    ed.undoOnce()
    expect(get('b')).toMatchObject({ x: 300, w: 100, h: 60 })
  })

  it('a group resizes the same way, and a selection with a locked member has no handles', () => {
    grouped()
    sel()
    drag(ed.tool, [[10, 10]]) // selects the group's members
    drag(ed.tool, [
      [400, 60],
      [800, 60],
    ]) // e-ish: sx 2 on the right edge corner, sy 1
    expect(get('b').x).toBe(600)
    ed.undoOnce()
    put(ed, mk('k', 0, 400, 100, 60, { locked: true }))
    sel('c', 'k')
    const commit = vi.spyOn(ed, 'commit')
    drag(ed.tool, [
      [700, 460],
      [900, 560],
    ]) // where the se handle would be: a marquee instead
    expect(commit).not.toHaveBeenCalled()
  })

  it('draws handles for the selection box (and no rotate handle) in the overlay', () => {
    three()
    sel('a', 'b')
    const fills = vi.fn()
    const ctx = new Proxy(
      {},
      {
        get: (_t, k) => (k === 'fillRect' ? fills : () => {}),
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D
    ed.tool.drawOverlay?.(ctx)
    expect(fills).toHaveBeenCalledTimes(8)
  })
})

describe('snap while moving', () => {
  // a is at 0..100; b at 300..400 x 200..260 is dragged so its left edge ends 4 px from a's
  it('a move snaps an edge to another element within 6 px, and the batch carries the snapped position', () => {
    put(ed, mk('a', 0, 0), mk('b', 300, 200))
    sel()
    drag(ed.tool, [
      [310, 210],
      [14, 210],
    ]) // dx -296: b.x would be 4
    expect(get('b').x).toBe(0)
    expect(get('b').y).toBe(200)
  })

  it('Alt bypasses it', () => {
    put(ed, mk('a', 0, 0), mk('b', 300, 200))
    sel()
    drag(
      ed.tool,
      [
        [310, 210],
        [14, 210],
      ],
      { alt: true },
    )
    expect(get('b').x).toBe(4)
  })

  it('does not snap to what is moving with it, and a move far from anything is exact', () => {
    put(ed, mk('a', 0, 0), mk('b', 300, 200))
    sel('a', 'b')
    drag(ed.tool, [
      [10, 10],
      [24, 10],
    ])
    expect([get('a').x, get('b').x]).toEqual([14, 314])
  })

  it('draws a guide line while a move is snapped', () => {
    put(ed, mk('a', 0, 0), mk('b', 300, 200))
    sel()
    ed.tool.onPointerDown(ev(310, 210))
    ed.tool.onPointerMove(ev(14, 210))
    const lines = vi.fn()
    const ctx = new Proxy(
      {},
      { get: (_t, k) => (k === 'lineTo' ? lines : () => {}), set: () => true },
    ) as unknown as CanvasRenderingContext2D
    ed.tool.drawOverlay?.(ctx)
    expect(lines).toHaveBeenCalled()
    ed.tool.onPointerUp(ev(14, 210))
  })
})

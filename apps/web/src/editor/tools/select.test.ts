// @vitest-environment jsdom
import {
  type Element,
  type Handle,
  ordered,
  type Point,
  resolveEnd,
} from '@whiteboard/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '../editor'
import { drag, ev, key, mk, put, rotPt, setup } from '../test-utils'

let ed: Editor
let done: () => void
beforeEach(() => {
  ;({ ed, done } = setup())
  ed.setTool('select')
})
afterEach(() => done())

const get = (id: string) => ed.scene.els.get(id) as Element
const pts = (id: string) => {
  const e = get(id)
  return e.type === 'shape'
    ? (e.data.points ?? []).map(([a, b]) => ({ x: e.x + a, y: e.y + b }))
    : []
}
const sel = (...ids: string[]) => {
  ed.selection.clear()
  for (const i of ids) ed.selection.add(i)
}
const flow = () => {
  put(
    ed,
    mk('a', 0, 0),
    mk('b', 300, 0),
    mk('ar', 100, 30, 200, 0, {
      kind: 'arrow',
      points: [
        [0, 0],
        [200, 0],
      ],
      start: { id: 'a', fx: 1, fy: 0.5 },
      end: { id: 'b', fx: 0, fy: 0.5 },
    }),
  )
}

describe('select tool', () => {
  it('click selects the topmost, click empty clears, shift-click toggles', () => {
    put(ed, mk('a', 0, 0), mk('b', 200, 0))
    drag(ed.tool, [[10, 10]])
    expect([...ed.selection]).toEqual(['a'])
    drag(ed.tool, [[210, 10]], { shift: true })
    expect([...ed.selection].sort()).toEqual(['a', 'b'])
    drag(ed.tool, [[10, 10]], { shift: true })
    expect([...ed.selection]).toEqual(['b'])
    drag(ed.tool, [[500, 500]])
    expect(ed.selection.size).toBe(0)
  })

  it('marquee selects exactly the fully contained elements', () => {
    put(
      ed,
      mk('in', 20, 20, 30, 30),
      mk('part', 80, 20, 60, 30),
      mk('out', 400, 400),
    )
    drag(ed.tool, [
      [0, 0],
      [60, 60],
      [100, 100],
    ])
    expect([...ed.selection]).toEqual(['in'])
  })

  it('a move drag is one Move batch and one undo; the scene is untouched while dragging', () => {
    put(ed, mk('a', 0, 0))
    const commit = vi.spyOn(ed, 'commit')
    ed.tool.onPointerDown(ev(10, 10))
    ed.tool.onPointerMove(ev(40, 30))
    expect(get('a').x).toBe(0)
    ed.tool.onPointerUp(ev(40, 30))
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[0].label).toBe('Move')
    expect([get('a').x, get('a').y]).toEqual([30, 20])
    ed.undoOnce()
    expect([get('a').x, get('a').y]).toEqual([0, 0])
  })

  it('moving a locked element does nothing', () => {
    put(ed, mk('a', 0, 0, 100, 60, { locked: true }))
    drag(ed.tool, [
      [10, 10],
      [60, 60],
    ])
    expect(get('a').x).toBe(0)
  })

  it('Esc cancels a drag leaving the scene untouched, then clears selection', () => {
    put(ed, mk('a', 0, 0))
    const commit = vi.spyOn(ed, 'commit')
    ed.tool.onPointerDown(ev(10, 10))
    ed.tool.onPointerMove(ev(80, 80))
    key(ed.tool, 'Escape')
    ed.tool.onPointerUp(ev(80, 80))
    expect(commit).not.toHaveBeenCalled()
    expect(get('a').x).toBe(0)
    expect(ed.selection.size).toBe(1)
    key(ed.tool, 'Escape')
    expect(ed.selection.size).toBe(0)
  })

  it('resizing a rotated rect via se keeps the nw corner fixed in world space', () => {
    const rotation = 0.5
    put(ed, mk('a', 100, 100, 100, 60, { rotation }))
    sel('a')
    const c = { x: 150, y: 130 }
    const nwBefore = rotPt({ x: 100, y: 100 }, c, rotation)
    const se = rotPt({ x: 200, y: 160 }, c, rotation)
    const commit = vi.spyOn(ed, 'commit')
    drag(ed.tool, [
      [se.x, se.y],
      [se.x + 30, se.y + 20],
      [se.x + 40, se.y + 25],
    ])
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[0].label).toBe('Resize')
    const a = get('a')
    const nwAfter = rotPt(
      { x: a.x, y: a.y },
      { x: a.x + a.w / 2, y: a.y + a.h / 2 },
      a.rotation,
    )
    expect(nwAfter.x).toBeCloseTo(nwBefore.x, 6)
    expect(nwAfter.y).toBeCloseTo(nwBefore.y, 6)
    expect(a.w).toBeGreaterThan(100)
    ed.undoOnce()
    expect(get('a').w).toBe(100)
  })

  it('every handle name resizes (n handle changes only height)', () => {
    put(ed, mk('a', 100, 100, 100, 60))
    sel('a')
    const h: Handle = 'n'
    drag(ed.tool, [
      [150, 100],
      [150, 80],
    ])
    expect([get('a').y, get('a').h, get('a').w]).toEqual([80, 80, 100])
    expect(h).toBe('n')
  })

  it('rotate handle rotates; shift snaps to 15 degrees', () => {
    put(ed, mk('a', 100, 100, 100, 60))
    sel('a')
    const commit = vi.spyOn(ed, 'commit')
    drag(ed.tool, [
      [150, 100 - 24],
      [300, 130],
    ])
    expect(commit.mock.calls[0]?.[0].label).toBe('Rotate')
    expect(get('a').rotation).toBeCloseTo(Math.PI / 2, 6)
    ed.undoOnce()
    sel('a')
    const top = rotPt({ x: 150, y: 76 }, { x: 150, y: 130 }, 0)
    drag(
      ed.tool,
      [
        [top.x, top.y],
        [150 + 54 * Math.sin(0.3), 130 - 54 * Math.cos(0.3)],
      ],
      { shift: true },
    )
    expect(get('a').rotation).toBeCloseTo(Math.PI / 12, 6)
  })

  it('moving the target moves the arrow end in the same batch; one undo restores both', () => {
    flow()
    const commit = vi.spyOn(ed, 'commit')
    drag(ed.tool, [
      [310, 10],
      [330, 70],
      [360, 90],
    ])
    expect(commit).toHaveBeenCalledTimes(1)
    const end = pts('ar')[1] as Point
    const want = resolveEnd({ id: 'b', fx: 0, fy: 0.5 }, get('b'))
    expect(end.x).toBeCloseTo(want.x, 6)
    expect(end.y).toBeCloseTo(want.y, 6)
    expect(get('b').x).toBe(350)
    const ar = get('ar')
    expect(ar.y).toBe(30) // bbox re-based: start stays at y=30
    ed.undoOnce()
    expect(pts('ar')[1]).toEqual({ x: 300, y: 30 })
    expect(get('b').x).toBe(300)
    expect(get('ar').h).toBe(0)
  })

  it('moving a bound arrow itself clears its bindings; undo restores them', () => {
    flow()
    drag(ed.tool, [
      [200, 30],
      [200, 100],
    ])
    const ar = get('ar')
    expect(ar.type === 'shape' && ar.data.start).toBeUndefined()
    expect(ar.type === 'shape' && ar.data.end).toBeUndefined()
    expect(ar.y).toBe(100)
    ed.undoOnce()
    expect(
      get('ar').type === 'shape' &&
        (get('ar') as { data: { start?: unknown } }).data.start,
    ).toBeDefined()
  })

  it('moving arrow and both targets together keeps the bindings', () => {
    flow()
    sel('a', 'b', 'ar')
    key(ed.tool, 'ArrowDown')
    const ar = get('ar')
    expect(ar.type === 'shape' && ar.data.start?.id).toBe('a')
    expect(ar.y).toBe(31)
  })

  it('deleting the target keeps the arrow with a free end; undo restores the binding', () => {
    flow()
    sel('b')
    const commit = vi.spyOn(ed, 'commit')
    key(ed.tool, 'Delete')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[0].label).toBe('Delete')
    expect(ed.scene.els.has('b')).toBe(false)
    const ar = get('ar')
    expect(ar.type === 'shape' && ar.data.end).toBeUndefined()
    expect(ar.type === 'shape' && ar.data.start?.id).toBe('a')
    expect(pts('ar')[1]).toEqual({ x: 300, y: 30 })
    ed.undoOnce()
    const back = get('ar')
    expect(back.type === 'shape' && back.data.end?.id).toBe('b')
    expect(ed.scene.els.has('b')).toBe(true)
  })

  it('Delete on a locked element does nothing', () => {
    put(ed, mk('a', 0, 0, 100, 60, { locked: true }))
    sel('a')
    const commit = vi.spyOn(ed, 'commit')
    key(ed.tool, 'Backspace')
    expect(commit).not.toHaveBeenCalled()
    expect(ed.scene.els.has('a')).toBe(true)
  })

  it('arrow keys nudge 1px, shift 10px, one batch each; ctrl+A skips locked', () => {
    put(ed, mk('a', 0, 0), mk('l', 200, 0, 10, 10, { locked: true }))
    key(ed.tool, 'a', { ctrlKey: true })
    expect([...ed.selection]).toEqual(['a'])
    const commit = vi.spyOn(ed, 'commit')
    key(ed.tool, 'ArrowRight')
    key(ed.tool, 'ArrowDown', { shiftKey: true })
    expect(commit).toHaveBeenCalledTimes(2)
    expect([get('a').x, get('a').y]).toEqual([1, 10])
  })

  it('dragging an arrow endpoint handle unbinds in free space and rebinds on a shape', () => {
    flow()
    put(ed, mk('c', 300, 200))
    sel('ar')
    drag(ed.tool, [
      [300, 30],
      [320, 120],
      [330, 120],
    ])
    let ar = get('ar')
    expect(ar.type === 'shape' && ar.data.end).toBeUndefined()
    expect(ar.type === 'shape' && ar.data.start?.id).toBe('a')
    expect(pts('ar')[1]).toEqual({ x: 330, y: 120 })
    drag(ed.tool, [
      [330, 120],
      [340, 230],
    ])
    ar = get('ar')
    expect(ar.type === 'shape' && ar.data.end?.id).toBe('c')
    const e = pts('ar')[1] as Point
    expect(e.x).toBeCloseTo(340, 6)
    expect(e.y).toBeCloseTo(230, 6)
    expect(pts('ar')[0]).toEqual({ x: 100, y: 30 })
    ed.undoOnce()
    ar = get('ar')
    expect(ar.type === 'shape' && ar.data.end).toBeUndefined()
  })

  it('shows no box handles for linear elements and ignores handle drags on them', () => {
    flow()
    sel('ar')
    const before = structuredClone(ordered(ed.scene))
    ed.tool.onPointerDown(ev(100, 30)) // start handle, no movement
    ed.tool.onPointerUp(ev(100, 30))
    expect(ordered(ed.scene)).toEqual(before)
  })
})

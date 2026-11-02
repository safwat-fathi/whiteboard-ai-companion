// @vitest-environment jsdom
import { ordered } from '@whiteboard/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '../editor'
import { drag, mk, put, setup } from '../test-utils'

let ed: Editor
let done: () => void
beforeEach(() => {
  ;({ ed, done } = setup())
})
afterEach(() => done())

const els = () => ordered(ed.scene)

describe('shape tools', () => {
  it('drag-create a rect is one add batch; undoOnce removes it; select tool takes over', () => {
    const commit = vi.spyOn(ed, 'commit')
    ed.setTool('rect')
    drag(ed.tool, [
      [10, 20],
      [60, 40],
      [110, 80],
    ])
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[0].label).toBe('Add Rectangle')
    const [r] = els()
    expect([r?.x, r?.y, r?.w, r?.h]).toEqual([10, 20, 100, 60])
    expect(ed.tool.id).toBe('select')
    expect([...ed.selection]).toEqual([r?.id])
    ed.undoOnce()
    expect(els()).toEqual([])
  })

  it('dragging up-left normalises the box; new shapes go on top', () => {
    put(ed, mk('a', 0, 0))
    ed.setTool('ellipse')
    drag(ed.tool, [
      [100, 100],
      [40, 30],
    ])
    const [a, e] = els()
    expect(a?.id).toBe('a')
    expect([e?.x, e?.y, e?.w, e?.h]).toEqual([40, 30, 60, 70])
    expect((e?.z ?? '') > (a?.z ?? '')).toBe(true)
  })

  it('a click creates a default 120x80 shape centred on the pointer', () => {
    ed.setTool('diamond')
    drag(ed.tool, [[200, 200]])
    const [d] = els()
    expect([d?.x, d?.y, d?.w, d?.h]).toEqual([140, 160, 120, 80])
    expect(d?.type === 'shape' && d.data.kind).toBe('diamond')
  })

  it('a click with line/arrow makes a 120 long horizontal one; triangle factory exists', () => {
    ed.setTool('arrow')
    drag(ed.tool, [[10, 10]])
    const [a] = els()
    expect(a?.type === 'shape' && a.data.points).toEqual([
      [0, 0],
      [120, 0],
    ])
    expect(a?.type === 'shape' && a.data.arrowheads).toEqual({
      start: false,
      end: true,
    })
    expect(ed.tools.triangle?.id).toBe('triangle')
  })

  it('an arrow dropped from one shape onto another stores two bindings', () => {
    put(ed, mk('a', 0, 0, 100, 60), mk('b', 300, 0, 100, 60))
    ed.setTool('arrow')
    drag(ed.tool, [
      [100, 30],
      [200, 30],
      [300, 30],
    ])
    const arrow = els().find(
      (e) => e.type === 'shape' && e.data.kind === 'arrow',
    )
    if (arrow?.type !== 'shape') throw new Error('no arrow')
    expect(arrow.data.start).toEqual({ id: 'a', fx: 1, fy: 0.5 })
    expect(arrow.data.end).toEqual({ id: 'b', fx: 0, fy: 0.5 })
    expect(arrow.data.points).toEqual([
      [0, 0],
      [200, 0],
    ])
  })

  it('an arrow ending in empty space has no binding; Esc cancels creation', () => {
    ed.setTool('line')
    drag(ed.tool, [
      [0, 0],
      [50, 50],
    ])
    const [l] = els()
    expect(l?.type === 'shape' && l.data.end).toBeUndefined()
    ed.setTool('rect')
    ed.tool.onPointerDown({
      ...{ screen: { x: 0, y: 0 }, world: { x: 0, y: 0 } },
      shift: false,
      alt: false,
      button: 0,
      pointerType: 'mouse',
    })
    ed.tool.onCancel?.()
    ed.tool.onPointerUp({
      screen: { x: 90, y: 90 },
      world: { x: 90, y: 90 },
      shift: false,
      alt: false,
      button: 0,
      pointerType: 'mouse',
    })
    expect(els()).toHaveLength(1)
  })

  it('tool keys R O D L A are registered', () => {
    const k = Object.values(ed.tools).map((t) => t.key)
    for (const c of ['v', 'r', 'o', 'd', 'l', 'a']) expect(k).toContain(c)
  })
})

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

const ids = () =>
  ordered(ed.scene)
    .map((e) => e.id)
    .sort()
const overlay = () =>
  document.querySelectorAll('canvas')[1] as HTMLCanvasElement

type Init = {
  type?: 'mouse' | 'pen' | 'touch'
  id?: number
  button?: number
  buttons?: number
  t?: number
}
/** A real PointerEvent on the overlay; `t` is its `timeStamp` (the palm rejection reads it). */
const pe = (kind: string, x: number, y: number, o: Init = {}) => {
  const e = new PointerEvent(kind, {
    clientX: x,
    clientY: y,
    pointerType: o.type ?? 'mouse',
    pointerId: o.id ?? 1,
    button: o.button ?? 0,
    buttons: o.buttons ?? 0,
    bubbles: true,
  })
  if (o.t !== undefined)
    Object.defineProperty(e, 'timeStamp', { value: o.t, configurable: true })
  overlay().dispatchEvent(e)
}
/** down, one move per following point, up at the last. */
const sweep = (pts: [number, number][], o: Init = {}) => {
  const [first, ...rest] = pts as [[number, number], ...[number, number][]]
  pe('pointerdown', ...first, o)
  for (const p of rest) pe('pointermove', ...p, o)
  const last = rest.at(-1) ?? first
  pe('pointerup', ...last, o)
}
const key = (k: string, init: KeyboardEventInit = {}) =>
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: k,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  )
/** The overlay context the editor hands to `drawOverlay`, recording what is stroked. */
const strokes = () => {
  const calls: string[] = []
  const ctx = new Proxy(
    {},
    { get: (_t, k: string) => () => calls.push(k), set: () => true },
  ) as unknown as CanvasRenderingContext2D
  ed.tools.eraser?.drawOverlay?.(ctx)
  return calls.filter((c) => c === 'stroke').length
}

// Five 100x60 rectangles in a row, 100 apart: a, b, c, d, e at x = 0, 200, 400, 600, 800.
const row = () =>
  put(ed, ...['a', 'b', 'c', 'd', 'e'].map((id, i) => mk(id, i * 200, 0)))

describe('eraser tool', () => {
  beforeEach(() => ed.setTool('eraser'))

  it('a drag across 3 of 5 elements erases exactly those in one batch; one undo restores all', () => {
    row()
    const commit = vi.spyOn(ed, 'commit')
    sweep([
      [50, 30],
      [250, 30],
      [450, 30],
    ])
    expect(commit).toHaveBeenCalledTimes(1)
    const batch = commit.mock.calls[0]?.[0]
    expect(batch?.label).toBe('Erase 3 elements')
    expect(batch?.ops.map((o) => o.op)).toEqual(['remove', 'remove', 'remove'])
    expect(ids()).toEqual(['d', 'e'])
    ed.undoOnce()
    expect(ids()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('walks the segment between samples: a single long move still erases what lies between', () => {
    row()
    sweep([
      [50, 30],
      [450, 30],
    ])
    expect(ids()).toEqual(['d', 'e'])
  })

  it('erases what the AI drew too', () => {
    put(ed, { ...mk('ai', 0, 0), author: { kind: 'agent', id: 'tutor' } })
    sweep([[50, 30]])
    expect(ids()).toEqual([])
  })

  it('a single press erases the element under it, labelled for one element', () => {
    row()
    const commit = vi.spyOn(ed, 'commit')
    sweep([[250, 30]])
    expect(commit.mock.calls[0]?.[0].label).toBe('Erase 1 element')
    expect(ids()).toEqual(['a', 'c', 'd', 'e'])
  })

  it('a drag over nothing commits nothing', () => {
    row()
    const commit = vi.spyOn(ed, 'commit')
    sweep([
      [120, 200],
      [900, 200],
    ])
    expect(commit).not.toHaveBeenCalled()
    expect(ids()).toHaveLength(5)
  })

  it('a locked element is not even marked as a candidate', () => {
    put(ed, mk('l', 0, 0, 100, 60, { locked: true }))
    pe('pointerdown', 50, 30)
    pe('pointermove', 60, 30)
    expect(strokes()).toBe(0)
  })

  it('a locked element survives, whatever the drag crosses', () => {
    row()
    ed.commit({
      batchId: 'lock',
      label: 'Lock',
      ops: [{ op: 'patch', id: 'b', set: { locked: true } }],
    })
    sweep([
      [50, 30],
      [450, 30],
    ])
    expect(ids()).toEqual(['b', 'd', 'e'])
  })

  it('an arrow attached to an erased shape stays, unattached', () => {
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
    sweep([
      [50, -10],
      [50, 70],
    ]) // down the middle of a, nowhere near the arrow
    expect(ids()).toEqual(['ar', 'b'])
    const arrow = ed.scene.els.get('ar')
    if (arrow?.type !== 'shape') throw new Error('arrow gone')
    expect(arrow.data.start).toBeUndefined()
    expect(arrow.data.end).toEqual({ id: 'b', fx: 0, fy: 0.5 })
    ed.undoOnce()
    expect(ids()).toEqual(['a', 'ar', 'b'])
  })

  it('450 hits are two batches of 400 and 50, undone one step at a time', () => {
    put(
      ed,
      ...Array.from({ length: 450 }, (_, i) => mk(`e${i}`, i * 20, 0, 10, 10)),
    )
    const commit = vi.spyOn(ed, 'commit')
    sweep([
      [-5, 5],
      [450 * 20, 5],
    ])
    expect(commit.mock.calls.map(([b]) => [b.label, b.ops.length])).toEqual([
      ['Erase 400 elements', 400],
      ['Erase 50 elements', 50],
    ])
    expect(ids()).toEqual([])
    ed.undoOnce()
    expect(ids()).toHaveLength(50)
    ed.undoOnce()
    expect(ids()).toHaveLength(450)
  })

  it('the tolerance is 8 / zoom world units', () => {
    const near = (zoom: number) => {
      ed.camera = { x: 0, y: 0, zoom }
      put(ed, mk('t', 100, 0, 100, 60))
      drag(ed.tool, [[95, 30]]) // 5 world units left of the left edge
      const gone = !ed.scene.els.has('t')
      if (!gone)
        ed.commit({
          batchId: 'x',
          label: 'x',
          ops: [{ op: 'remove', id: 't' }],
        })
      return gone
    }
    expect(near(1)).toBe(true) // 5 <= 8 (plus half the 2 wide stroke)
    expect(near(4)).toBe(false) // 5 > 8 / 4
  })

  it('previews the candidates on the overlay while dragging, and nothing otherwise', () => {
    row()
    expect(strokes()).toBe(0)
    pe('pointerdown', 50, 30)
    pe('pointermove', 250, 30)
    expect(strokes()).toBeGreaterThan(0)
    pe('pointerup', 250, 30)
    expect(strokes()).toBe(0)
  })

  it('Escape drops the drag: no batch, nothing erased, even when the pointer carries on', () => {
    row()
    const commit = vi.spyOn(ed, 'commit')
    pe('pointerdown', 50, 30)
    pe('pointermove', 250, 30)
    key('Escape')
    expect(strokes()).toBe(0)
    pe('pointermove', 450, 30)
    pe('pointerup', 450, 30)
    expect(commit).not.toHaveBeenCalled()
    expect(ids()).toHaveLength(5)
    expect(ed.tool.id).toBe('eraser')
  })

  it('Escape with no drag under way is not claimed', () => {
    expect(
      ed.tool.onKey?.(new KeyboardEvent('keydown', { key: 'Escape' })),
    ).toBeFalsy()
  })

  it('pointercancel drops the drag', () => {
    row()
    const commit = vi.spyOn(ed, 'commit')
    pe('pointerdown', 50, 30)
    pe('pointermove', 250, 30)
    pe('pointercancel', 250, 30)
    pe('pointerup', 250, 30)
    expect(commit).not.toHaveBeenCalled()
    expect(ids()).toHaveLength(5)
  })

  it('switching tools mid-drag drops it', () => {
    row()
    pe('pointerdown', 50, 30)
    pe('pointermove', 250, 30)
    ed.setTool('select')
    pe('pointerup', 250, 30)
    expect(ids()).toHaveLength(5)
  })

  it('only the primary button erases', () => {
    row()
    pe('pointerdown', 50, 30)
    pe('pointerup', 50, 30)
    expect(ids()).toHaveLength(4)
    const e = new PointerEvent('pointerdown', {
      clientX: 250,
      clientY: 30,
      button: 2,
      bubbles: true,
    })
    overlay().dispatchEvent(e)
    pe('pointerup', 250, 30)
    expect(ids()).toHaveLength(4)
  })

  it('a touch landing within 600 ms of a pen event is a palm and erases nothing', () => {
    row()
    pe('pointermove', 900, 300, { type: 'pen', t: 1000 })
    sweep([[50, 30]], { type: 'touch', id: 2, t: 1100 })
    expect(ids()).toHaveLength(5)
  })
})

describe('E selects the eraser', () => {
  it('declares plain E and picks the tool, with or without Shift', () => {
    expect([ed.tools.eraser?.key, ed.tools.eraser?.shift]).toEqual([
      'e',
      undefined,
    ])
    key('e')
    expect(ed.tool.id).toBe('eraser')
    ed.setTool('select')
    key('E', { shiftKey: true, code: 'KeyE' })
    expect(ed.tool.id).toBe('eraser')
  })

  it('no other tool owns E', () => {
    expect(
      Object.values(ed.tools)
        .filter((t) => t.key === 'e')
        .map((t) => t.id),
    ).toEqual(['eraser'])
  })
})

describe('pen barrel button', () => {
  beforeEach(() => ed.setTool('pen'))

  it('a pen pointerdown with buttons 32 erases while the pen tool stays active', () => {
    row()
    const commit = vi.spyOn(ed, 'commit')
    sweep(
      [
        [50, 30],
        [250, 30],
        [450, 30],
      ],
      { type: 'pen', button: 5, buttons: 32 },
    )
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]?.[0].label).toBe('Erase 3 elements')
    expect(ids()).toEqual(['d', 'e'])
    expect(ed.tool.id).toBe('pen')
  })

  it('the next pen gesture without the button draws again', () => {
    row()
    sweep([[50, 30]], { type: 'pen', button: 5, buttons: 32 })
    expect(ids()).toHaveLength(4)
    sweep(
      [
        [0, 200],
        [100, 260],
      ],
      { type: 'pen', buttons: 0 },
    )
    const kinds = ordered(ed.scene).map((e) => e.type)
    expect(kinds.filter((t) => t === 'freehand')).toHaveLength(1)
    expect(ids()).toHaveLength(5)
  })

  it('a pen press without the button starts afresh even when the last release was lost', () => {
    row()
    pe('pointerdown', 50, 30, { type: 'pen', button: 5, buttons: 32 })
    pe('pointermove', 60, 30, { type: 'pen', button: 5, buttons: 32 })
    sweep(
      [
        [0, 200],
        [100, 260],
      ],
      { type: 'pen' },
    )
    expect(ordered(ed.scene).map((e) => e.type)).toContain('freehand')
    expect(ids().filter((i) => i.length === 1)).toHaveLength(5)
  })

  it('a mouse with buttons 32 draws as usual', () => {
    sweep(
      [
        [0, 200],
        [100, 260],
      ],
      { type: 'mouse', buttons: 32 },
    )
    expect(ordered(ed.scene).map((e) => e.type)).toEqual(['freehand'])
  })

  it('works over the hand tool, which would otherwise pan with a pen', () => {
    row()
    ed.setTool('hand')
    sweep([[50, 30]], { type: 'pen', button: 5, buttons: 32 })
    expect(ids()).toHaveLength(4)
    expect(ed.tool.id).toBe('hand')
  })

  it('Escape and pointercancel cancel the routed gesture', () => {
    row()
    const commit = vi.spyOn(ed, 'commit')
    pe('pointerdown', 50, 30, { type: 'pen', button: 5, buttons: 32 })
    pe('pointermove', 250, 30, { type: 'pen', button: 5, buttons: 32 })
    key('Escape')
    pe('pointerup', 250, 30, { type: 'pen' })
    pe('pointerdown', 50, 30, { type: 'pen', button: 5, buttons: 32 })
    pe('pointercancel', 50, 30, { type: 'pen' })
    pe('pointerup', 50, 30, { type: 'pen' })
    expect(commit).not.toHaveBeenCalled()
    expect(ids()).toHaveLength(5)
  })
})

describe('read-only', () => {
  it('ignores the tool: no batch, and the key does not even select it', () => {
    row()
    ed.setTool('eraser')
    const commit = vi.spyOn(ed, 'commit')
    ed.readOnly = true
    sweep([
      [50, 30],
      [450, 30],
    ])
    expect(commit).not.toHaveBeenCalled()
    expect(ids()).toHaveLength(5)
    ed.setTool('hand')
    key('e')
    expect(ed.tool.id).toBe('hand')
  })

  it('the pen barrel button erases nothing either', () => {
    row()
    ed.setTool('hand')
    ed.readOnly = true
    const commit = vi.spyOn(ed, 'commit')
    sweep([[50, 30]], { type: 'pen', button: 5, buttons: 32 })
    expect(commit).not.toHaveBeenCalled()
    expect(ids()).toHaveLength(5)
  })
})

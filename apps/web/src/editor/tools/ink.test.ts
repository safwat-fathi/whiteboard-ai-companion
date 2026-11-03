// @vitest-environment jsdom
import { ordered } from '@whiteboard/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '../editor'
import { ev, mk, put, setup, key as toolKey } from '../test-utils'

let ed: Editor
let done: () => void
beforeEach(() => {
  ;({ ed, done } = setup())
})
afterEach(() => done())

const els = () => ordered(ed.scene)
const overlay = () =>
  document.querySelectorAll('canvas')[1] as HTMLCanvasElement

type P = [number, number, number?] // x, y, pressure
type Init = {
  type?: 'mouse' | 'pen' | 'touch'
  id?: number
  pressure?: number
  button?: number
  /** The event's `timeStamp` (ms); the Editor's palm rejection reads it. */
  t?: number
  /** `getCoalescedEvents()` of this event (jsdom has none). */
  coalesced?: P[]
  predicted?: P[]
}

/** A real PointerEvent on the overlay (client px == screen px; at zoom 1 and camera 0 that is also world). */
const pe = (kind: string, x: number, y: number, o: Init = {}) => {
  const type = o.type ?? 'mouse'
  const mkEv = (cx: number, cy: number, pressure = o.pressure ?? 0) =>
    new PointerEvent(kind, {
      clientX: cx,
      clientY: cy,
      pointerType: type,
      pointerId: o.id ?? 1,
      pressure,
      button: o.button ?? 0,
      bubbles: true,
    })
  const e = mkEv(x, y)
  if (o.t !== undefined)
    Object.defineProperty(e, 'timeStamp', { value: o.t, configurable: true })
  const list = (ps: P[]) => () => ps.map(([cx, cy, p]) => mkEv(cx, cy, p))
  if (o.coalesced)
    Object.defineProperty(e, 'getCoalescedEvents', {
      value: list(o.coalesced),
    })
  if (o.predicted)
    Object.defineProperty(e, 'getPredictedEvents', {
      value: list(o.predicted),
    })
  overlay().dispatchEvent(e)
}

/** down at the first point, a move through each following one, up at the last. */
const stroke = (pts: P[], o: Init = {}) => {
  const [first, ...rest] = pts as [P, ...P[]]
  const at = (p: P): Init => ({ ...o, pressure: p[2] ?? o.pressure })
  pe('pointerdown', first[0], first[1], at(first))
  for (const p of rest) pe('pointermove', p[0], p[1], at(p))
  const last = rest.at(-1) ?? first
  pe('pointerup', last[0], last[1], at(last))
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

const freehand = (i = 0) => {
  const el = els()[i]
  if (el?.type !== 'freehand') throw new Error('not a freehand element')
  return el
}

describe('pen tool', () => {
  beforeEach(() => ed.setTool('pen'))

  it('one pointer sequence is exactly one add batch labelled Draw, points relative to the box', () => {
    const commit = vi.spyOn(ed, 'commit')
    stroke([
      [10, 20],
      [30, 20],
      [50, 20],
      [50, 40],
      [50, 60],
    ])
    expect(commit).toHaveBeenCalledTimes(1)
    const batch = commit.mock.calls[0]?.[0]
    expect(batch?.label).toBe('Draw')
    expect(batch?.ops).toHaveLength(1)
    expect(batch?.ops[0]?.op).toBe('add')
    const f = freehand()
    expect([f.x, f.y, f.w, f.h]).toEqual([10, 20, 40, 40])
    expect(f.data.points).toEqual([
      [0, 0],
      [40, 0],
      [40, 40],
    ])
    ed.undoOnce()
    expect(els()).toEqual([])
  })

  it('creates a pen stroke: #1e1e1e, width 3, opacity 1, smoothing 0.5, on top, tool stays active', () => {
    put(ed, mk('under', 0, 0))
    stroke([
      [0, 0],
      [40, 40],
    ])
    stroke([
      [0, 50],
      [40, 90],
    ])
    expect(ed.tool.id).toBe('pen')
    expect(els()).toHaveLength(3)
    const f = freehand(1)
    expect(f.style).toMatchObject({
      stroke: '#1e1e1e',
      fill: null,
      strokeWidth: 3,
      opacity: 1,
    })
    expect(f.data).toMatchObject({ smoothing: 0.5, highlighter: false })
    expect(f.locked).toBe(false)
    expect(f.rotation).toBe(0)
    expect(f.author).toEqual(ed.author)
    expect(f.z > (els()[0]?.z ?? '')).toBe(true)
    expect(freehand(2).z > f.z).toBe(true)
  })

  it('RDP removes collinear samples and keeps corners', () => {
    stroke([
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
      [30, 10],
      [30, 20],
    ])
    expect(freehand().data.points).toEqual([
      [0, 0],
      [30, 0],
      [30, 20],
    ])
  })

  it('the RDP tolerance is half a screen pixel: 0.5 / zoom world units', () => {
    const wobble = (zoom: number) => {
      ed.camera = { x: 0, y: 0, zoom }
      const t = ed.tool
      t.onPointerDown(ev(0, 0))
      t.onPointerMove(ev(10, 0.4))
      t.onPointerMove(ev(20, 0))
      t.onPointerUp(ev(20, 0))
      const f = freehand(els().length - 1)
      return f.data.points.length
    }
    expect(wobble(1)).toBe(2) // 0.4 world = 0.4 screen px: dropped
    expect(wobble(4)).toBe(3) // 0.4 world = 1.6 screen px: kept
  })

  it('a scribble of more than 10,000 corners is thinned to the schema cap and still commits', () => {
    const zig = Array.from({ length: 10_500 }, (_, i) => ({
      screen: { x: i, y: i % 2 ? 1.2 : 0 },
      world: { x: i, y: i % 2 ? 1.2 : 0 },
    }))
    ed.tool.onPointerDown(ev(0, 0))
    ed.tool.onPointerMove(ev(10_499, 0, { samples: zig }))
    ed.tool.onPointerUp(ev(10_499, 0))
    expect(els()).toHaveLength(1)
    expect(freehand().data.points.length).toBeLessThanOrEqual(10_000)
  })

  it('a tap commits a dot: two identical points, a 0x0 box', () => {
    const commit = vi.spyOn(ed, 'commit')
    pe('pointerdown', 5.04, 7)
    pe('pointerup', 5.04, 7)
    expect(commit).toHaveBeenCalledTimes(1)
    const f = freehand()
    expect([f.x, f.y, f.w, f.h]).toEqual([5, 7, 0, 0])
    expect(f.data.points).toEqual([
      [0, 0],
      [0, 0],
    ])
    expect(ed.tool.id).toBe('pen')
  })

  it('a pen stroke keeps its pressure, aligned with the surviving points; a mouse stroke stores none', () => {
    stroke(
      [
        [0, 0, 0.2],
        [10, 0, 0.4],
        [20, 0, 0.6],
        [20, 20, 1],
      ],
      { type: 'pen' },
    )
    expect(freehand().data.points).toEqual([
      [0, 0],
      [20, 0],
      [20, 20],
    ])
    expect(freehand().data.pressure).toEqual([0.2, 0.6, 1])
    stroke([
      [0, 100],
      [50, 120],
    ])
    expect(freehand(1).data.pressure).toBeUndefined()
  })

  it('uses the coalesced samples of a move, not just its endpoint', () => {
    pe('pointerdown', 0, 0)
    pe('pointermove', 40, 40, {
      coalesced: [
        [20, 0],
        [40, 0],
        [40, 40],
      ],
    })
    pe('pointerup', 40, 40)
    expect(freehand().data.points).toEqual([
      [0, 0],
      [40, 0],
      [40, 40],
    ])
  })

  it('predicted samples are only previewed, never stored', () => {
    pe('pointerdown', 0, 0)
    pe('pointermove', 20, 0, { predicted: [[900, 900]] })
    pe('pointerup', 20, 0)
    const f = freehand()
    expect([f.w, f.h]).toEqual([20, 0])
    expect(f.data.points).toEqual([
      [0, 0],
      [20, 0],
    ])
  })

  it('previews the live outline on the overlay while drawing, and nothing otherwise', () => {
    const calls: string[] = []
    const ctx = new Proxy(
      {},
      {
        get: (_t, k: string) => () => calls.push(k),
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D
    ed.tool.drawOverlay?.(ctx)
    expect(calls).not.toContain('fill')
    pe('pointerdown', 0, 0)
    pe('pointermove', 30, 10)
    ed.tool.drawOverlay?.(ctx)
    expect(calls).toContain('fill')
    pe('pointerup', 30, 10)
    calls.length = 0
    ed.tool.drawOverlay?.(ctx)
    expect(calls).not.toContain('fill')
  })

  it('only the primary button draws', () => {
    stroke(
      [
        [0, 0],
        [40, 40],
      ],
      { button: 2 },
    )
    expect(els()).toEqual([])
  })
})

describe('highlighter tool', () => {
  it('creates #ffd400, width 18, opacity 0.45, highlighter: true, labelled Highlight', () => {
    const commit = vi.spyOn(ed, 'commit')
    ed.setTool('highlighter')
    stroke([
      [0, 0],
      [100, 0],
    ])
    expect(commit.mock.calls[0]?.[0].label).toBe('Highlight')
    const f = freehand()
    expect(f.style).toMatchObject({
      stroke: '#ffd400',
      strokeWidth: 18,
      opacity: 0.45,
    })
    expect(f.data).toMatchObject({ highlighter: true, smoothing: 0.5 })
    expect(ed.tool.id).toBe('highlighter')
  })
})

describe('palm rejection', () => {
  beforeEach(() => ed.setTool('pen'))
  const touchStroke = (t: number) =>
    stroke(
      [
        [0, 0],
        [40, 40],
      ],
      { type: 'touch', id: 2, t },
    )

  it('a touch pointerdown within 600 ms of any pen event is ignored', () => {
    pe('pointermove', 300, 300, { type: 'pen', t: 1000 }) // the pen hovering in range
    touchStroke(1599)
    expect(els()).toEqual([])
  })

  it('a touch pointerdown 600 ms or more after the last pen event draws', () => {
    pe('pointermove', 300, 300, { type: 'pen', t: 1000 })
    touchStroke(1600)
    expect(els()).toHaveLength(1)
  })

  it('touch draws when no pen was ever seen, and the mouse is never rejected', () => {
    touchStroke(5)
    stroke(
      [
        [0, 0],
        [40, 40],
      ],
      { type: 'mouse', t: 6 },
    )
    expect(els()).toHaveLength(2)
  })

  it('a palm resting beside a pen stroke adds no samples and its cancel does not end the stroke', () => {
    pe('pointerdown', 0, 0, { type: 'pen', id: 1, t: 1000, pressure: 0.5 })
    pe('pointerdown', 500, 500, { type: 'touch', id: 2, t: 1050 })
    pe('pointermove', 510, 520, { type: 'touch', id: 2, t: 1060 })
    pe('pointermove', 40, 0, { type: 'pen', id: 1, t: 1070, pressure: 0.5 })
    pe('pointercancel', 510, 520, { type: 'touch', id: 2, t: 1080 })
    pe('pointerup', 40, 0, { type: 'pen', id: 1, t: 1090, pressure: 0.5 })
    expect(els()).toHaveLength(1)
    expect(freehand().data.points).toEqual([
      [0, 0],
      [40, 0],
    ])
  })
})

describe('tool keys', () => {
  it('P picks the pen, Shift+P the highlighter, Shift+R still the rectangle', () => {
    key('p')
    expect(ed.tool.id).toBe('pen')
    key('P', { shiftKey: true, code: 'KeyP' })
    expect(ed.tool.id).toBe('highlighter')
    key('p')
    expect(ed.tool.id).toBe('pen')
    key('R', { shiftKey: true, code: 'KeyR' })
    expect(ed.tool.id).toBe('rect')
    key('v')
    expect(ed.tool.id).toBe('select')
    key('r')
    expect(ed.tool.id).toBe('rect')
  })

  it('Caps Lock (an upper-case key without Shift) is still the pen', () => {
    key('P', { code: 'KeyP' })
    expect(ed.tool.id).toBe('pen')
  })

  it('works on a non-Latin layout through the physical key', () => {
    key('ح', { code: 'KeyP' })
    expect(ed.tool.id).toBe('pen')
    key('ح', { code: 'KeyP', shiftKey: true })
    expect(ed.tool.id).toBe('highlighter')
  })

  it('declares P and Shift+P', () => {
    expect([ed.tools.pen?.key, ed.tools.pen?.shift]).toEqual(['p', undefined])
    expect([ed.tools.highlighter?.key, ed.tools.highlighter?.shift]).toEqual([
      'p',
      true,
    ])
  })
})

describe('cancelling a gesture', () => {
  beforeEach(() => ed.setTool('pen'))

  it('Escape mid-stroke drops it: no batch, even when the pointer carries on', () => {
    const commit = vi.spyOn(ed, 'commit')
    pe('pointerdown', 0, 0)
    pe('pointermove', 30, 30)
    key('Escape')
    pe('pointermove', 60, 60)
    pe('pointerup', 60, 60)
    expect(commit).not.toHaveBeenCalled()
    expect(els()).toEqual([])
    expect(ed.tool.id).toBe('pen')
  })

  it('Escape with no stroke under way is not claimed', () => {
    expect(toolKey(ed.tool, 'Escape')).toBeFalsy()
  })

  it('pointercancel drops the stroke', () => {
    const commit = vi.spyOn(ed, 'commit')
    pe('pointerdown', 0, 0)
    pe('pointermove', 30, 30)
    pe('pointercancel', 30, 30)
    pe('pointerup', 30, 30)
    expect(commit).not.toHaveBeenCalled()
    expect(els()).toEqual([])
  })

  it('a new stroke after a cancelled one commits normally', () => {
    pe('pointerdown', 0, 0)
    pe('pointercancel', 0, 0)
    stroke([
      [0, 0],
      [40, 0],
    ])
    expect(els()).toHaveLength(1)
  })

  it('switching tools mid-stroke drops it', () => {
    pe('pointerdown', 0, 0)
    pe('pointermove', 30, 30)
    ed.setTool('select')
    pe('pointerup', 30, 30)
    expect(els()).toEqual([])
  })
})

describe('read-only', () => {
  it('ignores the tool: no batch, and the key does not even select it', () => {
    const commit = vi.spyOn(ed, 'commit')
    ed.setTool('pen')
    ed.readOnly = true
    stroke([
      [0, 0],
      [40, 40],
    ])
    expect(commit).not.toHaveBeenCalled()
    expect(els()).toEqual([])
    ed.setTool('hand')
    key('p')
    expect(ed.tool.id).toBe('hand')
    key('P', { shiftKey: true, code: 'KeyP' })
    expect(ed.tool.id).toBe('hand')
  })
})

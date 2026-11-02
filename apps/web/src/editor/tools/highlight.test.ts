// @vitest-environment jsdom
import { DEFAULT_STYLE, type Element } from '@whiteboard/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '../editor'
import { drag, mk, mkText, ptr, put, setup } from '../test-utils'
import { COLORS, drawGroupBox, GROUP_GAP, LOOK, PAD } from './highlight'

let ed: Editor
let done: () => void
let frames: FrameRequestCallback[] = []
beforeEach(() => {
  ;({ ed, done } = setup())
  frames = []
  // Deferred frames, so a test decides when the Editor repaints.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb)
    return frames.length
  })
  ed.setTool('select')
})
afterEach(() => done())

const flush = () => {
  for (const f of frames.splice(0)) f(0)
}
const overlay = () =>
  document.querySelectorAll('canvas')[1] as HTMLCanvasElement
const cursor = () => overlay().style.cursor
const sel = (...ids: string[]) => {
  ed.selection.clear()
  for (const i of ids) ed.selection.add(i)
}

type Op = { k: string; a: number[]; style: string; width: number }
/** A recording 2D context: every call with its arguments, plus the stroke style and width in force at that call. */
const rec = () => {
  const ops: Op[] = []
  const state: Record<string, unknown> = { strokeStyle: '', lineWidth: 1 }
  const ctx = new Proxy(state, {
    get: (t, k: string) =>
      k in t
        ? t[k]
        : (...a: number[]) =>
            ops.push({
              k,
              a,
              style: t.strokeStyle as string,
              width: t.lineWidth as number,
            }),
    set: (t, k: string, v) => {
      t[k] = v
      return true
    },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, ops }
}
const draw = () => {
  const r = rec()
  ed.tool.drawOverlay?.(r.ctx)
  return r.ops
}
const strokes = (ops: Op[]) => ops.filter((o) => o.k === 'stroke')
const hasStroke = (ops: Op[], style: string) =>
  strokes(ops).some((o) => o.style === style)

describe('every element type is selectable', () => {
  const CASES: [string, Element, [number, number]][] = [
    ['rect', mk('t', 100, 100, 100, 60), [150, 130]],
    ['ellipse', mk('t', 100, 100, 100, 60, { kind: 'ellipse' }), [150, 130]],
    ['diamond', mk('t', 100, 100, 100, 60, { kind: 'diamond' }), [150, 130]],
    ['triangle', mk('t', 100, 100, 100, 60, { kind: 'triangle' }), [150, 150]],
    [
      'line',
      mk('t', 100, 100, 100, 50, {
        kind: 'line',
        points: [
          [0, 0],
          [100, 50],
        ],
      }),
      [150, 125],
    ],
    [
      'arrow',
      mk('t', 100, 100, 100, 50, {
        kind: 'arrow',
        points: [
          [0, 0],
          [100, 50],
        ],
      }),
      [150, 125],
    ],
    ['text', mkText('t', 100, 100), [140, 114]],
  ]

  it.each(CASES)('%s: a click selects it', (_n, el, at) => {
    put(ed, el)
    drag(ed.tool, [at])
    expect([...ed.selection]).toEqual(['t'])
  })

  it.each(CASES)('%s: a marquee around it selects it', (_n, el) => {
    put(ed, el)
    drag(ed.tool, [
      [50, 50],
      [150, 120],
      [260, 200],
    ])
    expect([...ed.selection]).toEqual(['t'])
  })

  it('rotated text is hit in its rotated box', () => {
    put(ed, mkText('t', 100, 100, Math.PI / 2)) // centre (140,114): rotated, it spans y 74..154
    drag(ed.tool, [[140, 80]])
    expect([...ed.selection]).toEqual(['t'])
  })

  it.each(['rect', 'ellipse', 'diamond', 'triangle'] as const)(
    'unfilled %s keeps outline-only hits',
    (kind) => {
      const el = mk('t', 100, 100, 100, 60, { kind })
      el.style.fill = null
      put(ed, el)
      drag(ed.tool, [[150, 130]]) // the middle of the shape, 28+ px from its outline
      expect(ed.selection.size).toBe(0)
      drag(ed.tool, [[150, 100]]) // the top edge or apex
      expect([...ed.selection]).toEqual(['t'])
    },
  )
})

describe('hover', () => {
  beforeEach(() => put(ed, mk('a', 0, 0), mk('b', 200, 0)))

  it('invalidates the overlay only when the hovered element changes, and sets the pointer cursor', () => {
    const inv = vi.spyOn(ed, 'invalidateOverlay')
    ptr('pointermove', 500, 500)
    expect(inv).not.toHaveBeenCalled()
    expect(cursor()).toBe('')
    ptr('pointermove', 10, 10)
    expect(inv).toHaveBeenCalledTimes(1)
    expect(cursor()).toBe('pointer')
    ptr('pointermove', 20, 20) // still a
    expect(inv).toHaveBeenCalledTimes(1)
    ptr('pointermove', 210, 10) // a -> b
    expect(inv).toHaveBeenCalledTimes(2)
    ptr('pointermove', 500, 500) // b -> nothing
    expect(inv).toHaveBeenCalledTimes(3)
    expect(cursor()).toBe('')
    ptr('pointermove', 510, 510)
    expect(inv).toHaveBeenCalledTimes(3)
  })

  it('draws a lighter, thinner highlight than the selection', () => {
    ptr('pointermove', 10, 10)
    const [h] = strokes(draw())
    expect(h?.style).toBe(COLORS.hover)
    expect(h?.width).toBe(LOOK.hover.width)
    expect(LOOK.hover.width).toBeLessThan(LOOK.select.width)
    sel('a')
    expect(hasStroke(draw(), COLORS.select)).toBe(true)
  })

  it('shows no highlight on a selected element (the cursor still says it is pickable)', () => {
    drag(ed.tool, [[10, 10]]) // selects a
    ptr('pointermove', 20, 20)
    expect(cursor()).toBe('pointer')
    expect(hasStroke(draw(), COLORS.hover)).toBe(false)
    expect(hasStroke(draw(), COLORS.select)).toBe(true)
    ptr('pointermove', 210, 10) // b is not selected
    expect(hasStroke(draw(), COLORS.hover)).toBe(true)
  })

  it('is cleared when a press starts', () => {
    ptr('pointermove', 10, 10)
    expect(cursor()).toBe('pointer')
    ptr('pointerdown', 10, 10, 2) // right button: no selection, no gesture
    expect(cursor()).toBe('')
    expect(hasStroke(draw(), COLORS.hover)).toBe(false)
    expect(ed.selection.size).toBe(0)
  })

  it('is not shown while a gesture is active', () => {
    ptr('pointerdown', 500, 500) // marquee
    ptr('pointermove', 10, 10)
    expect(cursor()).toBe('')
    expect(hasStroke(draw(), COLORS.hover)).toBe(false)
    ptr('pointerup', 10, 10)
    ptr('pointerdown', 10, 10) // move gesture on a
    ptr('pointermove', 210, 10)
    expect(cursor()).toBe('')
    expect(hasStroke(draw(), COLORS.hover)).toBe(false)
    ptr('pointerup', 210, 10)
  })

  it('is cleared when the pointer leaves, the tool changes, or the camera moves', () => {
    ptr('pointermove', 10, 10)
    expect(hasStroke(draw(), COLORS.hover)).toBe(true)
    overlay().dispatchEvent(new Event('pointerleave'))
    expect(cursor()).toBe('')
    expect(hasStroke(draw(), COLORS.hover)).toBe(false)

    ptr('pointermove', 10, 10)
    expect(cursor()).toBe('pointer')
    ed.setTool('hand')
    expect(cursor()).toBe('grab') // the tool's own cursor, the hover is gone
    ed.setTool('select')
    expect(cursor()).toBe('')
    expect(hasStroke(draw(), COLORS.hover)).toBe(false)

    ptr('pointermove', 10, 10)
    expect(cursor()).toBe('pointer')
    ed.panBy(30, 30) // the element is no longer under the pointer
    flush()
    expect(cursor()).toBe('')
    expect(hasStroke(draw(), COLORS.hover)).toBe(false)
  })

  it('skips an element that was removed while hovered', () => {
    ptr('pointermove', 10, 10)
    ed.commit({
      batchId: 'rm',
      label: 'rm',
      ops: [{ op: 'remove', id: 'a' }],
    })
    expect(() => draw()).not.toThrow()
    expect(hasStroke(draw(), COLORS.hover)).toBe(false)
    expect(cursor()).toBe('pointer') // stale until the next frame...
    flush()
    expect(cursor()).toBe('') // ...which clears the hover of a deleted element
    ptr('pointermove', 10, 10) // and a later hover on b works as usual
    expect(cursor()).toBe('')
    ptr('pointermove', 210, 10)
    expect(cursor()).toBe('pointer')
  })

  it('does not repaint the overlay when neither the old nor the new hover is drawn (selected or none)', () => {
    drag(ed.tool, [[10, 10]]) // selects a
    flush()
    const inv = vi.spyOn(ed, 'invalidateOverlay')
    ptr('pointermove', 20, 20) // none -> a (selected: no hover highlight is drawn)
    expect(cursor()).toBe('pointer')
    ptr('pointermove', 500, 500) // a -> none
    expect(cursor()).toBe('')
    expect(inv).not.toHaveBeenCalled()
    ptr('pointermove', 210, 10) // none -> b: drawn
    expect(inv).toHaveBeenCalledTimes(1)
    ptr('pointermove', 20, 20) // b -> a (selected): b's highlight must go
    expect(inv).toHaveBeenCalledTimes(2)
    expect(hasStroke(draw(), COLORS.hover)).toBe(false)
  })

  it('does not show in a read-only editor', () => {
    ed.readOnly = true
    const inv = vi.spyOn(ed, 'invalidateOverlay')
    ptr('pointermove', 10, 10)
    expect(cursor()).toBe('')
    expect(inv).not.toHaveBeenCalled()
  })

  it('is overlay-only: hover and selection never repaint the scene', () => {
    flush()
    ed.invalidate()
    const first = ed.lastRender
    flush()
    expect(ed.lastRender).not.toBe(first) // control: a scene invalidation does repaint
    const before = ed.lastRender
    const inv = vi.spyOn(ed, 'invalidate')
    const invOverlay = vi.spyOn(ed, 'invalidateOverlay')
    ptr('pointermove', 10, 10)
    expect(cursor()).toBe('pointer') // hover took effect...
    expect(invOverlay).toHaveBeenCalled() // ...and asked for an overlay repaint
    flush()
    drag(ed.tool, [[10, 10]]) // select
    flush()
    ptr('pointermove', 210, 10)
    ptr('pointermove', 500, 500)
    flush()
    expect(ed.selection.size).toBe(1)
    expect(inv).not.toHaveBeenCalled()
    expect(ed.lastRender).toBe(before)
  })
})

describe('selection highlight', () => {
  const pad = (k: number, stroke = DEFAULT_STYLE.strokeWidth) =>
    stroke / 2 + PAD / k

  it.each([0.5, 1, 2])(
    'a rotated rect gets a padded 2 screen px outline in its own frame at zoom %s',
    (k) => {
      put(ed, mk('a', 100, 100, 100, 60, { rotation: 0.5 }))
      sel('a')
      ed.camera = { x: 0, y: 0, zoom: k }
      const ops = draw()
      const t = ops.find((o) => o.k === 'translate')
      expect(t?.a).toEqual([150, 130])
      expect(ops.find((o) => o.k === 'rotate')?.a).toEqual([0.5])
      const p = pad(k)
      expect(ops.find((o) => o.k === 'moveTo')?.a).toEqual([-50 - p, -30 - p])
      const [s] = strokes(ops)
      expect(s?.style).toBe(COLORS.select)
      expect(s?.width).toBeCloseTo(2 / k, 9)
    },
  )

  it('traces the real shape: a diamond has 4 vertices, a triangle 3, an ellipse an ellipse', () => {
    put(
      ed,
      mk('d', 0, 0, 100, 60, { kind: 'diamond' }),
      mk('t', 200, 0, 100, 60, { kind: 'triangle' }),
      mk('e', 400, 0, 100, 60, { kind: 'ellipse' }),
    )
    const verts = (id: string) => {
      sel(id)
      const ops = draw()
      return ops.filter((o) => o.k === 'lineTo' || o.k === 'moveTo').length
    }
    expect(verts('d')).toBe(4)
    expect(verts('t')).toBe(3)
    sel('e')
    const ellipse = draw().find((o) => o.k === 'ellipse')
    expect(ellipse?.a.slice(0, 4)).toEqual([0, 0, 50 + pad(1), 30 + pad(1)])
  })

  it('a text element is outlined around its box, padded only by the screen gap', () => {
    put(ed, mkText('x', 100, 100, 0.3))
    sel('x')
    const ops = draw()
    expect(ops.find((o) => o.k === 'translate')?.a).toEqual([140, 114])
    expect(ops.find((o) => o.k === 'rotate')?.a).toEqual([0.3])
    expect(ops.find((o) => o.k === 'moveTo')?.a).toEqual([-40 - PAD, -14 - PAD])
  })

  it.each([0.5, 2])(
    'a line gets a translucent halo along its path plus a solid outline at zoom %s',
    (k) => {
      put(
        ed,
        mk('l', 100, 100, 100, 50, {
          kind: 'arrow',
          points: [
            [0, 0],
            [100, 50],
          ],
        }),
      )
      sel('l')
      ed.camera = { x: 0, y: 0, zoom: k }
      const ops = draw()
      const halo = strokes(ops).find((o) => o.style === COLORS.selectHalo)
      expect(halo?.width).toBeCloseTo(2 * pad(k), 9)
      const i = ops.indexOf(halo as Op)
      const path = ops
        .slice(0, i)
        .filter((o) => o.k === 'moveTo' || o.k === 'lineTo')
      expect(path.map((o) => [o.k, ...o.a])).toEqual([
        ['moveTo', 100, 100],
        ['lineTo', 200, 150],
      ])
      const edge = strokes(ops).find(
        (o) => o.style === COLORS.select && Math.abs(o.width - 2 / k) < 1e-9,
      )
      expect(edge).toBeDefined()
      expect(ops.some((o) => o.k === 'rotate')).toBe(false) // lines are never rotated
    },
  )

  it('draws a dashed group box only for a multi-selection, around the union of the members', () => {
    put(ed, mk('a', 0, 0, 100, 60), mk('b', 200, 100, 100, 60))
    sel('a')
    expect(draw().some((o) => o.k === 'setLineDash' && o.a.length)).toBe(false)
    sel('a', 'b')
    const ops = draw()
    expect(ops.filter((o) => o.k === 'translate')).toHaveLength(2) // each member outlined
    expect(ops.some((o) => o.k === 'setLineDash' && o.a.length > 0)).toBe(true)
    const g = DEFAULT_STYLE.strokeWidth / 2 + GROUP_GAP + PAD
    expect(ops.find((o) => o.k === 'strokeRect' && o.a[0] === -g)?.a).toEqual([
      -g,
      -g,
      300 + 2 * g,
      160 + 2 * g,
    ])
  })

  it.each([0.5, 2])(
    'the group box clears the outline of the thickest member at zoom %s',
    (k) => {
      const thick = {
        ...mk('a', 0, 0, 100, 60),
        style: { ...DEFAULT_STYLE, strokeWidth: 40 },
      }
      put(ed, thick, mk('b', 200, 100, 100, 60))
      sel('a', 'b')
      ed.camera = { x: 0, y: 0, zoom: k }
      const ops = draw()
      const box = ops.find((o) => o.k === 'strokeRect')
      const memberEdge = -(40 / 2 + PAD / k) // a's highlight, left of x = 0
      expect(box?.a[0]).toBeLessThan(memberEdge)
      expect(box?.a[0]).toBeCloseTo(-(20 + (PAD + GROUP_GAP) / k), 9)
    },
  )

  it('a large selection does not overflow the call stack', () => {
    const many = Array.from({ length: 150_000 }, (_, i) =>
      mk(`m${i}`, i, 0, 1, 1),
    )
    const r = rec()
    expect(() => drawGroupBox(r.ctx, many, 1)).not.toThrow()
  })
})

describe('colours', () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => {
      const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0)
  }
  const contrast = (hex: string) => 1.05 / (lum(hex) + 0.05) // against #fff

  it('selection is high contrast on white and hover is visible but lighter', () => {
    expect(contrast(COLORS.select)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(COLORS.hover)).toBeGreaterThanOrEqual(3)
    expect(contrast(COLORS.hover)).toBeLessThan(contrast(COLORS.select))
  })
})

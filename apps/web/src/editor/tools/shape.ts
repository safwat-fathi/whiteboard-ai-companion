import {
  DEFAULT_STYLE,
  type Element,
  newId,
  ordered,
  type Point,
  resolveEnd,
  type ShapeData,
  zBetween,
} from '@whiteboard/core'
import type { Editor } from '../editor'
import type { Tool } from './index'
import { bindTo, frame, rebase, shapeAt } from './transform'

type Kind = ShapeData['kind']
const META: Record<Kind, { key: string; label: string }> = {
  rect: { key: 'r', label: 'Rectangle' },
  ellipse: { key: 'o', label: 'Ellipse' },
  diamond: { key: 'd', label: 'Diamond' },
  triangle: { key: '', label: 'Triangle' },
  line: { key: 'l', label: 'Line' },
  arrow: { key: 'a', label: 'Arrow' },
}
/** Fill of newly created closed shapes: non-null so clicks inside pick them and arrows can bind. */
export const NEW_SHAPE_FILL = '#ffffff'
const DRAG = 3 // screen px before a press becomes a drag

export const shapeTool =
  (kind: Kind) =>
  (ed: Editor): Tool => {
    const linear = kind === 'line' || kind === 'arrow'
    let from: { world: Point; screen: Point; snap: Element | null } | null =
      null
    let to: Point | null = null // world, only once dragging
    let toSnap: Element | null = null

    const end = (p: Point, snap: Element | null) =>
      snap ? resolveEnd(bindTo(snap, p), snap) : p

    const create = (
      a: Point,
      b: Point | null,
      s0: Element | null,
      s1: Element | null,
    ) => {
      const top = ordered(ed.scene).at(-1)?.z ?? null
      const base = {
        id: newId(),
        type: 'shape' as const,
        rotation: 0,
        z: zBetween(top, null),
        style: {
          ...DEFAULT_STYLE,
          ...(linear ? {} : { fill: NEW_SHAPE_FILL }),
        },
        locked: false,
        author: { kind: 'human' as const, id: 'local' },
        v: 0,
      }
      let el: Element
      if (linear) {
        const p0 = end(a, s0)
        const p1 = b ? end(b, s1) : { x: p0.x + 120, y: p0.y }
        const r = rebase([p0, p1]) as {
          x: number
          y: number
          w: number
          h: number
          'data.points': [number, number][]
        }
        el = {
          ...base,
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
          data: {
            kind,
            points: r['data.points'],
            ...(kind === 'arrow'
              ? { arrowheads: { start: false, end: true } }
              : {}),
            ...(s0 ? { start: bindTo(s0, a) } : {}),
            ...(b && s1 ? { end: bindTo(s1, b) } : {}),
          },
        }
      } else {
        const [x, y, w, h] = b
          ? [
              Math.min(a.x, b.x),
              Math.min(a.y, b.y),
              Math.max(1, Math.abs(b.x - a.x)),
              Math.max(1, Math.abs(b.y - a.y)),
            ]
          : [a.x - 60, a.y - 40, 120, 80]
        el = { ...base, x, y, w, h, data: { kind } }
      }
      ed.commit({
        batchId: newId(),
        label: `Add ${META[kind].label}`,
        ops: [{ op: 'add', el }],
      })
      ed.selection.clear()
      ed.selection.add(el.id)
      ed.setTool('select')
    }
    const reset = () => {
      from = null
      to = null
      toSnap = null
      ed.invalidate()
    }

    return {
      id: kind,
      key: META[kind].key,
      onPointerDown(e) {
        if (e.button !== 0) return
        from = {
          world: e.world,
          screen: e.screen,
          snap: linear ? shapeAt(ed, e.world) : null,
        }
      },
      onPointerMove(e) {
        if (!from) return
        if (
          !to &&
          Math.hypot(e.screen.x - from.screen.x, e.screen.y - from.screen.y) <
            DRAG
        )
          return
        to = e.world
        toSnap = linear ? shapeAt(ed, e.world) : null
        ed.invalidate()
      },
      onPointerUp(e) {
        const f = from
        const dragged = to !== null
        const snap = toSnap
        reset()
        if (!f) return
        create(f.world, dragged ? e.world : null, f.snap, dragged ? snap : null)
      },
      onCancel: reset,
      drawOverlay(ctx) {
        if (!from || !to) return
        ctx.save()
        ctx.strokeStyle = '#4f8cff'
        ctx.lineWidth = 1 / ed.camera.zoom
        if (linear) {
          const a = end(from.world, from.snap)
          const b = end(to, toSnap)
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
          for (const s of [from.snap, toSnap]) if (s) frame(ctx, s)
        } else
          ctx.strokeRect(
            Math.min(from.world.x, to.x),
            Math.min(from.world.y, to.y),
            Math.abs(to.x - from.world.x),
            Math.abs(to.y - from.world.y),
          )
        ctx.restore()
      },
    }
  }

import {
  DEFAULT_STYLE,
  type Element,
  newId,
  ordered,
  quantiseStroke,
  rdp,
  strokeOutline,
  zBetween,
} from '@whiteboard/core'
import type { Editor } from '../editor'
import type { Sample, Tool } from './index'

const SMOOTHING = 0.5 // both tools; the stored `smoothing`
const RDP_PX = 0.5 // screen px: the simplification tolerance is RDP_PX / zoom world units
const MAX_POINTS = 10_000 // FreehandDataSchema's cap

const KINDS = {
  pen: {
    label: 'Draw',
    style: { stroke: '#1e1e1e', strokeWidth: 3, opacity: 1 },
  },
  highlighter: {
    label: 'Highlight',
    style: { stroke: '#ffd400', strokeWidth: 18, opacity: 0.45 },
  },
}

type Pt = [x: number, y: number, pressure: number] // world; 0.5 when the device reports none

/** Pen and highlighter: press, drag, release. One `add` per stroke; the tool stays active for the next one. */
export const inkTool =
  (highlighter: boolean) =>
  (ed: Editor): Tool => {
    const kind = highlighter ? KINDS.highlighter : KINDS.pen
    // `id` is the pointer that owns the stroke; `pressured` stays true while every sample carried a pen pressure.
    let g: {
      id: number | undefined
      pts: Pt[]
      pressured: boolean
      ahead: Pt[]
    } | null = null

    const pt = (s: Sample): Pt => [s.world.x, s.world.y, s.pressure ?? 0.5]
    const take = (ss: Sample[]) => {
      if (!g) return
      for (const s of ss) {
        g.pts.push(pt(s))
        if (s.pressure === undefined) g.pressured = false
      }
    }
    const reset = () => {
      g = null
      ed.invalidateOverlay()
    }

    const commit = () => {
      if (!g) return
      const { pts, pressured } = g
      reset()
      // Samples that repeat the previous position carry nothing; fewer than two distinct ones is a tap, drawn as a dot.
      const distinct = pts.filter(
        (p, i) =>
          i === 0 || p[0] !== pts[i - 1]?.[0] || p[1] !== pts[i - 1]?.[1],
      )
      const first = distinct[0] as Pt
      const tol0 = RDP_PX / ed.camera.zoom
      let kept = distinct.length < 2 ? [first, first] : rdp(distinct, tol0)
      // ponytail: a scribble of over 10,000 corners is thinned by doubling the tolerance (each pass is O(n^2) worst case)
      for (let tol = tol0 * 2; kept.length > MAX_POINTS; tol *= 2)
        kept = rdp(distinct, tol)
      const q = quantiseStroke(
        kept.map(([x, y]) => [x, y]),
        pressured ? kept.map((p) => p[2]) : undefined,
      )
      const el: Element = {
        id: newId(),
        type: 'freehand',
        x: q.x,
        y: q.y,
        w: q.w,
        h: q.h,
        rotation: 0,
        z: zBetween(ordered(ed.scene).at(-1)?.z ?? null, null),
        style: { ...DEFAULT_STYLE, ...kind.style },
        locked: false,
        author: { ...ed.author },
        v: 0,
        data: {
          points: q.points,
          ...(q.pressure ? { pressure: q.pressure } : {}),
          smoothing: SMOOTHING,
          highlighter,
        },
      }
      ed.commit({
        batchId: newId(),
        label: kind.label,
        ops: [{ op: 'add', el }],
      })
    }

    return {
      id: highlighter ? 'highlighter' : 'pen',
      key: 'p',
      ...(highlighter ? { shift: true as const } : {}),
      draws: true,
      onPointerDown(e) {
        // A second pointer (a finger beside the pen) never joins a stroke; the same one starting over replaces it.
        if (e.button !== 0 || (g && e.pointerId !== g.id)) return
        g = { id: e.pointerId, pts: [], pressured: true, ahead: [] }
        take([e])
        ed.invalidateOverlay()
      },
      onPointerMove(e) {
        if (!g || e.pointerId !== g.id) return
        take(e.samples?.length ? e.samples : [e])
        g.ahead = (e.predicted ?? []).map(pt)
        ed.invalidateOverlay()
      },
      onPointerUp(e) {
        // The release itself is not read: its position is the last move's and a pen reports pressure 0 there.
        if (g && e.pointerId === g.id) commit()
      },
      onKey(e) {
        if (!g || e.key !== 'Escape') return false
        reset()
        return true
      },
      onCancel(pointerId) {
        if (g && (pointerId === undefined || pointerId === g.id)) reset()
      },
      drawOverlay(ctx) {
        if (!g) return
        const pts = [...g.pts, ...g.ahead]
        const path = strokeOutline(
          pts.map(([x, y]) => [x, y]),
          g.pressured ? pts.map((p) => p[2]) : undefined,
          {
            size: kind.style.strokeWidth,
            smoothing: SMOOTHING,
            highlighter,
            last: false,
          },
          ed.platform,
        )
        ctx.save()
        // Plain alpha: the overlay is its own canvas, so there is nothing under the stroke to multiply with.
        ctx.globalAlpha = kind.style.opacity
        ctx.fillStyle = kind.style.stroke
        ctx.fill(path)
        ctx.restore()
      },
    }
  }

import { hitTest, type Id, type Point } from '@whiteboard/core'
import type { Editor } from '../editor'
import { drawHighlight } from './highlight'
import type { Tool } from './index'
import { deleteBatch } from './transform'

const REACH = 8 // screen px: the eraser's radius, so the world tolerance is REACH / zoom
const CHUNK = 400 // removes per batch: the server caps a batch at 500 ops (R4)
const LOOK = { line: '#dc2626', halo: 'rgba(220,38,38,0.22)', width: 2 }

/** Erases whole elements along a drag. The candidates are marked while dragging; release removes them (undo restores a drag). */
export const eraserTool = (ed: Editor): Tool => {
  // `id` is the pointer that owns the drag; `last` is where the previous sample was, so each move sweeps a segment.
  let g: { id: number | undefined; last: Point; hit: Set<Id> } | null = null

  const reset = () => {
    g = null
    ed.invalidateOverlay()
  }

  /** Marks every unlocked element within the eraser's reach of `p`. */
  const touch = (hit: Set<Id>, p: Point) => {
    const tol = REACH / ed.camera.zoom
    for (const f of ed.index.search({
      minX: p.x - tol,
      minY: p.y - tol,
      maxX: p.x + tol,
      maxY: p.y + tol,
    })) {
      const el = ed.scene.els.get(f.id)
      if (el && !el.locked && !hit.has(el.id) && hitTest(el, p, tol))
        hit.add(el.id)
    }
  }

  /** Touches the segment a-b at half-tolerance steps, so a fast flick cannot jump over a thin line. */
  const sweep = (hit: Set<Id>, a: Point, b: Point) => {
    const steps = Math.ceil(
      Math.hypot(b.x - a.x, b.y - a.y) / (REACH / 2 / ed.camera.zoom),
    )
    for (let i = 1; i <= steps; i++)
      touch(hit, {
        x: a.x + ((b.x - a.x) * i) / steps,
        y: a.y + ((b.y - a.y) * i) / steps,
      })
  }

  const commit = () => {
    if (!g) return
    const ids = [...g.hit]
    reset()
    // Each chunk is built against the scene the previous one left, so an arrow bound across two chunks is unbound in both.
    // ponytail: a chunk that also unbinds more than 100 surviving arrows would pass the server's 500-op cap; chunk by op count then.
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      const b = deleteBatch(ed.scene, chunk)
      if (!b) continue
      const n = b.ops.filter((o) => o.op === 'remove').length // not chunk.length: a locked or vanished id is dropped
      ed.commit({ ...b, label: `Erase ${n} element${n === 1 ? '' : 's'}` })
    }
  }

  return {
    id: 'eraser',
    key: 'e',
    draws: true,
    onPointerDown(e) {
      // A second pointer (a finger beside the pen) never joins a drag; the same one starting over replaces it.
      if (e.button !== 0 || (g && e.pointerId !== g.id)) return
      g = { id: e.pointerId, last: e.world, hit: new Set() }
      touch(g.hit, e.world)
      ed.invalidateOverlay()
    },
    onPointerMove(e) {
      if (!g || e.pointerId !== g.id) return
      for (const s of e.samples?.length ? e.samples : [e]) {
        sweep(g.hit, g.last, s.world)
        g.last = s.world
      }
      ed.invalidateOverlay()
    },
    onPointerUp(e) {
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
      for (const id of g.hit) {
        const el = ed.scene.els.get(id)
        if (el) drawHighlight(ctx, el, ed.camera.zoom, LOOK)
      }
    },
  }
}

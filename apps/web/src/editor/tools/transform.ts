import {
  type Batch,
  type Binding,
  deleteWithGroups,
  type Element,
  hitTest,
  type Id,
  moveGroupsWith,
  newId,
  type Patch,
  type Point,
  routeArrow,
  type Scene,
  toLocal,
} from '@whiteboard/core'
import type { Editor } from '../editor'

export const isLinear = (el: Element) =>
  el.type === 'shape' && (el.data.kind === 'line' || el.data.kind === 'arrow')

export const worldPts = (el: Element): Point[] =>
  el.type === 'shape'
    ? (el.data.points ?? []).map(([a, b]) => ({ x: el.x + a, y: el.y + b }))
    : []

/** Applies a dotted-leaf patch to a copy (null unsets), for previews and for routing against the scene-after. */
export function applyPatch(el: Element, patch: Patch): Element {
  const out = structuredClone(el) as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) {
    const path = k.split('.')
    const last = path.pop() as string
    let o = out
    for (const s of path) o = o[s] as Record<string, unknown>
    if (v === null) delete o[last]
    else o[last] = v
  }
  return out as unknown as Element
}

/** x,y,w,h and points (relative to the new x,y) for a polyline given in world space. */
export function rebase(abs: Point[]): Patch {
  const x = Math.min(...abs.map((p) => p.x))
  const y = Math.min(...abs.map((p) => p.y))
  return {
    x,
    y,
    w: Math.max(...abs.map((p) => p.x)) - x,
    h: Math.max(...abs.map((p) => p.y)) - y,
    'data.points': abs.map((p) => [p.x - x, p.y - y]),
  }
}

/** Topmost non-linear shape under `p` within 6 screen px. Not SpatialIndex.pick: the arrow being edited must not shadow its target. */
export function shapeAt(ed: Editor, p: Point): Element | null {
  const pad = 6 / ed.camera.zoom
  let best: Element | null = null
  for (const f of ed.index.search({
    minX: p.x - pad,
    minY: p.y - pad,
    maxX: p.x + pad,
    maxY: p.y + pad,
  })) {
    const el = ed.scene.els.get(f.id)
    if (el?.type !== 'shape' || isLinear(el) || !hitTest(el, p, pad)) continue
    if (!best || el.z > best.z || (el.z === best.z && el.id > best.id))
      best = el
  }
  return best
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
export function bindTo(target: Element, p: Point): Binding {
  const q = toLocal(target, p)
  return {
    id: target.id,
    fx: target.w ? clamp01((q.x - target.x) / target.w) : 0.5,
    fy: target.h ? clamp01((q.y - target.y) / target.h) : 0.5,
  }
}

/**
 * One batch: `patches` first, then every arrow bound to a patched element re-routed (and arrows bound to a removed
 * element unbound, keeping their last point), then the removes. Returns null when nothing would change.
 */
export function buildBatch(
  scene: Scene,
  label: string,
  patches: Map<Id, Patch>,
  removed: Id[] = [],
): Batch | null {
  const after = new Map(scene.els)
  const ops: Batch['ops'] = []
  for (const [id, set] of patches) {
    const el = scene.els.get(id)
    if (!el) continue
    after.set(id, applyPatch(el, set))
    ops.push({ op: 'patch', id, set })
  }
  const gone = new Set(removed)
  const extra = new Map<Id, Patch>()
  for (const arrow of scene.els.values()) {
    if (arrow.type !== 'shape' || !isLinear(arrow) || gone.has(arrow.id))
      continue
    if (patches.has(arrow.id)) continue // moved/edited on its own terms
    const set: Patch = {}
    for (const k of ['start', 'end'] as const) {
      const b = arrow.data[k]
      if (b && gone.has(b.id)) set[`data.${k}`] = null
    }
    const b = [arrow.data.start, arrow.data.end]
    if (b.some((x) => x && patches.has(x.id))) {
      const moved = applyPatch(arrow, set)
      Object.assign(
        set,
        rebase(
          routeArrow(moved, { els: after }).map(([a, c]) => ({
            x: arrow.x + a,
            y: arrow.y + c,
          })),
        ),
      )
    }
    if (Object.keys(set).length) extra.set(arrow.id, set)
  }
  for (const [id, set] of extra) ops.push({ op: 'patch', id, set })
  for (const id of removed) ops.push({ op: 'remove', id })
  return ops.length ? { batchId: newId(), label, ops } : null
}

/** Moves the unlocked members of `ids`; a moved line/arrow keeps a binding only if its target moves too. */
export function moveBatch(
  scene: Scene,
  ids: Iterable<Id>,
  dx: number,
  dy: number,
): Batch | null {
  const els = [...ids]
    .map((i) => scene.els.get(i))
    .filter((e): e is Element => !!e && !e.locked)
  const moving = new Set(els.map((e) => e.id))
  const patches = new Map<Id, Patch>()
  for (const el of els) {
    const set: Patch = { x: el.x + dx, y: el.y + dy }
    if (el.type === 'shape' && isLinear(el))
      for (const k of ['start', 'end'] as const) {
        const b = el.data[k]
        if (b && !moving.has(b.id)) set[`data.${k}`] = null
      }
    patches.set(el.id, set)
  }
  // a group's box goes with its members
  for (const [id, set] of moveGroupsWith(scene, moving, dx, dy))
    patches.set(id, set)
  return buildBatch(scene, 'Move', patches)
}

export function deleteBatch(scene: Scene, ids: Iterable<Id>): Batch | null {
  const del = [...ids].filter((i) => scene.els.get(i)?.locked === false)
  del.push(...deleteWithGroups(scene, del)) // a group with no member left goes too
  return buildBatch(scene, 'Delete', new Map(), del)
}

/** Solid rotated frame of `el` (axis-aligned bounds for linear elements) shifted by (dx, dy). */
export function frame(
  ctx: CanvasRenderingContext2D,
  el: Element,
  dx = 0,
  dy = 0,
) {
  ctx.save()
  if (isLinear(el)) {
    const p = worldPts(el)
    const xs = p.map((q) => q.x)
    const ys = p.map((q) => q.y)
    ctx.strokeRect(
      Math.min(...xs) + dx,
      Math.min(...ys) + dy,
      Math.max(...xs) - Math.min(...xs),
      Math.max(...ys) - Math.min(...ys),
    )
  } else {
    ctx.translate(el.x + el.w / 2 + dx, el.y + el.h / 2 + dy)
    ctx.rotate(el.rotation)
    ctx.strokeRect(-el.w / 2, -el.h / 2, el.w, el.h)
  }
  ctx.restore()
}

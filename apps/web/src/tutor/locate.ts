import { bounds, type Camera, type Element, type Rect } from '@whiteboard/core'

type Wire = { x: number; y: number; w: number; h: number }
export type LocateItem = { ids: string[]; bounds: Wire | null }
export type LocateTarget = { rect: Rect; ids: string[]; ghost: boolean }

const union = (rs: Rect[]): Rect | null =>
  rs.length === 0
    ? null
    : {
        minX: Math.min(...rs.map((r) => r.minX)),
        minY: Math.min(...rs.map((r) => r.minY)),
        maxX: Math.max(...rs.map((r) => r.maxX)),
        maxY: Math.max(...rs.map((r) => r.maxY)),
      }

/**
 * Where to look for some AI work (jump-to-ai.md "Locate algorithm"): the union of the CURRENT bounds of the elements that
 * still exist, so Locate follows what the student moved; if none survive, the stored bounds, drawn as a "removed" ghost.
 */
export function locateTarget(
  scene: { els: Map<string, Element> },
  items: LocateItem[],
): LocateTarget | null {
  const alive = [...new Set(items.flatMap((i) => i.ids))].flatMap((id) => {
    const el = scene.els.get(id)
    return el ? [el] : []
  })
  const now = union(alive.map(bounds))
  if (now) return { rect: now, ids: alive.map((e) => e.id), ghost: false }
  const stored = union(
    items.flatMap((i) =>
      i.bounds
        ? [
            {
              minX: i.bounds.x,
              minY: i.bounds.y,
              maxX: i.bounds.x + i.bounds.w,
              maxY: i.bounds.y + i.bounds.h,
            },
          ]
        : [],
    ),
  )
  return stored ? { rect: stored, ids: [], ghost: true } : null
}

/** Where the camera was before a jump, so "Back" can return: the last five. */
export class CameraHistory {
  private stack: Camera[] = []
  push(c: Camera) {
    this.stack.push({ ...c })
    if (this.stack.length > 5) this.stack.shift()
  }
  pop(): Camera | undefined {
    return this.stack.pop()
  }
  get size() {
    return this.stack.length
  }
}

/** The world rectangle a camera shows. */
export const cameraRect = (
  c: Camera,
  v: { width: number; height: number },
): Rect => ({
  minX: c.x,
  minY: c.y,
  maxX: c.x + v.width / c.zoom,
  maxY: c.y + v.height / c.zoom,
})

/** Entirely outside the view (touching it counts as outside; a partly visible target is not "off-screen"). */
export const isOutside = (t: Rect, view: Rect): boolean =>
  t.maxX <= view.minX ||
  t.minX >= view.maxX ||
  t.maxY <= view.minY ||
  t.minY >= view.maxY

/**
 * The off-screen arrow: where the ray from the middle of the board towards the target (`dx`, `dy` in px) meets a rectangle
 * `inset` px inside the board, and the angle to point at.
 */
export function edgeIndicator(
  dir: { dx: number; dy: number },
  size: { w: number; h: number },
  inset = 16,
): { x: number; y: number; angle: number } {
  const cx = size.w / 2
  const cy = size.h / 2
  const hx = cx - inset
  const hy = cy - inset
  const { dx, dy } = dir
  const t = Math.min(
    dx === 0 ? Infinity : hx / Math.abs(dx),
    dy === 0 ? Infinity : hy / Math.abs(dy),
  )
  return { x: cx + dx * t, y: cy + dy * t, angle: Math.atan2(dy, dx) }
}

/** Follow AI moves the camera at most every 600 ms. */
export const shouldFollow = (now: number, last: number): boolean =>
  now - last >= 600

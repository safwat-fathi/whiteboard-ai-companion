import { topZ, zBetween } from '../scene'
import type { Element } from '../schema'
import { DEFAULT_STYLE, newId } from '../schema'
import type { ToolCtx } from './registry'

/** Fresh z keys stacked above everything in the scene, in order. */
export function stackAbove(ctx: ToolCtx, n: number): string[] {
  let last = topZ(ctx.scene)
  return Array.from({ length: n }, () => {
    last = zBetween(last, null)
    return last
  })
}

/** The fields every new element shares; the caller adds `type`, `data` and the geometry. */
export const baseFields = (ctx: ToolCtx, z: string) => ({
  id: newId(),
  rotation: 0,
  z,
  style: { ...DEFAULT_STYLE },
  locked: false,
  author: { ...ctx.author },
  v: 0,
})

export const asElement = (e: unknown): Element => e as Element

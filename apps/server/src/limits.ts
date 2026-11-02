import type { Batch } from '@whiteboard/core'
import { ApiError } from './errors'

/** The limits core's schema does not enforce (auth-security.md "Limits"; plan ruling R10). */
export const LIMITS = {
  opsPerBatch: 500,
  elementsPerBoard: 50_000,
  coord: 1_000_000,
} as const

const bad = (limit: string, message: string) =>
  new ApiError('validation_failed', `${limit}: ${message}`, { limit })
const inRange = (n: unknown): boolean =>
  typeof n === 'number' && Math.abs(n) <= LIMITS.coord
const pointsInRange = (pts: unknown): boolean =>
  !Array.isArray(pts) ||
  pts.every((p) => Array.isArray(p) && inRange(p[0]) && inRange(p[1]))

/**
 * Throws `validation_failed` (details.limit names which) for a batch that is over a limit. Run before applying.
 * An `add` always counts toward the element cap even if the same batch removes others (conservative).
 */
export function checkLimits(batch: Batch, elementCount: number): void {
  if (batch.ops.length > LIMITS.opsPerBatch)
    throw bad('ops', `a batch may hold at most ${LIMITS.opsPerBatch} ops`)
  let adds = 0
  for (const op of batch.ops) {
    if (op.op === 'add') {
      adds++
      for (const k of ['x', 'y', 'w', 'h'] as const)
        if (!inRange(op.el[k]))
          throw bad('coordinates', `${k} must be within ±${LIMITS.coord}`)
      if (!pointsInRange((op.el.data as { points?: unknown }).points))
        throw bad('coordinates', `points must be within ±${LIMITS.coord}`)
    } else if (op.op === 'patch') {
      for (const [k, v] of Object.entries(op.set)) {
        if ((k === 'x' || k === 'y' || k === 'w' || k === 'h') && !inRange(v))
          throw bad('coordinates', `${k} must be within ±${LIMITS.coord}`)
        const pts =
          k === 'data.points'
            ? v
            : k === 'data'
              ? (v as { points?: unknown } | null)?.points
              : undefined
        if (!pointsInRange(pts))
          throw bad('coordinates', `points must be within ±${LIMITS.coord}`)
      }
    }
  }
  if (elementCount + adds > LIMITS.elementsPerBoard)
    throw bad(
      'elements',
      `a board may hold at most ${LIMITS.elementsPerBoard} elements`,
    )
}

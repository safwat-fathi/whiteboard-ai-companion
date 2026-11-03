import type { Batch, Element } from '@whiteboard/core'
import { DEFAULT_STYLE } from '@whiteboard/core'
import { describe, expect, it } from 'vitest'
import { ApiError } from './errors'
import { checkLimits } from './limits'

const stroke = (points: [number, number][]): Element => ({
  id: 's1',
  type: 'freehand',
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  rotation: 0,
  z: 'a0',
  style: { ...DEFAULT_STYLE },
  locked: false,
  author: { kind: 'human', id: 'owner' },
  v: 0,
  data: { points, smoothing: 0.5, highlighter: false },
})
const batch = (...ops: Batch['ops']): Batch => ({
  batchId: 'b',
  label: 'Draw',
  ops,
})
const limitOf = (b: Batch) => {
  try {
    checkLimits(b, 0)
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError)
    return (e as ApiError).details
  }
  return null
}

describe('checkLimits on freehand', () => {
  it('accepts a stroke inside the coordinate range, on add and on a points patch', () => {
    expect(
      limitOf(
        batch({
          op: 'add',
          el: stroke([
            [0, 0],
            [999_999, -999_999],
          ]),
        }),
      ),
    ).toBeNull()
    expect(
      limitOf(
        batch({
          op: 'patch',
          id: 's1',
          set: {
            'data.points': [
              [0, 0],
              [5, 5],
            ],
          },
        }),
      ),
    ).toBeNull()
  })

  it('rejects an out-of-range point on add and on a data.points or data patch', () => {
    const far: [number, number][] = [
      [0, 0],
      [1_000_001, 0],
    ]
    expect(limitOf(batch({ op: 'add', el: stroke(far) }))).toEqual({
      limit: 'coordinates',
    })
    expect(
      limitOf(batch({ op: 'patch', id: 's1', set: { 'data.points': far } })),
    ).toEqual({ limit: 'coordinates' })
    expect(
      limitOf(
        batch({
          op: 'patch',
          id: 's1',
          set: { data: { points: [[0, -1_000_001]] } },
        }),
      ),
    ).toEqual({ limit: 'coordinates' })
  })
})

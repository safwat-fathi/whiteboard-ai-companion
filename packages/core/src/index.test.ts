import { describe, expect, it } from 'vitest'
import { bounds } from './geometry'
import { SpatialIndex } from './index'
import { createScene } from './scene'
import { mk } from './test-utils'

const prng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 2 ** 32
}

describe('SpatialIndex', () => {
  it('search equals brute force on 2000 random elements', () => {
    const rnd = prng(42)
    const els = Array.from({ length: 2000 }, (_, i) =>
      mk(`e${i}`, {
        x: rnd() * 5000,
        y: rnd() * 5000,
        w: rnd() * 200,
        h: rnd() * 200,
        rotation: rnd() * 6,
      }),
    )
    const idx = new SpatialIndex()
    idx.load(els)
    for (let i = 0; i < 100; i++) {
      const x = rnd() * 5000
      const y = rnd() * 5000
      const r = {
        minX: x,
        minY: y,
        maxX: x + rnd() * 800,
        maxY: y + rnd() * 800,
      }
      const want = els
        .filter((e) => {
          const b = bounds(e)
          return (
            b.minX <= r.maxX &&
            b.maxX >= r.minX &&
            b.minY <= r.maxY &&
            b.maxY >= r.minY
          )
        })
        .map((e) => e.id)
        .sort()
      expect(
        idx
          .search(r)
          .map((e) => e.id)
          .sort(),
      ).toEqual(want)
    }
  })

  it('upsert after a move removes the old entry; remove drops it', () => {
    const idx = new SpatialIndex()
    const a = mk('a', { x: 0, y: 0, w: 10, h: 10 })
    idx.load([a])
    idx.upsert({ ...a, x: 1000 })
    const old = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
    expect(idx.search(old)).toEqual([])
    expect(
      idx.search({ minX: 1000, minY: 0, maxX: 1010, maxY: 10 }),
    ).toHaveLength(1)
    idx.remove('a')
    expect(
      idx.search({ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }),
    ).toEqual([])
  })

  it('indexes elements with empty points and still searches', () => {
    const idx = new SpatialIndex()
    const bad = mk('bad', { x: 5, y: 5, data: { kind: 'arrow' } })
    idx.load([bad, mk('a', { x: 0, y: 0, w: 10, h: 10 })])
    idx.upsert(bad)
    expect(idx.search({ minX: 0, minY: 0, maxX: 20, maxY: 20 })).toHaveLength(2)
  })

  it('pick returns the higher z of two overlapping elements', () => {
    const lo = mk('lo', { w: 50, h: 50, z: 'a0', fill: '#f00' })
    const hi = mk('hi', { w: 50, h: 50, z: 'a1', fill: '#0f0' })
    const s = createScene([lo, hi])
    const idx = new SpatialIndex()
    idx.load([hi, lo])
    expect(idx.pick({ x: 25, y: 25 }, 1, s)?.id).toBe('hi')
    expect(idx.pick({ x: 500, y: 500 }, 1, s)).toBeNull()
  })
})

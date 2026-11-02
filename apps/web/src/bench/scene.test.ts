import { ElementSchema, type Platform } from '@whiteboard/core'
import { describe, expect, it } from 'vitest'
import { describeScene, makeScene } from './scene'

const platform: Platform = {
  createCanvas: () => ({ width: 0, height: 0, getContext: () => null }),
  measureText: (_f, t) => t.length * 8,
  registerFont: () => {},
  createPath2D: () => ({}) as Path2D,
}
const world = (n: number) => {
  const s = Math.sqrt(n / 5000)
  return { x: 0, y: 0, w: 1000 * s, h: 600 * s }
}

describe('bench scene', () => {
  it.each([
    [5000, 2100, 600, 2300],
    [20000, 8400, 2400, 9200],
  ])(
    '%i elements: validate, mix, 25%% rotated, 40%% Arabic',
    (n, shapes, lines, text) => {
      const w = world(n)
      const els = makeScene(n, 1, w, platform)
      for (const el of els)
        expect(ElementSchema.safeParse(el).success).toBe(true)
      const d = describeScene(els, w)
      expect(d).toMatchObject({
        total: n,
        shapes,
        lines,
        text,
        rotatedShapes: shapes / 4,
        arabicText: text * 0.4,
      })
      expect(new Set(els.map((e) => e.z)).size).toBe(n) // fractional indices, ascending
      expect(els.map((e) => e.z)).toEqual([...els.map((e) => e.z)].sort())
      expect(
        new Set(els.flatMap((e) => (e.type === 'text' ? e.data.text : [])))
          .size,
      ).toBe(text)
      expect(d.coverage).toBeGreaterThan(5)
    },
  )

  it('is deterministic for a seed', () => {
    const w = world(5000)
    const a = JSON.stringify(makeScene(5000, 1, w, platform))
    expect(JSON.stringify(makeScene(5000, 1, w, platform))).toBe(a)
    expect(JSON.stringify(makeScene(5000, 2, w, platform))).not.toBe(a)
  })
})

import { ElementSchema, type Platform } from '@whiteboard/core'
import { describe, expect, it } from 'vitest'
import {
  describeScene,
  makeImageScene,
  makeMathScene,
  makeMixedScene,
  makeScene,
  makeTextScene,
} from './scene'

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

  describe('M2 scenes', () => {
    const w = world(5000)
    const metrics = () => ({ width: 4, height: 1.2, depth: 0.4 })
    const images = [
      { blobId: 'a'.repeat(64), w: 1000, h: 700 },
      { blobId: 'b'.repeat(64), w: 4000, h: 3000 },
    ]
    const valid = (els: unknown[]) => {
      for (const el of els)
        expect(ElementSchema.safeParse(el).success).toBe(true)
      expect(new Set(els.map((e) => (e as { id: string }).id)).size).toBe(
        els.length,
      )
    }

    it('math200, text200 and images50 validate, hold their counts and stay inside the world', () => {
      const m = makeMathScene(200, w, metrics)
      const t = makeTextScene(200, w, platform)
      const i = makeImageScene(50, w, images)
      expect([m.length, t.length, i.length]).toEqual([200, 200, 50])
      for (const els of [m, t, i]) {
        valid(els)
        for (const e of els) {
          expect(e.x).toBeGreaterThanOrEqual(w.x)
          expect(e.y).toBeGreaterThanOrEqual(w.y)
          expect(e.x).toBeLessThanOrEqual(w.x + w.w)
          expect(e.y).toBeLessThanOrEqual(w.y + w.h)
        }
      }
      expect(
        new Set(m.map((e) => (e.type === 'math' ? e.data.latex : ''))).size,
      ).toBe(200)
      expect(
        new Set(t.map((e) => (e.type === 'text' ? e.data.text : ''))).size,
      ).toBe(200)
    })

    it('the mixed scene is 5,000 elements: 10% math and images over the M1 mix', () => {
      const els = makeMixedScene(5000, 1, w, platform, metrics, images)
      valid(els)
      expect(els).toHaveLength(5000)
      expect(els.filter((e) => e.type === 'math')).toHaveLength(250)
      expect(els.filter((e) => e.type === 'image')).toHaveLength(250)
      expect(els.map((e) => e.z)).toEqual([...els.map((e) => e.z)].sort())
    })
  })
})

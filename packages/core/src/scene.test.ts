import { describe, expect, it } from 'vitest'
import { OpError } from './ops'
import { applyBatch, createScene, ordered, zBetween } from './scene'
import { type Batch, DEFAULT_STYLE, type Element, type Op } from './schema'

const shape = (id: string, z: string): Element => ({
  id,
  type: 'shape',
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  rotation: 0,
  z,
  style: { ...DEFAULT_STYLE },
  locked: false,
  author: { kind: 'human', id: 'u' },
  v: 0,
  data: { kind: 'rect' },
})
const batch = (...ops: Op[]): Batch => ({ batchId: 'b', label: 'T', ops })

const noV = (s: ReturnType<typeof createScene>) =>
  ordered(s).map((e) => ({ ...e, v: 0 }))

// mulberry32 seeded PRNG
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

describe('scene', () => {
  it('(a) apply then inverse restores the scene, including v', () => {
    const rand = rng(42)
    const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)] as T
    let n = 0
    for (let i = 0; i < 200; i++) {
      let z = 'a0'
      const els = Array.from({ length: 5 }, (_, k) => {
        z = zBetween(z, null)
        return shape(`e${k}`, z)
      })
      const scene = createScene(els)
      const before = noV(scene)
      const ops: Op[] = []
      for (let k = 0; k < 1 + Math.floor(rand() * 5); k++) {
        const id = `e${Math.floor(rand() * 7)}` // e5, e6 unknown
        const r = rand()
        if (r < 0.15)
          ops.push({ op: 'add', el: shape(`n${i}_${k}`, zBetween(null, 'a0')) })
        else if (r < 0.3) ops.push({ op: 'remove', id })
        else if (r < 0.45)
          ops.push({ op: 'reorder', id, z: zBetween('a0', null) })
        else
          ops.push({
            op: 'patch',
            id,
            set: pick([
              { x: Math.floor(rand() * 100) },
              { 'style.fill': '#f00', 'data.radius': 3 },
              { 'data.label': 'hi' },
              { 'data.label': null },
              { 'style.fill': null },
            ]),
          })
      }
      const { inverse } = applyBatch(scene, batch(...ops))
      if (inverse.ops.length) n++
      if (inverse.ops.length) applyBatch(scene, inverse) // all-dropped batch: empty inverse
      expect(noV(scene)).toEqual(before)
    }
    expect(n).toBeGreaterThan(100)
  })

  it('(b) a failing op leaves the scene untouched', () => {
    const scene = createScene([shape('a', 'a0')])
    const before = structuredClone(scene)
    expect(() =>
      applyBatch(
        scene,
        batch(
          { op: 'patch', id: 'a', set: { x: 5 } },
          { op: 'add', el: shape('b', 'a1') },
          { op: 'add', el: shape('a', 'a2') },
        ),
      ),
    ).toThrow(OpError)
    expect(scene).toEqual(before)
  })

  it('inverse is field-level: undoing batch 1 keeps batch 2 edits, v keeps rising', () => {
    const scene = createScene([shape('a', 'a0')])
    const b1 = applyBatch(scene, batch({ op: 'patch', id: 'a', set: { x: 5 } }))
    applyBatch(scene, batch({ op: 'patch', id: 'a', set: { y: 7 } }))
    const vBefore = (scene.els.get('a') as Element).v
    applyBatch(scene, b1.inverse)
    const el = scene.els.get('a') as Element
    expect([el.x, el.y]).toEqual([0, 7])
    expect(el.v).toBeGreaterThan(vBefore)
  })

  it('empty inverse means no change', () => {
    const scene = createScene([shape('a', 'a0')])
    const before = structuredClone(scene)
    const { inverse } = applyBatch(
      scene,
      batch({ op: 'patch', id: 'zz', set: { x: 1 } }),
    )
    expect(inverse.ops).toHaveLength(0)
    expect(scene).toEqual(before)
  })

  it('(c) patch changes only the given leaf paths', () => {
    const scene = createScene([shape('a', 'a0')])
    const { inverse, touched } = applyBatch(
      scene,
      batch({
        op: 'patch',
        id: 'a',
        set: { 'style.fill': '#f00', 'data.kind': 'ellipse' },
      }),
    )
    const el = scene.els.get('a') as Element
    expect(el).toEqual({
      ...shape('a', 'a0'),
      v: 1,
      style: { ...DEFAULT_STYLE, fill: '#f00' },
      data: { kind: 'ellipse' },
    })
    expect(touched).toEqual(['a'])
    expect(inverse.label).toBe('Undo T')
  })

  it('null unsets optional leaves and stores null on nullable ones', () => {
    const scene = createScene([shape('a', 'a0')])
    applyBatch(
      scene,
      batch({
        op: 'patch',
        id: 'a',
        set: { 'data.label': 'x', 'style.fill': '#fff' },
      }),
    )
    applyBatch(
      scene,
      batch({
        op: 'patch',
        id: 'a',
        set: { 'data.label': null, 'style.fill': null },
      }),
    )
    const el = scene.els.get('a') as Element
    expect(Object.hasOwn(el.data, 'label')).toBe(false)
    expect(el.style.fill).toBeNull()
  })

  it('(d) patch of a removed or unknown id is dropped without throwing', () => {
    const scene = createScene([shape('a', 'a0')])
    const { touched } = applyBatch(
      scene,
      batch({ op: 'remove', id: 'a' }, { op: 'patch', id: 'a', set: { x: 1 } }),
    )
    expect(scene.els.size).toBe(0)
    expect(touched).toEqual(['a'])
    expect(() =>
      applyBatch(scene, batch({ op: 'patch', id: 'zz', set: { x: 1 } })),
    ).not.toThrow()
  })

  it('(e) ordered stays sorted and unique after 1000 inserts at one position', () => {
    const scene = createScene([shape('first', 'a0'), shape('last', 'a1')])
    let lo = 'a0'
    for (let i = 0; i < 1000; i++) {
      const z = zBetween(lo, 'a1')
      applyBatch(scene, batch({ op: 'add', el: shape(`n${i}`, z) }))
      lo = z
    }
    const zs = ordered(scene).map((e) => e.z)
    expect(zs).toHaveLength(1002)
    expect(new Set(zs).size).toBe(1002)
    expect(zs).toEqual([...zs].sort((a, b) => (a < b ? -1 : 1)))
    expect(ordered(scene)[1001]?.id).toBe('last')
  })
})

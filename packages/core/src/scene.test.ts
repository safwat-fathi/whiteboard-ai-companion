import { describe, expect, it } from 'vitest'
import { OpError } from './ops'
import { applyBatch, createScene, ordered, zBetween } from './scene'
import { type Batch, DEFAULT_STYLE, type Element, type Op } from './schema'
import { chart } from './test-utils'

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
const mathEl = (id: string, z: string): Element => ({
  id,
  type: 'math',
  x: 0,
  y: 0,
  w: 40,
  h: 20,
  rotation: 0,
  z,
  style: { ...DEFAULT_STYLE },
  locked: false,
  author: { kind: 'human', id: 'u' },
  v: 0,
  data: { latex: 'x^2', display: true, size: 24 },
})
const imageEl = (id: string, z: string): Element => ({
  id,
  type: 'image',
  x: 0,
  y: 0,
  w: 100,
  h: 80,
  rotation: 0,
  z,
  style: { ...DEFAULT_STYLE },
  locked: false,
  author: { kind: 'human', id: 'u' },
  v: 0,
  data: { blobId: 'a'.repeat(64), naturalW: 200, naturalH: 160 },
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
        return k === 3
          ? mathEl(`e${k}`, z)
          : k === 4
            ? imageEl(`e${k}`, z)
            : shape(`e${k}`, z)
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
            set:
              id === 'e3'
                ? pick([
                    { 'data.latex': 'y^2', 'data.size': 32 },
                    { 'data.display': false },
                  ])
                : id === 'e4'
                  ? pick([
                      { 'data.crop': { x: 0, y: 0, w: 50, h: 40 } },
                      { 'data.crop': null },
                    ])
                  : pick([
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

describe('freehand ops', () => {
  const pen = (): Element => ({
    ...shape('p', 'a0'),
    type: 'freehand',
    data: {
      points: [
        [0, 0],
        [4, 4],
      ],
      pressure: [0.3, 0.6],
      smoothing: 0.5,
      highlighter: false,
    },
  })
  const patch = (set: Record<string, unknown>): Batch => ({
    batchId: 'b',
    label: 'T',
    ops: [{ op: 'patch', id: 'p', set }],
  })

  it('patches a point list, a leaf and pressure, and undoes them', () => {
    const scene = createScene([pen()])
    const { inverse } = applyBatch(
      scene,
      patch({
        'data.points': [
          [0, 0],
          [8, 8],
        ],
        'data.highlighter': true,
        'style.strokeWidth': 18,
      }),
    )
    expect(scene.els.get('p')).toMatchObject({
      style: { strokeWidth: 18 },
      data: {
        highlighter: true,
        points: [
          [0, 0],
          [8, 8],
        ],
      },
    })
    applyBatch(scene, inverse)
    expect(scene.els.get('p')).toEqual({ ...pen(), v: 2 })
    applyBatch(scene, patch({ 'data.pressure': null }))
    expect(scene.els.get('p')?.data).not.toHaveProperty('pressure')
  })

  it('refuses points without matching pressure, naming the field, and leaves the stroke alone', () => {
    const scene = createScene([pen()])
    expect(() =>
      applyBatch(
        scene,
        patch({
          'data.points': [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
        }),
      ),
    ).toThrow(OpError)
    expect(() => applyBatch(scene, patch({ 'data.smoothing': 2 }))).toThrow(
      'data.smoothing must be 0..1',
    )
    expect(() =>
      applyBatch(scene, patch({ 'data.pressure': [0.1, Number.NaN] })),
    ).toThrow('data.pressure')
    expect(scene.els.get('p')).toEqual(pen())
  })
})

describe('chart ops', () => {
  const patch = (set: Record<string, unknown>): Batch => ({
    batchId: 'b',
    label: 'Edit chart',
    ops: [{ op: 'patch', id: 'c', set }],
  })
  const data = (scene: ReturnType<typeof createScene>) =>
    (scene.els.get('c') as { data: Record<string, unknown> }).data

  it('replaces whole leaves of data and undoes them', () => {
    const scene = createScene([chart('c')])
    const before = structuredClone(data(scene))
    const { inverse } = applyBatch(
      scene,
      patch({
        'data.categories': ['A', 'B', 'C', 'D'],
        'data.series': [{ name: 'Sales', values: [3, 5, 2, 9] }],
        'data.title': 'Q',
        'data.kind': 'line',
      }),
    )
    expect(data(scene)).toMatchObject({
      kind: 'line',
      title: 'Q',
      categories: ['A', 'B', 'C', 'D'],
      series: [{ name: 'Sales', values: [3, 5, 2, 9] }],
    })
    applyBatch(scene, inverse)
    expect(data(scene)).toEqual(before)
  })
  it('validates the result as a whole: categories alone cannot leave the series short', () => {
    const scene = createScene([chart('c')])
    expect(() =>
      applyBatch(scene, patch({ 'data.categories': ['A', 'B'] })),
    ).toThrow(OpError)
    expect(data(scene).categories).toEqual(['A', 'B', 'C'])
  })
  it('rejects a bad leaf before anything changes', () => {
    const scene = createScene([chart('c')])
    expect(() =>
      applyBatch(
        scene,
        patch({
          'data.series': [{ name: 'Sales', values: [1, Number.NaN, 3] }],
        }),
      ),
    ).toThrow(OpError)
    expect(() =>
      applyBatch(scene, patch({ 'data.title': 'المبيعات' })),
    ).toThrow(/Latin letters and digits only/)
    expect(() => applyBatch(scene, patch({ 'data.nope': 1 }))).toThrow(
      /not a patchable field/,
    )
    expect(data(scene).series).toEqual([{ name: 'Sales', values: [3, 5, 2] }])
  })
  it('unsets an optional leaf with null', () => {
    const scene = createScene([chart('c', {}, { title: 'T', stacked: true })])
    applyBatch(scene, patch({ 'data.title': null, 'data.stacked': null }))
    expect(data(scene)).not.toHaveProperty('title')
    expect(data(scene)).not.toHaveProperty('stacked')
  })
  it('a path two types share means each type\'s own thing: a chart takes kind "pie", a shape still refuses it', () => {
    const scene = createScene([
      chart('c', {}, { kind: 'line' }),
      shape('r', 'a1'),
    ])
    applyBatch(
      scene,
      patch({
        'data.kind': 'pie',
        'data.series': [{ name: 'Sales', values: [3, 5, 2] }],
      }),
    )
    expect(data(scene).kind).toBe('pie')
    expect(() =>
      applyBatch(scene, {
        batchId: 'b2',
        label: 'T',
        ops: [{ op: 'patch', id: 'r', set: { 'data.kind': 'pie' } }],
      }),
    ).toThrow(OpError)
    expect((scene.els.get('r') as { data: { kind: string } }).data.kind).toBe(
      'rect',
    )
  })
})

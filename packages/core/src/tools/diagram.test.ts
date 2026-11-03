import { describe, expect, it } from 'vitest'
import { bounds } from '../geometry'
import { nodePlatform, registerBundledFonts } from '../node'
import { applyBatch, createScene } from '../scene'
import type { Element } from '../schema'
import { addDiagram, layout } from './diagram'
import { type ToolCtx, ToolError } from './registry'

registerBundledFonts()
const ctx = (): ToolCtx => ({
  scene: createScene(),
  platform: nodePlatform(),
  turnId: 't1',
  author: { kind: 'agent', id: 'tutor:t1' },
  grantedIds: new Set(),
  selection: [],
  added: 0,
})
const run = async (input: unknown, c = ctx()) => {
  const out = await addDiagram.execute(addDiagram.input.parse(input), c)
  if (out.kind !== 'write') throw new Error('not a write')
  applyBatch(c.scene, out.batch) // also validates every element and op
  return { out, c }
}
const nodes = (keys: string[]) =>
  keys.map((k) => ({ key: k, label: `Node ${k}` }))
const boxes = (c: ToolCtx) =>
  [...c.scene.els.values()].filter(
    (e) => e.type === 'shape' && e.data.kind !== 'arrow',
  )
const arrows = (c: ToolCtx) =>
  [...c.scene.els.values()].filter(
    (e) => e.type === 'shape' && e.data.kind === 'arrow',
  )
const overlap = (a: Element, b: Element) => {
  const [p, q] = [bounds(a), bounds(b)]
  return (
    p.minX < q.maxX && p.maxX > q.minX && p.minY < q.maxY && p.maxY > q.minY
  )
}
const noOverlaps = (els: Element[]) => {
  for (let i = 0; i < els.length; i++)
    for (let j = i + 1; j < els.length; j++)
      expect(overlap(els[i] as Element, els[j] as Element)).toBe(false)
}

describe('layout', () => {
  const sizes = (keys: string[]) =>
    new Map(keys.map((k) => [k, { w: 100, h: 50 }]))
  it('puts each node one layer below its parents (a diamond: a -> b,c -> d)', () => {
    const keys = ['a', 'b', 'c', 'd']
    const { pos } = layout(
      keys,
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'd' },
      ],
      sizes(keys),
      'TB',
    )
    const y = (k: string) => pos.get(k)?.y as number
    expect(y('a')).toBeLessThan(y('b'))
    expect(y('b')).toBe(y('c'))
    expect(y('c')).toBeLessThan(y('d'))
    expect((pos.get('a')?.x as number) + 50).toBeCloseTo(
      (pos.get('d')?.x as number) + 50,
      5,
    ) // parents and the join sit on one axis
  })
  it('survives a cycle (the back edge is ignored for layering) and disconnected parts', () => {
    const keys = ['a', 'b', 'c', 'x', 'y']
    const { pos } = layout(
      keys,
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
        { from: 'x', to: 'y' },
      ],
      sizes(keys),
      'TB',
    )
    expect(pos.size).toBe(5)
    expect(pos.get('a')?.y).toBeLessThan(pos.get('b')?.y as number)
    expect(pos.get('b')?.y).toBeLessThan(pos.get('c')?.y as number)
  })
  it('left-to-right swaps the axes', () => {
    const keys = ['a', 'b']
    const { pos } = layout(keys, [{ from: 'a', to: 'b' }], sizes(keys), 'LR')
    expect(pos.get('a')?.x).toBeLessThan(pos.get('b')?.x as number)
    expect(pos.get('a')?.y).toBe(pos.get('b')?.y)
  })
})

describe('add_diagram', () => {
  it('draws a tree as boxes and arrows bound to those boxes, in one batch, with nothing overlapping', async () => {
    const { out, c } = await run({
      title: 'Photosynthesis',
      nodes: nodes(['root', 'l', 'r', 'll', 'lr']),
      edges: [
        { from: 'root', to: 'l' },
        { from: 'root', to: 'r' },
        { from: 'l', to: 'll' },
        { from: 'l', to: 'lr' },
      ],
      placement: { x: 100, y: 100 },
    })
    expect(out.batch.ops.every((o) => o.op === 'add')).toBe(true)
    expect(boxes(c)).toHaveLength(5)
    expect(arrows(c)).toHaveLength(4)
    const ids = new Set(boxes(c).map((b) => b.id))
    for (const a of arrows(c)) {
      const d = (a as Extract<Element, { type: 'shape' }>).data
      expect(ids.has(d.start?.id as string)).toBe(true)
      expect(ids.has(d.end?.id as string)).toBe(true)
    }
    noOverlaps([
      ...boxes(c),
      ...[...c.scene.els.values()].filter((e) => e.type === 'text'),
    ])
    expect(out.info?.nodes).toMatchObject({
      root: expect.any(String),
      lr: expect.any(String),
    })
    expect(out.bounds?.x).toBeGreaterThanOrEqual(100)
    expect(out.batch.label).toBe('Diagram: Photosynthesis')
  })

  it('left-to-right puts the parent left of its child', async () => {
    const { c } = await run({
      nodes: nodes(['a', 'b']),
      edges: [{ from: 'a', to: 'b' }],
      direction: 'LR',
    })
    const [a, b] = boxes(c)
    expect((a as Element).x).toBeLessThan((b as Element).x)
  })

  it('draws edge labels as small text between the boxes, and handles a cycle', async () => {
    const { c } = await run({
      nodes: nodes(['a', 'b']),
      edges: [
        { from: 'a', to: 'b', label: 'yes' },
        { from: 'b', to: 'a', label: 'no' },
      ],
    })
    const labels = [...c.scene.els.values()]
      .filter((e) => e.type === 'text')
      .map((e) => (e as Extract<Element, { type: 'text' }>).data.text)
    expect(labels.sort()).toEqual(['no', 'yes'])
    expect(arrows(c)).toHaveLength(2)
  })

  it('30 nodes lay out fast and without overlaps', async () => {
    const keys = Array.from({ length: 30 }, (_, i) => `n${i}`)
    const edges = keys
      .slice(1)
      .map((k, i) => ({ from: `n${Math.floor(i / 2)}`, to: k }))
    const t0 = performance.now()
    const { c } = await run({ nodes: nodes(keys), edges })
    expect(performance.now() - t0).toBeLessThan(500)
    noOverlaps(boxes(c))
  })

  it('says what is wrong: duplicate keys, an edge to nowhere, too many nodes', async () => {
    const c = ctx()
    const call = (input: unknown) =>
      Promise.resolve().then(() =>
        addDiagram.execute(addDiagram.input.parse(input), c),
      )
    await expect(call({ nodes: nodes(['a', 'a']), edges: [] })).rejects.toThrow(
      /unique/,
    )
    await expect(
      call({ nodes: nodes(['a']), edges: [{ from: 'a', to: 'zz' }] }),
    ).rejects.toBeInstanceOf(ToolError)
    await expect(
      call({ nodes: nodes(['a']), edges: [{ from: 'a', to: 'zz' }] }),
    ).rejects.toThrow(/no node with key "zz"/)
    expect(() =>
      addDiagram.input.parse({
        nodes: nodes(Array.from({ length: 31 }, (_, i) => `n${i}`)),
        edges: [],
      }),
    ).toThrow()
  })

  it('warns when a big diagram passes the soft element budget', async () => {
    const keys = Array.from({ length: 25 }, (_, i) => `n${i}`)
    const { out } = await run({
      nodes: nodes(keys),
      edges: keys.slice(1).map((k, i) => ({ from: keys[i] as string, to: k })),
    })
    expect(out.kind === 'write' && out.warnings?.[0]).toMatch(/soft limit/)
  })
})

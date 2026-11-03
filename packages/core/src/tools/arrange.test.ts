import { describe, expect, it } from 'vitest'
import { nodePlatform } from '../node'
import { applyBatch, createScene } from '../scene'
import type { Element } from '../schema'
import { mk } from '../test-utils'
import { arrange } from './arrange'
import { coreTools } from './index'
import type { ToolCtx } from './registry'

const mine = (id: string, x: number, y: number, w = 100, h = 40): Element =>
  mk(id, { x, y, w, h, author: { kind: 'agent', id: 'tutor:t1' } })
const students = (id: string, x: number, y: number): Element =>
  mk(id, { x, y, w: 100, h: 40 })
const ctx = (els: Element[], granted: string[] = []): ToolCtx => ({
  scene: createScene(els),
  platform: nodePlatform(),
  turnId: 't1',
  author: { kind: 'agent', id: 'tutor:t1' },
  grantedIds: new Set(granted),
  selection: [],
  added: 0,
})
const run = async (input: unknown, c: ToolCtx) => {
  const out = await arrange.execute(arrange.input.parse(input), c)
  if (out.kind !== 'write')
    throw new Error(`not a write: ${JSON.stringify(out)}`)
  applyBatch(c.scene, out.batch) // also validates every op
  return out
}
const pos = (c: ToolCtx, id: string) => {
  const e = c.scene.els.get(id) as Element
  return { x: e.x, y: e.y }
}
const fails = (input: unknown, c: ToolCtx, field: string, message: RegExp) =>
  expect(
    Promise.resolve().then(() =>
      arrange.execute(arrange.input.parse(input), c),
    ),
  ).rejects.toMatchObject({ name: 'ToolError', field, message })

describe('arrange', () => {
  it('align left puts every left edge on the leftmost, in one labelled batch that moves nothing else', async () => {
    const c = ctx([mine('a', 10, 100), mine('b', 60, 20), mine('c', 300, 220)])
    const out = await run(
      { action: 'align', ids: ['a', 'b', 'c'], to: 'left' },
      c,
    )
    expect(['a', 'b', 'c'].map((id) => pos(c, id).x)).toEqual([10, 10, 10])
    expect(['a', 'b', 'c'].map((id) => pos(c, id).y)).toEqual([100, 20, 220])
    expect(out.batch.label).toBe('Align left')
    expect(out.ids).toEqual([]) // nothing was created
    expect(out.bounds).toMatchObject({ x: 10 })
  })

  it('distribute makes three equal gaps', async () => {
    const c = ctx([mine('a', 0, 0), mine('b', 50, 0), mine('c', 400, 0)])
    await run(
      { action: 'distribute', ids: ['c', 'a', 'b'], axis: 'horizontal' },
      c,
    )
    expect(['a', 'b', 'c'].map((id) => pos(c, id).x)).toEqual([0, 200, 400])
  })

  it('stack puts a column at the gap, 24 unless told, ordered by position', async () => {
    const c = ctx([mine('c', 10, 200), mine('a', 50, 10), mine('b', 300, 120)])
    await run({ action: 'stack', ids: ['a', 'b', 'c'], direction: 'column' }, c)
    expect(['a', 'b', 'c'].map((id) => pos(c, id))).toEqual([
      { x: 10, y: 10 },
      { x: 10, y: 74 },
      { x: 10, y: 138 },
    ])
    const d = ctx([mine('a', 0, 0), mine('b', 400, 90)])
    await run(
      {
        action: 'stack',
        ids: ['a', 'b'],
        direction: 'row',
        gap: 10,
        align: 'centre',
      },
      d,
    )
    expect(pos(d, 'b').x).toBe(110)
  })

  it('arrows attached to what moved follow it, in the same batch', async () => {
    const arrow = mk('arr', {
      x: 100,
      y: 20,
      w: 200,
      h: 180,
      author: { kind: 'agent', id: 'tutor:t1' },
      data: {
        kind: 'arrow',
        points: [
          [0, 0],
          [200, 180],
        ],
        start: { id: 'a', fx: 1, fy: 0.5 },
        end: { id: 'b', fx: 0, fy: 0.5 },
      },
    })
    const c = ctx([mine('a', 0, 0), mine('b', 300, 200), arrow])
    const out = await run({ action: 'align', ids: ['a', 'b'], to: 'top' }, c)
    expect(out.batch.ops.some((o) => o.op === 'patch' && o.id === 'arr')).toBe(
      true,
    )
    const e = c.scene.els.get('arr') as Element
    expect(e.h).toBeCloseTo(0, 6) // both ends are at y 20 now
  })

  it("a student's element that was not selected is refused, a selected one is arranged, a locked one is never touched", async () => {
    const c = ctx([mine('a', 0, 0), students('s', 200, 80)])
    await fails(
      { action: 'align', ids: ['a', 's'], to: 'left' },
      c,
      'ids',
      /belongs to the student and was not selected/,
    )
    expect(pos(c, 's')).toEqual({ x: 200, y: 80 })
    const g = ctx([mine('a', 0, 0), students('s', 200, 80)], ['s'])
    await run({ action: 'align', ids: ['a', 's'], to: 'left' }, g)
    expect(pos(g, 's').x).toBe(0)
    const l = ctx([
      mine('a', 0, 0),
      mk('k', {
        x: 200,
        y: 80,
        w: 100,
        h: 40,
        locked: true,
        author: { kind: 'agent', id: 'tutor:t1' },
      }),
    ])
    await fails(
      { action: 'align', ids: ['a', 'k'], to: 'left' },
      l,
      'ids',
      /locked/,
    )
  })

  it('does not reroute the arrows of the student that the tutor may not edit', async () => {
    const arrow = mk('arr', {
      x: 100,
      y: 20,
      w: 200,
      h: 180,
      data: {
        kind: 'arrow',
        points: [
          [0, 0],
          [200, 180],
        ],
        start: { id: 'a', fx: 1, fy: 0.5 },
        end: { id: 'b', fx: 0, fy: 0.5 },
      },
    })
    const c = ctx([mine('a', 0, 0), mine('b', 300, 200), arrow])
    const out = await run({ action: 'align', ids: ['a', 'b'], to: 'top' }, c)
    expect(out.batch.ops.some((o) => o.op === 'patch' && o.id === 'arr')).toBe(
      false,
    )
  })

  it('names the field when the call is wrong', async () => {
    const c = () => ctx([mine('a', 0, 0), mine('b', 50, 50), mine('c', 90, 90)])
    await fails(
      { action: 'align', ids: ['a'], to: 'left' },
      c(),
      'ids',
      /at least 2/,
    )
    await fails(
      { action: 'align', ids: ['a', 'zz'], to: 'left' },
      c(),
      'ids',
      /no element zz/,
    )
    await fails({ action: 'align', ids: ['a', 'b'] }, c(), 'to', /required/)
    await fails(
      { action: 'distribute', ids: ['a', 'b'], axis: 'vertical' },
      c(),
      'ids',
      /at least 3/,
    )
    await fails(
      { action: 'distribute', ids: ['a', 'b', 'c'] },
      c(),
      'axis',
      /required/,
    )
    await fails(
      { action: 'stack', ids: ['a', 'b'] },
      c(),
      'direction',
      /required/,
    )
  })

  it('says so, and changes nothing, when they are already arranged', async () => {
    const c = ctx([mine('a', 10, 0), mine('b', 10, 80)])
    const out = await arrange.execute(
      arrange.input.parse({ action: 'align', ids: ['a', 'b'], to: 'left' }),
      c,
    )
    expect(out).toMatchObject({ kind: 'read', data: { ok: true } })
  })

  it('is in the core registry and its input can take the snapshot flag the adapter adds (a plain object)', () => {
    expect(coreTools.map((t) => t.name)).toContain('arrange')
    expect(() =>
      (arrange.input as unknown as { extend: (s: object) => unknown }).extend(
        {},
      ),
    ).not.toThrow()
  })
})

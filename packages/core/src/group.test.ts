import { describe, expect, it } from 'vitest'
import { bounds, hitTest } from './geometry'
import {
  deleteWithGroups,
  expandToUnits,
  groupBatch,
  groupMembers,
  moveGroupsWith,
  topGroup,
  ungroupBatch,
} from './group'
import { applyBatch, createScene, type Scene } from './scene'
import { type Batch, type Element, ElementSchema } from './schema'
import { mk } from './test-utils'
import { describeElement } from './tools/describe'

const box = (
  id: string,
  x: number,
  y: number,
  extra: { locked?: boolean } = {},
) => mk(id, { x, y, w: 100, h: 40, ...extra })
const owner = { kind: 'human' as const, id: 'local' }
const apply = (scene: Scene, b: Batch | null) => {
  expect(b).not.toBeNull()
  const s = { els: new Map(scene.els) }
  applyBatch(s, b as Batch)
  return s
}
const grouped = () => {
  const scene = createScene([
    box('a', 0, 0),
    box('b', 200, 100),
    box('c', 500, 500),
  ])
  const s = apply(scene, groupBatch(scene, ['a', 'b'], owner, 'Pair'))
  const g = [...s.els.values()].find((e) => e.type === 'group') as Element
  return { s, g }
}

describe('group element', () => {
  it('is valid, draws nothing, is never hit, and reads as a group with its children', () => {
    const { s, g } = grouped()
    expect(ElementSchema.safeParse(g).success).toBe(true)
    expect(g).toMatchObject({
      x: 0,
      y: 0,
      w: 300,
      h: 140,
      data: { name: 'Pair' },
    })
    expect(hitTest(g, { x: 150, y: 70 }, 6)).toBe(false)
    expect(bounds(g)).toEqual({ minX: 0, minY: 0, maxX: 300, maxY: 140 })
    expect(s.els.get('a')?.parentId).toBe(g.id)
    expect(describeElement(g).detail).toBe('group "Pair"')
  })
})

describe('groupBatch and ungroupBatch', () => {
  it('group then ungroup is the identity on the members', () => {
    const { s, g } = grouped()
    const u = apply(s, ungroupBatch(s, g.id))
    expect(u.els.has(g.id)).toBe(false)
    expect(u.els.get('a')).toMatchObject({ x: 0, y: 0 })
    expect(u.els.get('a')?.parentId).toBeUndefined()
    expect(u.els.get('b')?.parentId).toBeUndefined()
  })

  it('needs two units, and no locked member', () => {
    const scene = createScene([
      box('a', 0, 0),
      box('k', 200, 0, { locked: true }),
    ])
    expect(groupBatch(scene, ['a'], owner)).toBeNull()
    expect(groupBatch(scene, ['a', 'k'], owner)).toBeNull()
    expect(groupBatch(scene, ['a', 'nope'], owner)).toBeNull()
  })

  it('nests: grouping a group and another element makes one top group, ungroup peels one level', () => {
    const { s, g } = grouped()
    const s2 = apply(s, groupBatch(s, ['a', 'c'], owner)) // a is in g: the unit is g, so g and c
    const outer = [...s2.els.values()].find(
      (e) => e.type === 'group' && e.id !== g.id,
    ) as Element
    expect(s2.els.get(g.id)?.parentId).toBe(outer.id)
    expect(s2.els.get('c')?.parentId).toBe(outer.id)
    expect(
      groupMembers(s2, outer.id)
        .map((e) => e.id)
        .sort(),
    ).toEqual(['a', 'b', 'c'])
    expect(topGroup(s2, s2.els.get('a') as Element)?.id).toBe(outer.id)
    const s3 = apply(s2, ungroupBatch(s2, outer.id))
    expect(s3.els.get(g.id)?.parentId).toBeUndefined()
    expect(topGroup(s3, s3.els.get('a') as Element)?.id).toBe(g.id)
  })

  it('ungroup of something that is not a group is null', () => {
    const { s } = grouped()
    expect(ungroupBatch(s, 'a')).toBeNull()
  })
})

describe('units', () => {
  it('selecting any member selects all members of its top group, and loose elements stay single', () => {
    const { s } = grouped()
    expect([...expandToUnits(s, ['a'])].sort()).toEqual(['a', 'b'])
    expect([...expandToUnits(s, ['c'])]).toEqual(['c'])
    expect([...expandToUnits(s, ['a', 'c'])].sort()).toEqual(['a', 'b', 'c'])
  })
  it('never contains a group element itself', () => {
    const { s, g } = grouped()
    expect(expandToUnits(s, [g.id]).has(g.id)).toBe(false)
    expect([...expandToUnits(s, [g.id])].sort()).toEqual(['a', 'b'])
  })
})

describe('moving and deleting groups', () => {
  it('moving members moves their group boxes with them, once', () => {
    const { s, g } = grouped()
    const patches = moveGroupsWith(s, ['a', 'b'], 10, 20)
    expect(patches.get(g.id)).toEqual({ x: 10, y: 20 })
    expect(patches.size).toBe(1)
  })
  it('deleting all members removes the group; deleting some keeps it', () => {
    const { s, g } = grouped()
    expect(deleteWithGroups(s, ['a', 'b'])).toEqual([g.id])
    expect(deleteWithGroups(s, ['a'])).toEqual([])
  })
})

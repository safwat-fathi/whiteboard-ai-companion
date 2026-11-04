import { bounds, type Patch, type Rect } from './geometry'
import { type Scene, topZ, zBetween } from './scene'
import {
  type Batch,
  DEFAULT_STYLE,
  type Element,
  type Id,
  newId,
  type Op,
} from './schema'

// Groups (R11). A group is an element that draws nothing; its children carry `parentId`, and groups can nest. A selection
// holds leaf elements only: picking any member selects every member of its outermost group (`expandToUnits`), so move,
// delete and resize act on leaves and the group elements just follow. ponytail: a group's box is the union of its members
// when it was made (and follows moves); a member the tutor moves on its own leaves it stale, which nothing reads.

/** The outermost group above `el`, or null when it is in none. */
export function topGroup(scene: Scene, el: Element): Element | null {
  let top: Element | null = null
  let cur = el.parentId ? scene.els.get(el.parentId) : undefined
  for (let hops = 0; cur?.type === 'group' && hops < 100; hops++) {
    top = cur
    cur = cur.parentId ? scene.els.get(cur.parentId) : undefined
  }
  return top
}

/** Every non-group element under a group, at any depth. */
export function groupMembers(scene: Scene, groupId: Id): Element[] {
  const out: Element[] = []
  const walk = (id: Id, depth: number) => {
    if (depth > 100) return
    for (const el of scene.els.values())
      if (el.parentId === id) {
        if (el.type === 'group') walk(el.id, depth + 1)
        else out.push(el)
      }
  }
  walk(groupId, 0)
  return out
}

/** The leaf ids a selection of `ids` stands for: all members of each one's outermost group, never a group element. */
export function expandToUnits(scene: Scene, ids: Iterable<Id>): Set<Id> {
  const out = new Set<Id>()
  for (const id of ids) {
    const el = scene.els.get(id)
    if (!el) continue
    const unit = topGroup(scene, el) ?? el
    if (unit.type === 'group')
      for (const m of groupMembers(scene, unit.id)) out.add(m.id)
    else out.add(el.id)
  }
  return out
}

const union = (rs: Rect[]): Rect => ({
  minX: Math.min(...rs.map((r) => r.minX)),
  minY: Math.min(...rs.map((r) => r.minY)),
  maxX: Math.max(...rs.map((r) => r.maxX)),
  maxY: Math.max(...rs.map((r) => r.maxY)),
})

/** Groups the units `ids` stand for (two or more, none locked): one batch that adds the group and sets `parentId`. */
export function groupBatch(
  scene: Scene,
  ids: Iterable<Id>,
  author: Element['author'],
  name?: string,
): Batch | null {
  const units = new Map<Id, Element>()
  for (const id of ids) {
    const el = scene.els.get(id)
    if (!el) return null
    const unit = topGroup(scene, el) ?? el
    units.set(unit.id, unit)
  }
  if (units.size < 2) return null
  const leaves = [...units.values()].flatMap((u) =>
    u.type === 'group' ? groupMembers(scene, u.id) : [u],
  )
  if (leaves.length < 2 || leaves.some((l) => l.locked)) return null
  const b = union(leaves.map(bounds))
  const gid = newId()
  const group: Element = {
    id: gid,
    type: 'group',
    x: b.minX,
    y: b.minY,
    w: b.maxX - b.minX,
    h: b.maxY - b.minY,
    rotation: 0,
    z: zBetween(topZ(scene), null),
    style: { ...DEFAULT_STYLE },
    locked: false,
    author,
    v: 0,
    data: name ? { name } : {},
  }
  const ops: Op[] = [{ op: 'add', el: group }]
  for (const u of units.values())
    ops.push({ op: 'patch', id: u.id, set: { parentId: gid } })
  return { batchId: newId(), label: 'Group', ops }
}

/** Dissolves one level: the group goes, its children take its parent (or none). */
export function ungroupBatch(scene: Scene, groupId: Id): Batch | null {
  const g = scene.els.get(groupId)
  if (g?.type !== 'group' || g.locked) return null
  const ops: Op[] = []
  for (const el of scene.els.values())
    if (el.parentId === groupId)
      ops.push({
        op: 'patch',
        id: el.id,
        set: { parentId: g.parentId ?? null },
      })
  ops.push({ op: 'remove', id: groupId })
  return { batchId: newId(), label: 'Ungroup', ops }
}

/** Patches that carry each group's box along when all of its members moved by (dx, dy). */
export function moveGroupsWith(
  scene: Scene,
  movedIds: Iterable<Id>,
  dx: number,
  dy: number,
): Map<Id, Patch> {
  const moved = new Set(movedIds)
  const out = new Map<Id, Patch>()
  const seen = new Set<Id>()
  for (const id of moved) {
    let cur = scene.els.get(id)?.parentId
    for (let hops = 0; cur && hops < 100 && !seen.has(cur); hops++) {
      seen.add(cur)
      const g = scene.els.get(cur)
      if (g?.type !== 'group') break
      if (groupMembers(scene, g.id).every((m) => moved.has(m.id)))
        out.set(g.id, { x: g.x + dx, y: g.y + dy })
      cur = g.parentId
    }
  }
  return out
}

/** The groups that go with deleted leaves: those left with no member. */
export function deleteWithGroups(scene: Scene, deletedIds: Iterable<Id>): Id[] {
  const gone = new Set(deletedIds)
  const out: Id[] = []
  const groups = [...scene.els.values()].filter((e) => e.type === 'group')
  for (const g of groups) {
    const members = groupMembers(scene, g.id)
    if (members.length > 0 && members.every((m) => gone.has(m.id)))
      out.push(g.id)
  }
  return out
}

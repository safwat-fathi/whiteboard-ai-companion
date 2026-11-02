import { generateKeyBetween } from 'fractional-indexing'
import { leaf, OpError, validateBatch } from './ops'
import {
  type Batch,
  type Element,
  ElementSchema,
  type Id,
  newId,
  ShapeElementSchema,
  TextElementSchema,
} from './schema'

export type Scene = { els: Map<Id, Element> }

export const createScene = (els: Element[] = []): Scene => ({
  els: new Map(els.map((e) => [e.id, e])),
})

export const ordered = (scene: Scene): Element[] =>
  [...scene.els.values()].sort(
    (a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : 0) || (a.id < b.id ? -1 : 1),
  )

export const zBetween = (a: string | null, b: string | null): string =>
  generateKeyBetween(a, b)

// Set one dotted leaf path (null on an optional leaf deletes it). Plain assignment only, never a merge.
function setPath(el: Element, key: string, value: unknown) {
  const path = key.split('.')
  const schema = el.type === 'shape' ? ShapeElementSchema : TextElementSchema
  const unset = value === null && leaf(schema, path)?.def.type === 'optional'
  let o = el as unknown as Record<string, unknown>
  for (const seg of path.slice(0, -1)) {
    if (!Object.hasOwn(o, seg)) {
      if (unset) return
      o[seg] = {}
    }
    o = o[seg] as Record<string, unknown>
  }
  const last = path[path.length - 1] as string
  if (unset) delete o[last]
  else o[last] = structuredClone(value)
}

export function applyBatch(
  scene: Scene,
  input: Batch,
): { inverse: Batch; touched: Id[] } {
  const batch = validateBatch(input)
  const draft = new Map(scene.els) // elements are replaced, never mutated, until commit
  const touched = new Set<Id>()
  for (const op of batch.ops) {
    touched.add(op.op === 'add' ? op.el.id : op.id)
    if (op.op === 'add') {
      if (draft.has(op.el.id))
        throw new OpError('id', `${op.el.id} already exists`)
      draft.set(op.el.id, structuredClone(op.el))
    } else if (op.op === 'remove') draft.delete(op.id)
    else {
      const cur = draft.get(op.id)
      if (!cur) continue // patch/reorder of a removed or unknown id is dropped
      const el = structuredClone(cur)
      el.v = cur.v + 1
      if (op.op === 'reorder') el.z = op.z
      else for (const [k, v] of Object.entries(op.set)) setPath(el, k, v)
      const r = ElementSchema.safeParse(el)
      if (!r.success)
        throw new OpError(
          op.op === 'patch' ? Object.keys(op.set).join(',') : 'z',
          r.error.issues[0]?.message ?? 'is invalid',
        )
      draft.set(op.id, el)
    }
  }
  // Inverse is a state diff: remove what exists now, re-add what existed before (restores v exactly).
  const ops: Batch['ops'] = []
  for (const id of touched) if (draft.has(id)) ops.push({ op: 'remove', id })
  for (const id of touched) {
    const was = scene.els.get(id)
    if (was) ops.push({ op: 'add', el: structuredClone(was) })
  }
  for (const id of touched) {
    const now = draft.get(id)
    if (now) scene.els.set(id, now)
    else scene.els.delete(id)
  }
  return {
    inverse: { batchId: newId(), label: `Undo ${batch.label}`, ops },
    touched: [...touched],
  }
}

import { generateKeyBetween } from 'fractional-indexing'
import { leaf, OpError, validateBatch } from './ops'
import {
  type Batch,
  ChartElementSchema,
  type Element,
  ElementSchema,
  FreehandElementSchema,
  GroupElementSchema,
  type Id,
  ImageElementSchema,
  MathElementSchema,
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

const SCHEMA = {
  shape: ShapeElementSchema,
  text: TextElementSchema,
  math: MathElementSchema,
  image: ImageElementSchema,
  freehand: FreehandElementSchema,
  chart: ChartElementSchema,
  group: GroupElementSchema,
}

// Current value at a dotted path, or null if absent (absent only happens on optional leaves).
function getPath(el: Element, key: string): unknown {
  let o: unknown = el
  for (const seg of key.split('.')) {
    if (typeof o !== 'object' || o === null || !Object.hasOwn(o, seg))
      return null
    o = (o as Record<string, unknown>)[seg]
  }
  return structuredClone(o)
}

// Set one dotted leaf path (null on an optional leaf deletes it). Plain assignment only, never a merge.
function setPath(el: Element, key: string, value: unknown) {
  const path = key.split('.')
  const schema = SCHEMA[el.type]
  // A leaf that is both optional and nullable cannot store an explicit null; null always unsets.
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

/**
 * Applies a batch atomically. `inverse` is field-level (patch restores prior values, add<->remove,
 * reorder restores prior z) and its ops are in reverse order. `v` is monotonic: the inverse does not
 * restore it, its own application bumps it. An empty `inverse.ops` means "no change" (every op was
 * dropped); callers must not apply it (validateBatch requires at least one op).
 */
export function applyBatch(
  scene: Scene,
  input: Batch,
): { inverse: Batch; touched: Id[] } {
  const batch = validateBatch(input)
  const draft = new Map(scene.els) // elements are replaced, never mutated, until commit
  const touched = new Set<Id>()
  const inv: Batch['ops'] = []
  for (const op of batch.ops) {
    touched.add(op.op === 'add' ? op.el.id : op.id)
    if (op.op === 'add') {
      if (draft.has(op.el.id))
        throw new OpError('id', `${op.el.id} already exists`)
      draft.set(op.el.id, structuredClone(op.el))
      inv.push({ op: 'remove', id: op.el.id })
    } else if (op.op === 'remove') {
      const cur = draft.get(op.id)
      if (cur) inv.push({ op: 'add', el: structuredClone(cur) })
      draft.delete(op.id)
    } else {
      const cur = draft.get(op.id)
      if (!cur) continue // patch/reorder of a removed or unknown id is dropped
      const el = structuredClone(cur)
      el.v = cur.v + 1
      if (op.op === 'reorder') {
        el.z = op.z
        inv.push({ op: 'reorder', id: op.id, z: cur.z })
      } else {
        const set: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(op.set)) {
          set[k] = getPath(cur, k)
          setPath(el, k, v)
        }
        inv.push({ op: 'patch', id: op.id, set })
      }
      const r = ElementSchema.safeParse(el)
      if (!r.success)
        throw new OpError(
          op.op === 'patch' ? Object.keys(op.set).join(',') : 'z',
          r.error.issues[0]?.message ?? 'is invalid',
        )
      draft.set(op.id, el)
    }
  }
  for (const id of touched) {
    const now = draft.get(id)
    if (now) scene.els.set(id, now)
    else scene.els.delete(id)
  }
  return {
    inverse: {
      batchId: newId(),
      label: `Undo ${batch.label}`,
      ops: inv.reverse(),
    },
    touched: [...touched],
  }
}

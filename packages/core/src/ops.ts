import type { z } from 'zod'
import {
  type Batch,
  BatchSchema,
  ChartElementSchema,
  FreehandElementSchema,
  GroupElementSchema,
  ImageElementSchema,
  MathElementSchema,
  ShapeElementSchema,
  TextElementSchema,
} from './schema'

export class OpError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(`${field} ${message}`)
    this.name = 'OpError'
  }
}

const NOT_PATCHABLE = new Set(['type', 'id', 'v', 'author'])

// Whole style/data objects are accepted if they validate; callers should patch leaf paths (e.g. `data.kind`).
// Follow a dotted path through object schemas (unwrapping optional/nullable); undefined if unknown.
export function leaf(root: z.ZodType, path: string[]): z.ZodType | undefined {
  let s = root
  for (const key of path) {
    while (s.def.type === 'optional' || s.def.type === 'nullable')
      s = (s as z.ZodOptional).unwrap() as z.ZodType
    if (s.def.type !== 'object') return undefined
    const shape = (s as z.ZodObject).shape
    if (!Object.hasOwn(shape, key)) return undefined
    s = shape[key] as z.ZodType
  }
  return s
}

const ELEMENT_SCHEMAS = [
  ShapeElementSchema,
  TextElementSchema,
  MathElementSchema,
  ImageElementSchema,
  FreehandElementSchema,
  ChartElementSchema,
  GroupElementSchema,
]

// A patch names no element type, so a path such as `data.kind` may mean different things on different types (a shape's
// kind and a chart's). The value passes if any type that has the path takes it; applyBatch then validates the patched
// element against its own type, which has the last word.
function checkPatch(set: Record<string, unknown>) {
  for (const [key, value] of Object.entries(set)) {
    const path = key.split('.')
    const schemas = NOT_PATCHABLE.has(path[0] ?? '')
      ? []
      : ELEMENT_SCHEMAS.flatMap((e) => leaf(e, path) ?? [])
    if (!schemas.length) throw new OpError(key, 'is not a patchable field')
    // Convention: null on an optional field means "unset it"; required fields reject null.
    if (value === null && schemas.some((s) => s.def.type === 'optional'))
      continue
    const results = schemas.map((s) => s.safeParse(value))
    if (!results.some((r) => r.success))
      throw new OpError(
        key,
        results[0]?.error?.issues[0]?.message ?? 'is invalid',
      )
  }
}

export function validateBatch(input: unknown): Batch {
  // zod's record silently drops an own `__proto__` key, so reject it from the raw input.
  const ops = (input as { ops?: unknown } | null)?.ops
  if (Array.isArray(ops))
    for (const op of ops as ({ op?: unknown; set?: unknown } | null)[])
      if (
        op?.op === 'patch' &&
        typeof op.set === 'object' &&
        op.set &&
        Object.hasOwn(op.set, '__proto__')
      )
        throw new OpError('__proto__', 'is not a patchable field')
  const r = BatchSchema.safeParse(input)
  if (!r.success) {
    const { path, message } = r.error.issues[0] as z.core.$ZodIssue
    // Report element fields relative to the element: ops.0.el.style.opacity -> style.opacity
    const p = path.map(String)
    const field =
      (p[0] === 'ops' && p[2] === 'el' ? p.slice(3) : p).join('.') || 'batch'
    throw new OpError(field, message)
  }
  for (const op of r.data.ops) if (op.op === 'patch') checkPatch(op.set)
  return r.data
}

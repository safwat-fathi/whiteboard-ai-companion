import { nanoid } from 'nanoid'
import { z } from 'zod'

export type Id = string
export const newId = (): Id => nanoid()

const num = z.number('must be a finite number')
const size = num.min(0, 'must be >= 0')
const id = z.string().min(1, 'must not be empty')

export const StyleSchema = z.object({
  stroke: z.string(),
  fill: z.string().nullable(),
  strokeWidth: num.min(0, 'must be 0..100').max(100, 'must be 0..100'),
  opacity: num.min(0, 'must be 0..1').max(1, 'must be 0..1'),
  dash: z.enum(['solid', 'dashed', 'dotted']),
})
export type Style = z.infer<typeof StyleSchema>
export const DEFAULT_STYLE: Style = {
  stroke: '#1e1e1e',
  fill: null,
  strokeWidth: 2,
  opacity: 1,
  dash: 'solid',
}

export const BindingSchema = z.object({
  id,
  fx: num.min(0, 'must be 0..1').max(1, 'must be 0..1'),
  fy: num.min(0, 'must be 0..1').max(1, 'must be 0..1'),
})
export type Binding = z.infer<typeof BindingSchema>

export const ShapeDataSchema = z.object({
  kind: z.enum(['rect', 'ellipse', 'diamond', 'triangle', 'line', 'arrow']),
  radius: size.optional(),
  label: z.string().max(10_000, 'must be at most 10000 chars').optional(),
  arrowheads: z.object({ start: z.boolean(), end: z.boolean() }).optional(),
  points: z
    .array(z.tuple([num, num]))
    .max(10_000, 'must have at most 10000 points')
    .optional(),
  start: BindingSchema.optional(),
  end: BindingSchema.optional(),
})
export type ShapeData = z.infer<typeof ShapeDataSchema>

export const TextDataSchema = z.object({
  text: z.string().max(100_000, 'must be at most 100000 chars'),
  size: num.min(1, 'must be 1..1000').max(1000, 'must be 1..1000'),
  align: z.enum(['left', 'center', 'right']),
  dir: z.enum(['auto', 'ltr', 'rtl']),
  maxWidth: size.optional(),
})
export type TextData = z.infer<typeof TextDataSchema>

export const BaseShape = {
  id,
  x: num,
  y: num,
  w: size,
  h: size,
  rotation: num,
  z: z.string().min(1, 'must not be empty'),
  style: StyleSchema,
  parentId: id.optional(),
  locked: z.boolean(),
  author: z.object({ kind: z.enum(['human', 'agent']), id }),
  v: num.int('must be an integer').min(0, 'must be >= 0'),
}

export const ShapeElementSchema = z.object({
  ...BaseShape,
  type: z.literal('shape'),
  data: ShapeDataSchema,
})
export const TextElementSchema = z.object({
  ...BaseShape,
  type: z.literal('text'),
  data: TextDataSchema,
})
export const ElementSchema = z.discriminatedUnion('type', [
  ShapeElementSchema,
  TextElementSchema,
])
export type Element = z.infer<typeof ElementSchema>

export const OpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), el: ElementSchema }),
  z.object({
    op: z.literal('patch'),
    id,
    set: z.record(z.string(), z.unknown()),
  }),
  z.object({ op: z.literal('remove'), id }),
  z.object({
    op: z.literal('reorder'),
    id,
    z: z.string().min(1, 'must not be empty'),
  }),
])
export type Op = z.infer<typeof OpSchema>

export const BatchSchema = z.object({
  batchId: id,
  label: z.string(),
  ops: z.array(OpSchema).min(1, 'must have at least one op'),
})
export type Batch = z.infer<typeof BatchSchema>

/** (x, y) is the world point at the viewport's top-left (not the centre); zoom is CSS px per world unit. */
export type Camera = { x: number; y: number; zoom: number }
export const ZOOM_MIN = 0.05
export const ZOOM_MAX = 20
export type Viewport = { width: number; height: number; dpr: number }

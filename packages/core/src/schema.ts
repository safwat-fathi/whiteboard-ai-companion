import { generateKeyBetween } from 'fractional-indexing'
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

export const MathDataSchema = z.object({
  latex: z
    .string()
    .min(1, 'must not be empty')
    .max(4000, 'must be at most 4000 chars'),
  display: z.boolean(),
  size: num.min(8, 'must be 8..1000').max(1000, 'must be 8..1000'),
})
export type MathData = z.infer<typeof MathDataSchema>

export const CropSchema = z.object({
  x: num.min(0, 'must be >= 0'),
  y: num.min(0, 'must be >= 0'),
  w: num.min(1, 'must be >= 1'),
  h: num.min(1, 'must be >= 1'),
})
export type Crop = z.infer<typeof CropSchema>

/** Where an image came from; absent means the student uploaded it. `page` is the 1-based position in the book's PDF. */
export const ImageSourceSchema = z.object({
  bookPage: z.object({
    bookId: z
      .string()
      .regex(
        /^[A-Za-z0-9-]{1,64}$/,
        'must be a book id (letters, digits, dashes)',
      ),
    page: num
      .int('must be an integer')
      .min(1, 'must be 1..100000')
      .max(100000, 'must be 1..100000'),
  }),
})
export type ImageSource = z.infer<typeof ImageSourceSchema>

export const ImageDataSchema = z
  .object({
    blobId: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'must be a 64-char lowercase hex sha256'),
    naturalW: num
      .int('must be an integer')
      .min(1, 'must be 1..8192')
      .max(8192, 'must be 1..8192'),
    naturalH: num
      .int('must be an integer')
      .min(1, 'must be 1..8192')
      .max(8192, 'must be 1..8192'),
    crop: CropSchema.optional(),
    alt: z.string().max(500, 'must be at most 500 chars').optional(),
    source: ImageSourceSchema.optional(),
  })
  .refine(
    (d) =>
      !d.crop ||
      (d.crop.x + d.crop.w <= d.naturalW && d.crop.y + d.crop.h <= d.naturalH),
    { message: 'crop must lie within naturalW x naturalH', path: ['crop'] },
  )
export type ImageData = z.infer<typeof ImageDataSchema>

const unit = num.min(0, 'must be 0..1').max(1, 'must be 0..1')

/** A pen or highlighter stroke. `points` are relative to the element's x,y (like a line's); the width is `style.strokeWidth`. Rounding is the caller's job: this only checks finiteness, counts and ranges. */
export const FreehandDataSchema = z
  .object({
    points: z
      .array(z.tuple([num, num]))
      .min(1, 'must have at least one point')
      .max(10_000, 'must have at most 10000 points'),
    pressure: z
      .array(unit)
      .max(10_000, 'must have at most 10000 values')
      .optional(),
    smoothing: unit,
    highlighter: z.boolean(),
  })
  .refine((d) => !d.pressure || d.pressure.length === d.points.length, {
    message: 'must have one value per point',
    path: ['pressure'],
  })
export type FreehandData = z.infer<typeof FreehandDataSchema>

// R7: Basic Latin to Latin Extended-B, general punctuation, currency, letterlike, arrows, math operators. One font, one layout,
// identical in the browser and on the server; Arabic text and math stay on the board around the chart.
const CHART_LABEL =
  /^[\u0020-\u007E\u00A0-\u024F\u2000-\u206F\u20A0-\u20CF\u2100-\u214F\u2190-\u21FF\u2200-\u22FF]*$/
const chartLabel = (max: number) =>
  z
    .string()
    .max(max, `must be at most ${max} characters`)
    .regex(CHART_LABEL, 'chart labels support Latin letters and digits only')
// Past a quadrillion a chart means nothing, and tick steps stop being exact (2^53 is about 9e15).
const chartNum = num
  .min(-1e15, 'must be between -1e15 and 1e15')
  .max(1e15, 'must be between -1e15 and 1e15')
const ChartSeriesSchema = z.object({
  name: chartLabel(40),
  values: z.array(chartNum).max(200, 'must have at most 200 values'),
  /** Scatter only: the x of each value. */
  xs: z.array(chartNum).max(200, 'must have at most 200 values').optional(),
})

/** A data-driven chart (R6). Whole `categories` and `series` leaves are replaced on edit, never patched by index. */
export const ChartDataSchema = z
  .object({
    kind: z.enum(['bar', 'line', 'area', 'pie', 'donut', 'scatter']),
    title: chartLabel(120).optional(),
    categories: z
      .array(chartLabel(40))
      .max(50, 'must have at most 50 categories'),
    series: z.array(ChartSeriesSchema).max(8, 'must have at most 8 series'),
    stacked: z.boolean().optional(),
    xLabel: chartLabel(40).optional(),
    yLabel: chartLabel(40).optional(),
    palette: z
      .array(z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour'))
      .max(8, 'must have at most 8 colours')
      .optional(),
  })
  .superRefine((d, ctx) => {
    const bad = (message: string) =>
      ctx.addIssue({ code: 'custom', message, path: ['series'] })
    if (d.kind === 'scatter') {
      if (d.series.some((s) => s.xs?.length !== s.values.length))
        bad('a scatter series needs xs, one per value')
    } else {
      if (d.series.some((s) => s.values.length !== d.categories.length))
        bad('must have one value per category')
      if ((d.kind === 'pie' || d.kind === 'donut') && d.series.length !== 1)
        bad('a pie or donut chart takes exactly one series')
    }
  })
export type ChartData = z.infer<typeof ChartDataSchema>

// Reject keys fractional-indexing cannot extend (it throws on them, poisoning every later add).
const zKey = z.string().refine((k) => {
  try {
    generateKeyBetween(k, null)
    return true
  } catch {
    return false
  }
}, 'must be a valid order key')

export const BaseShape = {
  id,
  x: num,
  y: num,
  w: size,
  h: size,
  rotation: num,
  z: zKey,
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
export const MathElementSchema = z.object({
  ...BaseShape,
  type: z.literal('math'),
  data: MathDataSchema,
})
export const ImageElementSchema = z.object({
  ...BaseShape,
  type: z.literal('image'),
  data: ImageDataSchema,
})
export const FreehandElementSchema = z.object({
  ...BaseShape,
  type: z.literal('freehand'),
  data: FreehandDataSchema,
})
export const GroupDataSchema = z.object({
  name: z.string().max(100, 'must be at most 100 characters').optional(),
})
export type GroupData = z.infer<typeof GroupDataSchema>
/** Draws nothing and is never hit: its children carry `parentId`, and its box is the union of theirs when it was made. */
export const GroupElementSchema = z.object({
  ...BaseShape,
  type: z.literal('group'),
  data: GroupDataSchema,
})
export const ChartElementSchema = z.object({
  ...BaseShape,
  type: z.literal('chart'),
  data: ChartDataSchema,
})
export const ElementSchema = z.discriminatedUnion('type', [
  ShapeElementSchema,
  TextElementSchema,
  MathElementSchema,
  ImageElementSchema,
  FreehandElementSchema,
  ChartElementSchema,
  GroupElementSchema,
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
    z: zKey,
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

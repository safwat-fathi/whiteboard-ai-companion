import { z } from 'zod'
import { ChartDataSchema } from '../schema'
import { write } from './board'
import { baseFields, stackAbove } from './make'
import { PlacementSchema, resolvePlacement } from './place'
import { defineTool, ToolError } from './registry'

// The input is deliberately loose: ChartDataSchema is the one place the limits live, and its message goes back to the
// model verbatim so it can fix the exact field.
export const addChart = defineTool({
  name: 'add_chart',
  description:
    'Add a chart from data: kind bar, line, area, pie, donut or scatter. Use only numbers the student gave or the book states, never numbers you made up. ' +
    'categories name the x positions (bar, line, area) or the slices (pie, donut); every series needs one value per category. ' +
    'A pie or donut takes exactly one series. A scatter has no categories: give each series xs, one per value. stacked applies to bar and area. ' +
    'Labels (title, categories, series names, axis titles) are Latin letters and digits only (at most 40 characters, the title 120): write anything in Arabic as text beside the chart. ' +
    'At most 50 categories, 8 series and 200 values per series.',
  input: z.object({
    kind: z.enum(['bar', 'line', 'area', 'pie', 'donut', 'scatter']),
    title: z.string().optional(),
    categories: z.array(z.string()).optional(),
    series: z.array(
      z.object({
        name: z.string(),
        values: z.array(z.number()),
        xs: z.array(z.number()).optional(),
      }),
    ),
    stacked: z.boolean().optional(),
    xLabel: z.string().optional(),
    yLabel: z.string().optional(),
    w: z.number().min(160).max(2000).optional().describe('Default 480.'),
    h: z.number().min(120).max(1600).optional().describe('Default 320.'),
    placement: PlacementSchema.optional(),
  }),
  execute: (i, ctx) => {
    if (i.kind !== 'scatter' && !i.categories)
      throw new ToolError(
        'categories: is required for a bar, line, area, pie or donut chart (one label per value)',
        'categories',
      )
    const r = ChartDataSchema.safeParse({
      kind: i.kind,
      ...(i.title ? { title: i.title } : {}),
      categories: i.categories ?? [],
      series: i.series,
      ...(i.stacked !== undefined ? { stacked: i.stacked } : {}),
      ...(i.xLabel ? { xLabel: i.xLabel } : {}),
      ...(i.yLabel ? { yLabel: i.yLabel } : {}),
    })
    if (!r.success) {
      const issue = r.error.issues[0]
      const field = issue?.path.join('.') || 'data'
      throw new ToolError(`${field}: ${issue?.message ?? 'is invalid'}`, field)
    }
    const size = { w: i.w ?? 480, h: i.h ?? 320 }
    const pos = resolvePlacement(i.placement, size, ctx)
    const [z0] = stackAbove(ctx, 1)
    const el = {
      ...baseFields(ctx, z0 as string),
      type: 'chart' as const,
      ...pos,
      ...size,
      data: r.data,
    }
    return write(
      i.title ? `Chart: ${i.title}` : 'Add chart',
      [{ op: 'add', el }],
      [el],
      ctx,
    )
  },
})

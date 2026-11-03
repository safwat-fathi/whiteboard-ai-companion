import { z } from 'zod'
import { quantiseStroke } from '../ink'
import { color, write } from './board'
import { baseFields, stackAbove } from './make'
import { PlacementSchema, resolvePlacement } from './place'
import { defineTool, ToolError } from './registry'

/**
 * The outline smooths and lags behind sparse samples (it is tuned for a pen's hundreds of points), so a model's three-point
 * mark would cut its corner by a fifth of a leg. Fill in between the given points, keeping every one of them: at most
 * STEP world units apart, and never so many that the stroke passes the schema's 10,000 points (500 given + 9,000 filled).
 */
const STEP = 6
function densify(pts: [number, number][]): [number, number][] {
  let length = 0
  for (let k = 1; k < pts.length; k++)
    length += Math.hypot(
      (pts[k] as [number, number])[0] - (pts[k - 1] as [number, number])[0],
      (pts[k] as [number, number])[1] - (pts[k - 1] as [number, number])[1],
    )
  const step = Math.max(STEP, length / 9000)
  const out: [number, number][] = [pts[0] as [number, number]]
  for (let k = 1; k < pts.length; k++) {
    const [x0, y0] = pts[k - 1] as [number, number]
    const [x1, y1] = pts[k] as [number, number]
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step))
    for (let j = 1; j <= n; j++)
      out.push([x0 + ((x1 - x0) * j) / n, y0 + ((y1 - y0) * j) / n])
  }
  return out
}

// The input is loose so a bad point list reaches the model as a ToolError naming `points`, like add_chart's data does.
export const drawStroke = defineTool({
  name: 'draw_stroke',
  description:
    'Draw a freehand stroke through a list of points [x, y] (2 to 500, in any frame of reference: the stroke is moved to where placement says). ' +
    'Strokes are rare: use one for a small hand-drawn mark such as an underline or a circle around something, and prefer shapes and text otherwise. ' +
    'highlighter makes a wide translucent marker band.',
  input: z.object({
    points: z.array(z.array(z.number())),
    color: color.optional(),
    width: z
      .number()
      .min(1)
      .max(40)
      .optional()
      .describe('Default 3 (18 for a highlighter).'),
    highlighter: z.boolean().optional(),
    placement: PlacementSchema.optional(),
  }),
  execute: (i, ctx) => {
    if (
      i.points.length < 2 ||
      i.points.length > 500 ||
      i.points.some((p) => p.length !== 2)
    )
      throw new ToolError(
        'points: give 2 to 500 points, each as [x, y]',
        'points',
      )
    // far past the board's own limit (1,000,000), and distances would overflow to Infinity and silently drop a segment
    if (i.points.some((p) => p.some((v) => Math.abs(v) > 1e9)))
      throw new ToolError(
        'points: coordinates must be within 1e9 of the origin you chose',
        'points',
      )
    // the pen tool's own normalisation: the 0.1 grid, a tight box, points relative to it
    const q = quantiseStroke(densify(i.points as [number, number][]), undefined)
    const pos = resolvePlacement(i.placement, { w: q.w, h: q.h }, ctx)
    const [z0] = stackAbove(ctx, 1)
    const base = baseFields(ctx, z0 as string)
    const highlighter = i.highlighter ?? false
    const el = {
      ...base,
      style: {
        ...base.style,
        stroke: i.color ?? (highlighter ? '#ffd400' : base.style.stroke),
        strokeWidth: i.width ?? (highlighter ? 18 : 3),
        opacity: highlighter ? 0.45 : 1,
      },
      type: 'freehand' as const,
      ...pos,
      w: q.w,
      h: q.h,
      data: { points: q.points, smoothing: 0.5, highlighter },
    }
    return write(
      highlighter ? 'Highlight' : 'Draw stroke',
      [{ op: 'add', el }],
      [el],
      ctx,
    )
  },
})

import { z } from 'zod'
import { resolveEnd } from '../geometry'
import { FONT_STACK } from '../platform'
import { type Element, newId } from '../schema'
import { linearGeometry } from './board'
import { baseFields, stackAbove } from './make'
import { PlacementSchema, resolvePlacement } from './place'
import { defineTool, ELEMENT_BUDGET, ToolError } from './registry'

const key = z.string().min(1).max(40)

/**
 * Where to put the nodes of a graph. Layers by longest path (back edges of cycles are ignored for layering but still
 * drawn), one barycenter pass to order each layer, layers centred on each other.
 * ponytail: a single crossing-reduction pass and no edge routing around nodes; swap in dagre if dense diagrams look tangled.
 */
export function layout(
  keys: string[],
  edges: { from: string; to: string }[],
  sizes: Map<string, { w: number; h: number }>,
  direction: 'TB' | 'LR',
  gap = { layer: 72, node: 40 },
): { pos: Map<string, { x: number; y: number }>; w: number; h: number } {
  const succ = new Map(keys.map((k) => [k, [] as string[]]))
  for (const e of edges) succ.get(e.from)?.push(e.to)
  // drop back edges (found by DFS) so layering terminates on cycles
  const state = new Map<string, 0 | 1 | 2>()
  const kept: { from: string; to: string }[] = []
  const visit = (k: string) => {
    state.set(k, 1)
    for (const t of succ.get(k) ?? []) {
      if (state.get(t) === 1) continue // back edge
      kept.push({ from: k, to: t })
      if (!state.get(t)) visit(t)
    }
    state.set(k, 2)
  }
  for (const k of keys) if (!state.get(k)) visit(k)

  const preds = new Map(keys.map((k) => [k, [] as string[]]))
  for (const e of kept) preds.get(e.to)?.push(e.from)
  const layerOf = new Map<string, number>()
  const depth = (k: string): number => {
    const known = layerOf.get(k)
    if (known !== undefined) return known
    const d = Math.max(-1, ...(preds.get(k) ?? []).map(depth)) + 1
    layerOf.set(k, d)
    return d
  }
  for (const k of keys) depth(k)
  const layers: string[][] = []
  for (const k of keys) (layers[layerOf.get(k) as number] ??= []).push(k)

  const index = new Map<string, number>()
  layers.forEach((l, li) => {
    if (li > 0) l.sort((a, b) => bary(a) - bary(b)) // stable: ties keep input order
    l.forEach((k, i) => index.set(k, i))
  })
  function bary(k: string): number {
    const ps = preds.get(k) ?? []
    return ps.length
      ? ps.reduce((a, p) => a + (index.get(p) ?? 0), 0) / ps.length
      : 0
  }

  const along = (k: string) =>
    (direction === 'TB' ? sizes.get(k)?.w : sizes.get(k)?.h) ?? 0
  const across = (k: string) =>
    (direction === 'TB' ? sizes.get(k)?.h : sizes.get(k)?.w) ?? 0
  const spans = layers.map(
    (l) => l.reduce((a, k) => a + along(k), 0) + gap.node * (l.length - 1),
  )
  const widest = Math.max(0, ...spans)
  const pos = new Map<string, { x: number; y: number }>()
  let offset = 0
  layers.forEach((l, li) => {
    const thick = Math.max(...l.map(across))
    let cur = (widest - (spans[li] as number)) / 2
    for (const k of l) {
      const a = cur
      const b = offset + (thick - across(k)) / 2
      pos.set(k, direction === 'TB' ? { x: a, y: b } : { x: b, y: a })
      cur += along(k) + gap.node
    }
    offset += thick + gap.layer
  })
  const total = offset - gap.layer
  return direction === 'TB'
    ? { pos, w: widest, h: total }
    : { pos, w: total, h: widest }
}

export const addDiagram = defineTool({
  name: 'add_diagram',
  description:
    'Draw a concept map or flowchart: boxes with labels joined by arrows, laid out for you in one step. Give each node a short key and label and list the edges by key. Prefer this over many add_shape/connect calls. Returns which element each key became.',
  input: z.object({
    title: z.string().max(120).optional(),
    nodes: z
      .array(
        z.object({
          key,
          label: z.string().min(1).max(120),
          shape: z.enum(['rect', 'ellipse', 'diamond']).optional(),
        }),
      )
      .min(1)
      .max(30),
    edges: z
      .array(
        z.object({ from: key, to: key, label: z.string().max(40).optional() }),
      )
      .max(45),
    direction: z
      .enum(['TB', 'LR'])
      .optional()
      .describe('Top-to-bottom (default) or left-to-right.'),
    placement: PlacementSchema.optional(),
  }),
  execute: (i, ctx) => {
    const keys = i.nodes.map((n) => n.key)
    if (new Set(keys).size !== keys.length)
      throw new ToolError('nodes: keys must be unique', 'nodes')
    for (const e of i.edges)
      for (const end of [e.from, e.to])
        if (!keys.includes(end))
          throw new ToolError(`edges: no node with key "${end}"`, 'edges')
    const direction = i.direction ?? 'TB'

    const font = `18px ${FONT_STACK}`
    const sizes = new Map(
      i.nodes.map((n) => {
        const textW = ctx.platform.measureText(font, n.label)
        const w = Math.max(110, Math.min(260, Math.ceil(textW) + 44))
        return [n.key, { w, h: textW > 216 ? 84 : 56 }] as const
      }),
    )
    const lay = layout(keys, i.edges, sizes, direction)
    const titleH = i.title ? 44 : 0
    const origin = resolvePlacement(
      i.placement,
      { w: Math.max(lay.w, 1), h: lay.h + titleH },
      ctx,
    )
    const nodeCount = i.nodes.length
    const labelled = i.edges.filter((e) => e.label)
    const zs = stackAbove(
      ctx,
      (i.title ? 1 : 0) + nodeCount + i.edges.length + labelled.length,
    )
    let zi = 0
    const els: Element[] = []

    if (i.title) {
      const draft = {
        ...baseFields(ctx, zs[zi++] as string),
        type: 'text' as const,
        x: origin.x,
        y: origin.y,
        w: Math.ceil(ctx.platform.measureText(`26px ${FONT_STACK}`, i.title)),
        h: Math.ceil(26 * 1.4),
        data: {
          text: i.title,
          size: 26,
          align: 'left' as const,
          dir: 'auto' as const,
        },
      }
      els.push(draft)
    }
    const byKey = new Map<string, Element>()
    for (const n of i.nodes) {
      const p = lay.pos.get(n.key) as { x: number; y: number }
      const s = sizes.get(n.key) as { w: number; h: number }
      const base = baseFields(ctx, zs[zi++] as string)
      const node = {
        ...base,
        style: { ...base.style, fill: '#ffffff' },
        type: 'shape' as const,
        x: origin.x + p.x,
        y: origin.y + titleH + p.y,
        ...s,
        data: { kind: n.shape ?? 'rect', label: n.label },
      } as Element
      byKey.set(n.key, node)
      els.push(node)
    }
    for (const e of i.edges) {
      const a = byKey.get(e.from) as Element
      const b = byKey.get(e.to) as Element
      const dx = b.x + b.w / 2 - (a.x + a.w / 2)
      const dy = b.y + b.h / 2 - (a.y + a.h / 2)
      const horizontal = Math.abs(dx) >= Math.abs(dy)
      const sFrac = horizontal
        ? { fx: dx >= 0 ? 1 : 0, fy: 0.5 }
        : { fx: 0.5, fy: dy >= 0 ? 1 : 0 }
      const eFrac = horizontal
        ? { fx: dx >= 0 ? 0 : 1, fy: 0.5 }
        : { fx: 0.5, fy: dy >= 0 ? 0 : 1 }
      const start = { id: a.id, ...sFrac }
      const end = { id: b.id, ...eFrac }
      const g = linearGeometry([resolveEnd(start, a), resolveEnd(end, b)])
      els.push({
        ...baseFields(ctx, zs[zi++] as string),
        type: 'shape',
        x: g.x,
        y: g.y,
        w: g.w,
        h: g.h,
        data: {
          kind: 'arrow',
          points: g.points,
          arrowheads: { start: false, end: true },
          start,
          end,
        },
      } as Element)
    }
    for (const e of labelled) {
      const arrow = els.filter(
        (x) => x.type === 'shape' && x.data.kind === 'arrow',
      )[i.edges.indexOf(e)] as Element
      const text = e.label as string
      const w = Math.ceil(ctx.platform.measureText(`14px ${FONT_STACK}`, text))
      els.push({
        ...baseFields(ctx, zs[zi++] as string),
        type: 'text',
        x: arrow.x + arrow.w / 2 - w / 2,
        y: arrow.y + arrow.h / 2 - 10,
        w,
        h: Math.ceil(14 * 1.4),
        data: { text, size: 14, align: 'center', dir: 'auto' },
      } as Element)
    }

    const minX = Math.min(...els.map((e) => e.x))
    const minY = Math.min(...els.map((e) => e.y))
    const maxX = Math.max(...els.map((e) => e.x + e.w))
    const maxY = Math.max(...els.map((e) => e.y + e.h))
    return {
      kind: 'write',
      batch: {
        batchId: newId(),
        label: i.title ? `Diagram: ${i.title}` : 'Add diagram',
        ops: els.map((el) => ({ op: 'add' as const, el })),
      },
      ids: els.map((e) => e.id),
      bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
      warnings:
        ctx.added + els.length > ELEMENT_BUDGET
          ? [
              `${ctx.added + els.length} new elements this turn is past the soft limit of ${ELEMENT_BUDGET}: stop adding and ask the student whether to continue.`,
            ]
          : [],
      info: {
        nodes: Object.fromEntries([...byKey].map(([k, e]) => [k, e.id])),
      },
    }
  },
})

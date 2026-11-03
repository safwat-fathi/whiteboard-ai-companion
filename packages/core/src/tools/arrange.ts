import { z } from 'zod'
import { alignBatch, distributeBatch, stackBatch } from '../arrange'
import { groupBatch, groupMembers, topGroup, ungroupBatch } from '../group'
import { applyBatch } from '../scene'
import type { Batch, Element, Op } from '../schema'
import { write } from './board'
import { agentMayEdit, defineTool, type ToolCtx, ToolError } from './registry'

const id = z.string().min(1)

// One plain object, not a union per action: the adapter extends a write tool's input with `returnSnapshot`, and the model
// reads one flat list of fields. The fields each action needs are checked in execute, naming the missing one.
export const arrange = defineTool({
  name: 'arrange',
  description:
    'Tidy elements that are already on the board, moving only their positions. ' +
    'action "align" lines them up: to left, centre, right (shared vertical line) or top, middle, bottom (shared horizontal line). ' +
    'action "distribute" (3 or more) spaces them evenly along an axis, horizontal or vertical, keeping the two outermost in place. ' +
    'action "stack" puts them one after another in a row or a column, `gap` apart (default 24), aligned at the start, centre or end. ' +
    'action "group" makes one group of them (`name` optional) and returns its id; "ungroup" takes group ids and dissolves one level. A group moves, deletes and selects as one for the student. ' +
    'Arrows attached to what moves follow it. You may arrange only what you drew and what the student had selected.',
  input: z.object({
    action: z.enum(['align', 'distribute', 'stack', 'group', 'ungroup']),
    ids: z.array(id).max(100),
    to: z
      .enum(['left', 'centre', 'right', 'top', 'middle', 'bottom'])
      .optional()
      .describe('For align.'),
    axis: z
      .enum(['horizontal', 'vertical'])
      .optional()
      .describe('For distribute.'),
    direction: z.enum(['row', 'column']).optional().describe('For stack.'),
    gap: z
      .number()
      .min(0)
      .max(500)
      .optional()
      .describe('For stack, default 24.'),
    name: z
      .string()
      .max(100)
      .optional()
      .describe('For group: an optional name.'),
    align: z
      .enum(['start', 'centre', 'end'])
      .optional()
      .describe('For stack: how they line up across the stack, default start.'),
  }),
  execute: (i, ctx: ToolCtx) => {
    const ids = [...new Set(i.ids)]
    const mayAll = (els: Element[]) => {
      for (const el of els) {
        const why = agentMayEdit(el, ctx.grantedIds)
        if (why) throw new ToolError(`ids: ${why}`, 'ids')
      }
    }
    const lookup = (elId: string) => {
      const el = ctx.scene.els.get(elId)
      if (!el)
        throw new ToolError(`ids: no element ${elId} on the board`, 'ids')
      return el
    }
    if (i.action === 'ungroup') {
      if (ids.length < 1)
        throw new ToolError('ids: give at least 1 group to ungroup', 'ids')
      const ops: Op[] = []
      const freed: Element[] = []
      for (const gid of ids) {
        const g = lookup(gid)
        if (g.type !== 'group')
          throw new ToolError(`ids: ${gid} is not a group`, 'ids')
        const members = groupMembers(ctx.scene, gid)
        mayAll(members) // the rights are the members': a student's group needs all of them selected
        ops.push(...(ungroupBatch(ctx.scene, gid)?.ops ?? []))
        freed.push(...members)
      }
      return write('Ungroup', ops, freed, ctx, false)
    }
    if (i.action === 'group') {
      if (ids.length < 2)
        throw new ToolError('ids: give at least 2 elements to group', 'ids')
      const els = ids.map(lookup)
      // grouping takes in the whole group of anything already in one: every leaf must be the tutor's to edit
      mayAll(
        els.flatMap((el) => {
          const unit = topGroup(ctx.scene, el) ?? el
          return unit.type === 'group' ? groupMembers(ctx.scene, unit.id) : [el]
        }),
      )
      const batch = groupBatch(ctx.scene, ids, ctx.author, i.name)
      if (!batch)
        throw new ToolError(
          'ids: could not group these: it needs two separate elements and none locked',
          'ids',
        )
      const made = (batch.ops[0] as { el: Element }).el
      return write(batch.label, batch.ops, [made], ctx, true)
    }
    if (ids.length < 2)
      throw new ToolError('ids: give at least 2 elements to arrange', 'ids')
    const els = ids.map(lookup)
    mayAll(els)
    const need = <T>(v: T | undefined, field: string, hint: string): T => {
      if (v === undefined)
        throw new ToolError(
          `${field}: is required for ${i.action} (${hint})`,
          field,
        )
      return v
    }
    const mayEdit = (a: Element) => agentMayEdit(a, ctx.grantedIds) === null
    let batch: Batch | null
    if (i.action === 'align')
      batch = alignBatch(
        ctx.scene,
        els,
        need(i.to, 'to', 'left, centre, right, top, middle or bottom'),
        { mayEdit },
      )
    else if (i.action === 'distribute') {
      const axis = need(i.axis, 'axis', 'horizontal or vertical')
      if (els.length < 3)
        throw new ToolError('ids: distribute needs at least 3 elements', 'ids')
      batch = distributeBatch(ctx.scene, els, axis, { mayEdit })
    } else
      batch = stackBatch(
        ctx.scene,
        els,
        need(i.direction, 'direction', 'row or column'),
        i.gap ?? 24,
        i.align ?? 'start',
        { mayEdit },
      )
    if (!batch)
      return {
        kind: 'read',
        data: { ok: true, note: 'Already arranged: nothing moved.' },
      }
    // where it all ends up, for the chat's "jump to" and the bounds it shows
    const view = { els: new Map(ctx.scene.els) }
    const { touched } = applyBatch(view, batch)
    const moved = touched.flatMap((t) => view.els.get(t) ?? [])
    return write(batch.label, batch.ops, moved, ctx, false)
  },
})

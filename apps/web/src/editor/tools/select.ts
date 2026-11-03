import {
  type Batch,
  bounds,
  type Element,
  expandToUnits,
  groupBatch,
  type Handle,
  type Id,
  newId,
  type Patch,
  type Point,
  resizeBox,
  resizeGroup,
  resolveEnd,
  rotateTo,
  toLocal,
  topGroup,
  ungroupBatch,
} from '@whiteboard/core'
import type { Editor } from '../editor'
import { shortcutKey } from '../keys'
import { type Guide, snapBox } from '../snap'
import { COLORS, drawGroupBox, drawHighlight, LOOK } from './highlight'
import type { Tool, ToolEvent } from './index'
import {
  applyPatch,
  bindTo,
  buildBatch,
  deleteBatch,
  frame,
  isLinear,
  moveBatch,
  rebase,
  shapeAt,
  worldPts,
} from './transform'

const HANDLE = 8 // screen px
const HIT = 6 // screen px
const ROT = 24 // screen px above the top edge
const DRAG = 3 // screen px before a press becomes a drag
const HANDLES: [Handle, number, number][] = [
  ['nw', 0, 0],
  ['n', 0.5, 0],
  ['ne', 1, 0],
  ['e', 1, 0.5],
  ['se', 1, 1],
  ['s', 0.5, 1],
  ['sw', 0, 1],
  ['w', 0, 0.5],
]
const NUDGE: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
}

type Gesture =
  | {
      k: 'move'
      s0: Point
      w0: Point
      d: Point
      moved: boolean
      hit: Id
      guides: Guide[]
    }
  | { k: 'gresize'; h: Handle; els: Element[]; patches: Map<Id, Patch> | null }
  | { k: 'marquee'; a: Point; b: Point; base: Id[] }
  | { k: 'resize'; el: Element; h: Handle; patch: Patch | null }
  | { k: 'rotate'; el: Element; patch: Patch | null }
  | { k: 'end'; el: Element; i: number; p: Point; snap: Element | null }

export const selectTool = (ed: Editor): Tool => {
  let g: Gesture | null = null
  let hover: Id | null = null // element under the pointer while no gesture runs
  let cam = ed.camera
  const z = () => ed.camera.zoom
  const els = () =>
    [...ed.selection]
      .map((i) => ed.scene.els.get(i))
      .filter((e): e is Element => !!e)
  const single = () => {
    const e = els()
    return e.length === 1 && !e[0]?.locked ? (e[0] as Element) : null
  }
  /** The box of a selection of several unlocked elements: the one the group handles sit on. */
  const multiBox = (list: Element[]) => {
    if (list.length < 2 || list.some((e) => e.locked || e.type === 'group'))
      return null
    const bs = list.map(bounds)
    return {
      x: Math.min(...bs.map((b) => b.minX)),
      y: Math.min(...bs.map((b) => b.minY)),
      w:
        Math.max(...bs.map((b) => b.maxX)) - Math.min(...bs.map((b) => b.minX)),
      h:
        Math.max(...bs.map((b) => b.maxY)) - Math.min(...bs.map((b) => b.minY)),
    }
  }
  const pick = (el: Element, w: Point): Handle | 'rot' | null => {
    const q = toLocal(el, w)
    const r = HIT / z()
    if (Math.hypot(q.x - (el.x + el.w / 2), q.y - (el.y - ROT / z())) <= r)
      return 'rot'
    // A text can only rotate: drawText ignores w/h (the layout owns them), so a resize would break w/h == layout.
    if (el.type === 'text') return null
    return (
      HANDLES.find(
        ([, fx, fy]) =>
          Math.hypot(q.x - (el.x + fx * el.w), q.y - (el.y + fy * el.h)) <= r,
      )?.[0] ?? null
    )
  }
  const set = (ids: Iterable<Id>) => {
    ed.selection.clear()
    for (const i of ids) ed.selection.add(i)
    ed.invalidateOverlay()
  }
  // picking a member stands for its whole group
  const setUnits = (ids: Iterable<Id>) => set(expandToUnits(ed.scene, ids))
  // A hover is drawn unless the element is selected (drawOverlay). Only a change of what is drawn repaints, and only the overlay.
  const drawn = (id: Id | null) => !!id && !ed.selection.has(id)
  const setHover = (id: Id | null) => {
    if (id === hover) return
    const repaint = drawn(hover) || drawn(id)
    hover = id
    ed.setCursor(id ? 'pointer' : '')
    if (repaint) ed.invalidateOverlay()
  }
  const commitPatch = (label: string, el: Element, patch: Patch | null) => {
    const b = patch && buildBatch(ed.scene, label, new Map([[el.id, patch]]))
    if (b) ed.commit(b)
  }

  return {
    id: 'select',
    key: 'v',
    onPointerDown(e: ToolEvent) {
      setHover(null)
      g = null
      if (e.button !== 0) return
      const sel = single()
      if (sel && isLinear(sel)) {
        const p = worldPts(sel)
        const i = [0, p.length - 1].find(
          (i) =>
            p[i] &&
            Math.hypot(p[i].x - e.world.x, p[i].y - e.world.y) <= HIT / z(),
        )
        if (i !== undefined) {
          g = { k: 'end', el: sel, i, p: p[i] as Point, snap: null }
          return
        }
      } else if (sel) {
        const h = pick(sel, e.world)
        if (h === 'rot') g = { k: 'rotate', el: sel, patch: null }
        else if (h) g = { k: 'resize', el: sel, h, patch: null }
        if (g) return
      }
      if (!sel) {
        const list = els()
        const mb = multiBox(list)
        if (mb) {
          const r = HIT / z()
          const h = HANDLES.find(
            ([, fx, fy]) =>
              Math.hypot(
                e.world.x - (mb.x + fx * mb.w),
                e.world.y - (mb.y + fy * mb.h),
              ) <= r,
          )?.[0]
          if (h) {
            g = { k: 'gresize', h, els: list, patches: null }
            return
          }
        }
      }
      const hit = ed.index.pick(e.world, z(), ed.scene)
      if (hit) {
        if (e.shift) {
          const unit = [...expandToUnits(ed.scene, [hit.id])]
          if (unit.every((i) => ed.selection.has(i)))
            for (const i of unit) ed.selection.delete(i)
          else for (const i of unit) ed.selection.add(i)
          ed.invalidateOverlay()
          return
        }
        if (!ed.selection.has(hit.id)) setUnits([hit.id])
        g = {
          k: 'move',
          s0: e.screen,
          w0: e.world,
          d: { x: 0, y: 0 },
          moved: false,
          hit: hit.id,
          guides: [],
        }
      } else {
        const base = e.shift ? [...ed.selection] : []
        set(base)
        g = { k: 'marquee', a: e.world, b: e.world, base }
      }
    },
    onPointerMove(e: ToolEvent) {
      if (!g) {
        setHover(ed.index.pick(e.world, z(), ed.scene)?.id ?? null)
        return
      }
      if (g.k === 'move') {
        if (
          !g.moved &&
          Math.hypot(e.screen.x - g.s0.x, e.screen.y - g.s0.y) < DRAG
        )
          return
        g.moved = true
        const d = { x: e.world.x - g.w0.x, y: e.world.y - g.w0.y }
        g.guides = []
        if (!e.alt) {
          // Alt bypasses. The box that moves is the whole selection; every other element is a candidate.
          const mine = els().filter((el) => !el.locked)
          if (mine.length) {
            const bs = mine.map(bounds)
            const box = {
              minX: Math.min(...bs.map((b) => b.minX)) + d.x,
              minY: Math.min(...bs.map((b) => b.minY)) + d.y,
              maxX: Math.max(...bs.map((b) => b.maxX)) + d.x,
              maxY: Math.max(...bs.map((b) => b.maxY)) + d.y,
            }
            const others = [...ed.scene.els.values()]
              .filter((o) => !ed.selection.has(o.id) && o.type !== 'group')
              .map(bounds)
            const s = snapBox(box, others, z())
            d.x += s.dx
            d.y += s.dy
            g.guides = s.guides
          }
        }
        g.d = d
      } else if (g.k === 'gresize')
        g.patches = resizeGroup(g.els, g.h, e.world, e.shift, ed.platform)
      else if (g.k === 'marquee') g.b = e.world
      else if (g.k === 'resize') {
        const patch = resizeBox(g.el, g.h, e.world, e.shift)
        if (
          patch &&
          g.el.type === 'math' &&
          typeof patch.w === 'number' &&
          g.el.w > 0
        ) {
          patch['data.size'] = Math.max(
            8,
            Math.min(1000, Math.round(g.el.data.size * (patch.w / g.el.w))),
          )
        }
        g.patch = patch
      } else if (g.k === 'rotate') {
        const c = { x: g.el.x + g.el.w / 2, y: g.el.y + g.el.h / 2 }
        const a = Math.atan2(e.world.y - c.y, e.world.x - c.x) + Math.PI / 2
        g.patch = rotateTo(g.el, a, e.shift)
      } else {
        g.snap = shapeAt(ed, e.world)
        g.p = g.snap ? resolveEnd(bindTo(g.snap, e.world), g.snap) : e.world
      }
      ed.invalidateOverlay()
    },
    onPointerUp() {
      const cur = g
      g = null
      ed.invalidateOverlay()
      if (!cur) return
      if (cur.k === 'move') {
        if (cur.moved) {
          const b = moveBatch(ed.scene, ed.selection, cur.d.x, cur.d.y)
          if (b) ed.commit(b)
        } else if (ed.selection.size > 1) setUnits([cur.hit])
      } else if (cur.k === 'marquee') {
        const x = [cur.a.x, cur.b.x]
        const y = [cur.a.y, cur.b.y]
        const r = {
          minX: Math.min(...x),
          minY: Math.min(...y),
          maxX: Math.max(...x),
          maxY: Math.max(...y),
        }
        const inside = ed.index
          .search(r)
          .map((f) => ed.scene.els.get(f.id))
          .filter((el): el is Element => {
            if (!el || el.type === 'group') return false
            const b = bounds(el)
            return (
              b.minX >= r.minX &&
              b.minY >= r.minY &&
              b.maxX <= r.maxX &&
              b.maxY <= r.maxY
            )
          })
        setUnits([...cur.base, ...inside.map((el) => el.id)])
      } else if (cur.k === 'gresize') {
        const b = cur.patches && buildBatch(ed.scene, 'Resize', cur.patches)
        if (b) ed.commit(b)
      } else if (cur.k === 'resize') commitPatch('Resize', cur.el, cur.patch)
      else if (cur.k === 'rotate') commitPatch('Rotate', cur.el, cur.patch)
      else if (
        cur.snap ||
        cur.p.x !== worldPts(cur.el)[cur.i]?.x ||
        cur.p.y !== worldPts(cur.el)[cur.i]?.y
      ) {
        // Endpoint: rewrite the end point, rebase x,y,w,h, and (un)bind that end, in one batch.
        const abs = worldPts(cur.el)
        abs[cur.i] = cur.p
        const side = cur.i === 0 ? 'start' : 'end'
        const patch = {
          ...rebase(abs),
          [`data.${side}`]: cur.snap ? bindTo(cur.snap, cur.p) : null,
        }
        commitPatch('Move Endpoint', cur.el, patch)
      }
    },
    onDoubleClick(e: ToolEvent) {
      const hit = ed.index.pick(e.world, z(), ed.scene)
      if (hit?.type === 'text') ed.editText(hit.id)
      else if (hit?.type === 'math') ed.editMath(hit.id)
      else if (hit?.type === 'image') ed.editCrop(hit.id)
      else if (hit?.type === 'chart') ed.editChart(hit.id)
    },
    onKey(e: KeyboardEvent) {
      const one = single()
      if (e.key === 'Enter' && ed.selection.size === 1) {
        if (one?.type === 'text') {
          ed.editText(one.id)
          return true
        }
        if (one?.type === 'math') {
          ed.editMath(one.id)
          return true
        }
        if (one?.type === 'chart') {
          ed.editChart(one.id)
          return true
        }
      }
      if ((e.ctrlKey || e.metaKey) && shortcutKey(e) === 'g') {
        let b: Batch | null = null
        if (e.shiftKey) {
          // ungroup the outermost group of each selected element, one level
          const tops = new Set<Id>()
          for (const el of els()) {
            const t = topGroup(ed.scene, el)
            if (t) tops.add(t.id)
          }
          const ops = [...tops].flatMap(
            (id) => ungroupBatch(ed.scene, id)?.ops ?? [],
          )
          if (ops.length) b = { batchId: newId(), label: 'Ungroup', ops }
        } else b = groupBatch(ed.scene, ed.selection, ed.author)
        if (b) ed.commit(b)
        return true
      }
      if ((e.ctrlKey || e.metaKey) && shortcutKey(e) === 'a') {
        set(
          [...ed.scene.els.values()]
            .filter((el) => !el.locked && el.type !== 'group')
            .map((el) => el.id),
        )
        return true
      }
      if (e.key === 'Escape') {
        if (g) g = null
        else ed.selection.clear()
        ed.invalidateOverlay()
        return true
      }
      if (g) return false
      const nudge = NUDGE[e.key]
      const b =
        e.key === 'Delete' || e.key === 'Backspace'
          ? deleteBatch(ed.scene, ed.selection)
          : nudge &&
            moveBatch(
              ed.scene,
              ed.selection,
              nudge.x * (e.shiftKey ? 10 : 1),
              nudge.y * (e.shiftKey ? 10 : 1),
            )
      if (b) ed.commit(b)
      return nudge !== undefined || e.key === 'Delete' || e.key === 'Backspace'
    },
    onCancel() {
      g = null
      setHover(null)
      ed.invalidateOverlay()
    },
    onPointerLeave: () => setHover(null),
    // A pan or zoom moves the content under a pointer that sent no event, and a delete or undo can remove the hovered
    // element: the old hover would be stale. This frame redraws.
    onFrame() {
      const panned = ed.camera !== cam
      cam = ed.camera
      if (hover && (panned || !ed.scene.els.has(hover))) {
        hover = null
        ed.setCursor('')
      }
    },
    drawOverlay(ctx) {
      const k = z()
      const m = g?.k === 'move' && g.moved ? g.d : { x: 0, y: 0 }
      ctx.save()
      const over =
        hover && !ed.readOnly && !ed.selection.has(hover)
          ? ed.scene.els.get(hover)
          : undefined
      if (over) drawHighlight(ctx, over, k, LOOK.hover)
      ctx.strokeStyle = COLORS.select
      ctx.fillStyle = COLORS.handleFill
      ctx.lineWidth = 1 / k
      const sel = single()
      const shown = els().map((el) => {
        const gp = g?.k === 'gresize' ? g.patches?.get(el.id) : undefined
        const live = gp
          ? applyPatch(el, gp)
          : g && 'el' in g && g.el.id === el.id && 'patch' in g && g.patch
            ? applyPatch(el, g.patch)
            : el
        const d = el.locked ? { x: 0, y: 0 } : m
        return { ...live, x: live.x + d.x, y: live.y + d.y } as Element
      })
      for (const el of shown) drawHighlight(ctx, el, k, LOOK.select)
      if (shown.length > 1) drawGroupBox(ctx, shown, k)
      const mb = g?.k === 'move' ? null : multiBox(shown)
      if (mb) {
        const s = HANDLE / k
        for (const [, fx, fy] of HANDLES) {
          const qx = mb.x + fx * mb.w
          const qy = mb.y + fy * mb.h
          ctx.fillRect(qx - s / 2, qy - s / 2, s, s)
          ctx.strokeRect(qx - s / 2, qy - s / 2, s, s)
        }
      }
      if (g?.k === 'move')
        for (const gd of g.guides) {
          ctx.beginPath()
          if (gd.axis === 'x') {
            ctx.moveTo(gd.at, gd.from)
            ctx.lineTo(gd.at, gd.to)
          } else {
            ctx.moveTo(gd.from, gd.at)
            ctx.lineTo(gd.to, gd.at)
          }
          ctx.stroke()
        }
      if (sel && g?.k !== 'move') {
        const el =
          'el' in (g ?? {}) && g && 'patch' in g && g.patch
            ? applyPatch(sel, g.patch)
            : sel
        const s = HANDLE / k
        if (isLinear(el)) {
          const p = worldPts(el)
          for (const q of g?.k === 'end'
            ? [g.p, ...p.filter((_, i) => i !== (g as { i: number }).i)]
            : p) {
            ctx.beginPath()
            ctx.arc(q.x, q.y, s / 2, 0, 2 * Math.PI)
            ctx.fill()
            ctx.stroke()
          }
          if (g?.k === 'end' && g.snap) frame(ctx, g.snap)
        } else {
          ctx.save()
          ctx.translate(el.x + el.w / 2, el.y + el.h / 2)
          ctx.rotate(el.rotation)
          const pts: Point[] = [
            ...(el.type === 'text' ? [] : HANDLES).map(([, fx, fy]) => ({
              x: (fx - 0.5) * el.w,
              y: (fy - 0.5) * el.h,
            })),
            { x: 0, y: -el.h / 2 - ROT / k },
          ]
          for (const q of pts) {
            ctx.fillRect(q.x - s / 2, q.y - s / 2, s, s)
            ctx.strokeRect(q.x - s / 2, q.y - s / 2, s, s)
          }
          ctx.restore()
        }
      }
      if (g?.k === 'marquee') {
        ctx.fillStyle = COLORS.marqueeFill
        ctx.fillRect(g.a.x, g.a.y, g.b.x - g.a.x, g.b.y - g.a.y)
        ctx.strokeRect(g.a.x, g.a.y, g.b.x - g.a.x, g.b.y - g.a.y)
      }
      ctx.restore()
    },
  }
}

import {
  type Crop,
  type Element,
  type Handle,
  type Patch,
  type Point,
  toLocal,
} from '@whiteboard/core'
import type { Editor } from '../editor'
import { COLORS } from './highlight'
import type { Tool, ToolEvent } from './index'
import { buildBatch } from './transform'

type ImageEl = Element & { type: 'image' }

export type CropTool = Tool & {
  edit(el: ImageEl): void
  resetCrop(): void
}

const HANDLE = 8 // screen px
const HIT = 8 // >= 7 screen px hit target at every zoom
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

type CropGesture =
  | { k: 'handle'; h: Handle; start: Crop }
  | { k: 'pan'; q0: Point; start: Crop }

export const cropTool = (ed: Editor): CropTool => {
  let cur: {
    el: ImageEl
    c0: Crop
    crop: Crop
    sx: number
    sy: number
    gesture: CropGesture | null
  } | null = null

  const localCropRect = (s: NonNullable<typeof cur>, c: Crop = s.crop) => ({
    wx: s.el.x + (c.x - s.c0.x) * s.sx,
    wy: s.el.y + (c.y - s.c0.y) * s.sy,
    ww: c.w * s.sx,
    wh: c.h * s.sy,
  })

  const pickHandle = (s: NonNullable<typeof cur>, q: Point): Handle | null => {
    const { wx, wy, ww, wh } = localCropRect(s)
    const r = HIT / ed.camera.zoom
    let best: Handle | null = null
    let bestDist = r
    for (const [h, fx, fy] of HANDLES) {
      const d = Math.hypot(q.x - (wx + fx * ww), q.y - (wy + fy * wh))
      if (d <= bestDist) {
        bestDist = d
        best = h
      }
    }
    return best
  }

  const commitCrop = () => {
    const s = cur
    if (!s) return
    const { el, c0, crop, sx, sy } = s
    const { naturalW, naturalH } = el.data
    const changed =
      crop.x !== c0.x || crop.y !== c0.y || crop.w !== c0.w || crop.h !== c0.h
    try {
      if (changed) {
        const { wx, wy, ww, wh } = localCropRect(s, crop)
        const c0x = el.x + el.w / 2
        const c0y = el.y + el.h / 2
        const lcx = wx + ww / 2
        const lcy = wy + wh / 2
        const dx = lcx - c0x
        const dy = lcy - c0y
        const cos = Math.cos(el.rotation)
        const sin = Math.sin(el.rotation)
        const wcx = c0x + dx * cos - dy * sin
        const wcy = c0y + dx * sin + dy * cos
        const newW = Math.max(1, crop.w * sx)
        const newH = Math.max(1, crop.h * sy)
        const newX = wcx - newW / 2
        const newY = wcy - newH / 2
        const isFull =
          crop.x === 0 &&
          crop.y === 0 &&
          crop.w === naturalW &&
          crop.h === naturalH
        const patch: Patch = {
          x: newX,
          y: newY,
          w: newW,
          h: newH,
          'data.crop': isFull ? null : { ...crop },
        }
        const b = buildBatch(ed.scene, 'Crop', new Map([[el.id, patch]]))
        if (b) ed.commit(b)
      }
    } finally {
      cur = null
      ed.hidden = null
      ed.invalidate()
    }
    ed.selection.clear()
    if (ed.scene.els.has(el.id)) ed.selection.add(el.id)
    ed.setTool('select')
  }

  const cancelCrop = () => {
    const s = cur
    if (!s) return
    const id = s.el.id
    cur = null
    ed.hidden = null
    ed.invalidate()
    ed.selection.clear()
    if (ed.scene.els.has(id)) ed.selection.add(id)
    ed.setTool('select')
  }

  return {
    id: 'crop',
    key: '',
    edit(el: ImageEl) {
      const c0: Crop = el.data.crop
        ? { ...el.data.crop }
        : { x: 0, y: 0, w: el.data.naturalW, h: el.data.naturalH }
      const sx = el.w / Math.max(1, c0.w)
      const sy = el.h / Math.max(1, c0.h)
      cur = {
        el,
        c0,
        crop: { ...c0 },
        sx,
        sy,
        gesture: null,
      }
      ed.hidden = el.id
      ed.invalidate()
    },
    resetCrop() {
      if (!cur) return
      cur.crop = {
        x: 0,
        y: 0,
        w: cur.el.data.naturalW,
        h: cur.el.data.naturalH,
      }
      ed.invalidateOverlay()
    },
    onPointerDown(e: ToolEvent) {
      if (!cur || e.button !== 0) return
      const q = toLocal(cur.el, e.world)
      const h = pickHandle(cur, q)
      if (h) {
        cur.gesture = { k: 'handle', h, start: { ...cur.crop } }
        return
      }
      const { wx, wy, ww, wh } = localCropRect(cur)
      if (q.x >= wx && q.x <= wx + ww && q.y >= wy && q.y <= wy + wh) {
        cur.gesture = { k: 'pan', q0: q, start: { ...cur.crop } }
        return
      }
      commitCrop()
      ed.tool.onPointerDown(e)
    },
    onPointerMove(e: ToolEvent) {
      if (!cur?.gesture) return
      const { el, c0, sx, sy, gesture } = cur
      const { naturalW, naturalH } = el.data
      const q = toLocal(el, e.world)

      if (gesture.k === 'pan') {
        const dpx = Math.round((q.x - gesture.q0.x) / sx)
        const dpy = Math.round((q.y - gesture.q0.y) / sy)
        const nx = Math.max(
          0,
          Math.min(naturalW - gesture.start.w, gesture.start.x + dpx),
        )
        const ny = Math.max(
          0,
          Math.min(naturalH - gesture.start.h, gesture.start.y + dpy),
        )
        cur.crop = {
          x: nx,
          y: ny,
          w: gesture.start.w,
          h: gesture.start.h,
        }
      } else {
        const px = Math.max(
          0,
          Math.min(naturalW, Math.round(c0.x + (q.x - el.x) / sx)),
        )
        const py = Math.max(
          0,
          Math.min(naturalH, Math.round(c0.y + (q.y - el.y) / sy)),
        )
        let left = gesture.start.x
        let right = gesture.start.x + gesture.start.w
        let top = gesture.start.y
        let bottom = gesture.start.y + gesture.start.h
        const { h } = gesture
        if (h.includes('w')) left = Math.max(0, Math.min(right - 1, px))
        if (h.includes('e')) right = Math.min(naturalW, Math.max(left + 1, px))
        if (h.includes('n')) top = Math.max(0, Math.min(bottom - 1, py))
        if (h.includes('s')) bottom = Math.min(naturalH, Math.max(top + 1, py))
        cur.crop = {
          x: left,
          y: top,
          w: right - left,
          h: bottom - top,
        }
      }
      ed.invalidateOverlay()
    },
    onPointerUp() {
      if (!cur) return
      cur.gesture = null
      ed.invalidateOverlay()
    },
    onKey(e: KeyboardEvent) {
      if (!cur) return false
      if (e.key === 'Enter') {
        commitCrop()
        return true
      }
      if (e.key === 'Escape') {
        cancelCrop()
        return true
      }
      return false
    },
    onCancel: cancelCrop,
    drawOverlay(ctx) {
      if (!cur) return
      const { el, c0, crop, sx, sy } = cur
      const { naturalW, naturalH, blobId } = el.data
      const fullX = el.x - c0.x * sx
      const fullY = el.y - c0.y * sy
      const fullW = naturalW * sx
      const fullH = naturalH * sy
      const { wx, wy, ww, wh } = localCropRect(cur, crop)
      const k = ed.camera.zoom

      ctx.save()
      if (el.rotation) {
        const cx = el.x + el.w / 2
        const cy = el.y + el.h / 2
        ctx.translate(cx, cy)
        ctx.rotate(el.rotation)
        ctx.translate(-cx, -cy)
      }

      const entry = ed.platform.images?.peek(blobId)
      if (entry && entry !== 'missing') {
        ctx.save()
        ctx.globalAlpha = 0.35
        ctx.drawImage(
          entry.bitmap,
          0,
          0,
          naturalW,
          naturalH,
          fullX,
          fullY,
          fullW,
          fullH,
        )
        ctx.restore()
        ctx.drawImage(
          entry.bitmap,
          crop.x,
          crop.y,
          crop.w,
          crop.h,
          wx,
          wy,
          ww,
          wh,
        )
      } else {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.15)'
        ctx.fillRect(fullX, fullY, fullW, fullH)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
        ctx.fillRect(wx, wy, ww, wh)
      }

      ctx.strokeStyle = COLORS.select
      ctx.fillStyle = COLORS.handleFill
      ctx.lineWidth = 1.5 / k
      ctx.strokeRect(wx, wy, ww, wh)

      const s = HANDLE / k
      for (const [, fx, fy] of HANDLES) {
        const hx = wx + fx * ww
        const hy = wy + fy * wh
        ctx.fillRect(hx - s / 2, hy - s / 2, s, s)
        ctx.strokeRect(hx - s / 2, hy - s / 2, s, s)
      }
      ctx.restore()
    },
  }
}

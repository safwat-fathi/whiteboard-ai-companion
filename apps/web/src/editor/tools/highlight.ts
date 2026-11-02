import { bounds, type Element, outline, type Point } from '@whiteboard/core'
import { isLinear, worldPts } from './transform'

/** Overlay colours and sizes for selection, hover and the marquee, in one place. Screen px unless noted. */
export const COLORS = {
  /** Selected outline and handles: 6.2:1 on the white canvas. */
  select: '#1a56db',
  selectHalo: 'rgba(26,86,219,0.22)',
  /** Hover is lighter than selection but still above 3:1 on white. */
  hover: '#4f8cff',
  hoverHalo: 'rgba(79,140,255,0.2)',
  marqueeFill: 'rgba(26,86,219,0.1)',
  handleFill: '#fff',
}
/** Gap between an element's edge and its highlight. */
export const PAD = 4
/** Extra gap of the dashed group box beyond the member highlights. */
export const GROUP_GAP = 6
export const LOOK = {
  select: { line: COLORS.select, halo: COLORS.selectHalo, width: 2 },
  hover: { line: COLORS.hover, halo: COLORS.hoverHalo, width: 1.5 },
}

/** Stadium around the segment a-b, `r` from it. */
function capsule(ctx: CanvasRenderingContext2D, a: Point, b: Point, r: number) {
  const t = Math.atan2(b.y - a.y, b.x - a.x)
  ctx.arc(a.x, a.y, r, t + Math.PI / 2, t + 1.5 * Math.PI)
  ctx.arc(b.x, b.y, r, t - Math.PI / 2, t + Math.PI / 2)
  ctx.closePath()
}

/**
 * Highlights `el` (already offset by any move preview) at a constant on-screen size: an outline `PAD` screen px outside
 * the element that follows its shape and rotation. Lines and arrows get a translucent band along the path as well.
 * `k` is the camera zoom.
 */
export function drawHighlight(
  ctx: CanvasRenderingContext2D,
  el: Element,
  k: number,
  look: (typeof LOOK)['select'],
) {
  const pad = (el.type === 'shape' ? el.style.strokeWidth / 2 : 0) + PAD / k
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (isLinear(el)) {
    const pts = worldPts(el)
    ctx.strokeStyle = look.halo
    ctx.lineWidth = 2 * pad
    ctx.beginPath()
    pts.forEach((p, i) => {
      if (i) ctx.lineTo(p.x, p.y)
      else ctx.moveTo(p.x, p.y)
    })
    ctx.stroke()
    ctx.strokeStyle = look.line
    ctx.lineWidth = look.width / k
    ctx.beginPath()
    for (let i = 0; i < Math.max(pts.length - 1, 1); i++) {
      const a = pts[i]
      const b = pts[i + 1] ?? a
      if (a && b) capsule(ctx, a, b, pad)
    }
    ctx.stroke()
  } else {
    const cx = el.x + el.w / 2
    const cy = el.y + el.h / 2
    ctx.translate(cx, cy)
    ctx.rotate(el.rotation)
    ctx.strokeStyle = look.line
    ctx.lineWidth = look.width / k
    ctx.beginPath()
    if (el.type === 'shape' && el.data.kind === 'ellipse')
      ctx.ellipse(0, 0, el.w / 2 + pad, el.h / 2 + pad, 0, 0, 2 * Math.PI)
    else {
      outline({
        ...el,
        x: el.x - pad,
        y: el.y - pad,
        w: el.w + 2 * pad,
        h: el.h + 2 * pad,
      }).forEach((p, i) => {
        if (i) ctx.lineTo(p.x - cx, p.y - cy)
        else ctx.moveTo(p.x - cx, p.y - cy)
      })
      ctx.closePath()
    }
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * One dashed box around all of `els`, outside their individual highlights: padded by the thickest shape's half stroke
 * (bounds() leaves it out for closed shapes) plus the highlight gap and `GROUP_GAP`, so it never touches a member's outline.
 */
export function drawGroupBox(
  ctx: CanvasRenderingContext2D,
  els: Element[],
  k: number,
) {
  // A loop, not Math.min(...spread): a huge selection would overflow the argument limit.
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let stroke = 0
  for (const el of els) {
    const b = bounds(el)
    minX = Math.min(minX, b.minX)
    minY = Math.min(minY, b.minY)
    maxX = Math.max(maxX, b.maxX)
    maxY = Math.max(maxY, b.maxY)
    if (el.type === 'shape') stroke = Math.max(stroke, el.style.strokeWidth)
  }
  const g = stroke / 2 + (PAD + GROUP_GAP) / k
  ctx.save()
  ctx.strokeStyle = COLORS.select
  ctx.lineWidth = 1.5 / k
  ctx.setLineDash([6 / k, 4 / k])
  ctx.strokeRect(minX - g, minY - g, maxX - minX + 2 * g, maxY - minY + 2 * g)
  ctx.restore()
}

import type { Rect } from './geometry'
import { type Camera, type Viewport, ZOOM_MAX, ZOOM_MIN } from './schema'

const clampZoom = (z: number): number =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number.isFinite(z) ? z : 1))

/**
 * Fits `rect` inside `viewport` with `padding` (default 48 CSS px) and `maxZoom` (default 2),
 * clamped to `[ZOOM_MIN, ZOOM_MAX]`, centering the rect in the viewport.
 */
export function cameraFor(
  rect: Rect,
  viewport: Viewport,
  opts: { padding?: number; maxZoom?: number } = {},
): Camera {
  const padding = opts.padding ?? 48
  const maxZoom = opts.maxZoom ?? 2
  const vw = Math.max(1, viewport.width)
  const vh = Math.max(1, viewport.height)
  const availW = Math.max(1, vw - padding * 2)
  const availH = Math.max(1, vh - padding * 2)
  const rw = Math.max(0, rect.maxX - rect.minX)
  const rh = Math.max(0, rect.maxY - rect.minY)

  let rawZoom = maxZoom
  if (rw > 0 && rh > 0) {
    rawZoom = Math.min(maxZoom, availW / rw, availH / rh)
  } else if (rw > 0) {
    rawZoom = Math.min(maxZoom, availW / rw)
  } else if (rh > 0) {
    rawZoom = Math.min(maxZoom, availH / rh)
  }

  const zoom = clampZoom(Math.min(maxZoom, rawZoom))
  const rcx = (rect.minX + rect.maxX) / 2
  const rcy = (rect.minY + rect.maxY) / 2
  return {
    x: rcx - vw / (2 * zoom),
    y: rcy - vh / (2 * zoom),
    zoom,
  }
}

/**
 * Log-space zoom interpolation with ease-in-out on `t` (`[0, 1]`) and a zoom-out dip
 * that grows with world distance relative to the viewport (no dip when target center is already on screen).
 */
export function flightCamera(
  from: Camera,
  to: Camera,
  viewport: Viewport,
): (t: number) => Camera {
  const vw = Math.max(1, viewport.width)
  const vh = Math.max(1, viewport.height)
  const z0 = clampZoom(from.zoom)
  const z1 = clampZoom(to.zoom)
  const fromW = vw / z0
  const fromH = vh / z0
  const fromCx = from.x + fromW / 2
  const fromCy = from.y + fromH / 2
  const toCx = to.x + vw / (2 * z1)
  const toCy = to.y + vh / (2 * z1)

  const onScreen =
    toCx >= from.x &&
    toCx <= from.x + fromW &&
    toCy >= from.y &&
    toCy <= from.y + fromH

  const worldDist = Math.hypot(toCx - fromCx, toCy - fromCy)
  const log0 = Math.log(z0)
  const log1 = Math.log(z1)

  let dipLog = 0
  if (!onScreen && worldDist > 0) {
    const minZ = Math.min(z0, z1)
    const spanZ = Math.hypot(vw, vh) / (worldDist * 1.5)
    const apexZ = clampZoom(Math.min(minZ * 0.85, spanZ))
    dipLog = Math.max(0, 0.5 * (log0 + log1) - Math.log(apexZ))
  }

  return (t: number): Camera => {
    if (t <= 0) return { x: from.x, y: from.y, zoom: from.zoom }
    if (t >= 1) return { x: to.x, y: to.y, zoom: to.zoom }
    const s = t * t * (3 - 2 * t)
    const logZ = log0 + (log1 - log0) * s - dipLog * Math.sin(Math.PI * s)
    const zoom = clampZoom(Math.exp(logZ))
    const cx = fromCx + (toCx - fromCx) * s
    const cy = fromCy + (toCy - fromCy) * s
    return {
      x: cx - vw / (2 * zoom),
      y: cy - vh / (2 * zoom),
      zoom,
    }
  }
}

/**
 * Flight duration in milliseconds: 600 ms scaled by distance, clamped to `[250, 1200]` ms.
 */
export function flightDuration(
  from: Camera,
  to: Camera,
  viewport: Viewport,
): number {
  const vw = Math.max(1, viewport.width)
  const vh = Math.max(1, viewport.height)
  const z0 = clampZoom(from.zoom)
  const z1 = clampZoom(to.zoom)
  const fromCx = from.x + vw / (2 * z0)
  const fromCy = from.y + vh / (2 * z0)
  const toCx = to.x + vw / (2 * z1)
  const toCy = to.y + vh / (2 * z1)
  const worldDist = Math.hypot(toCx - fromCx, toCy - fromCy)
  const avgZoom = Math.sqrt(z0 * z1)
  const screenDiag = Math.max(1, Math.hypot(vw, vh))
  const screens = (worldDist * avgZoom) / screenDiag
  const zoomChange = Math.abs(Math.log2(z1 / z0))
  const factor = Math.log2(1 + screens + zoomChange * 0.5)
  return Math.min(1200, Math.max(250, Math.round(600 * factor)))
}

import { describe, expect, it } from 'vitest'
import { cameraFor, flightCamera, flightDuration } from './flight'
import { type Camera, type Viewport, ZOOM_MAX, ZOOM_MIN } from './schema'

const vp: Viewport = { width: 1000, height: 800, dpr: 1 }

describe('flightCamera, flightDuration, cameraFor', () => {
  it('flightCamera(a, b)(0) equals a and (1) equals b exactly', () => {
    const a: Camera = { x: 12.5, y: -40.25, zoom: 0.75 }
    const b: Camera = { x: 4200, y: 1850, zoom: 1.5 }
    const fn = flightCamera(a, b, vp)
    expect(fn(0)).toEqual(a)
    expect(fn(1)).toEqual(b)
  })

  it.each([0, 1e3, 1e6, 1e9])(
    'every intermediate zoom is inside [ZOOM_MIN, ZOOM_MAX] and finite for target %d units away',
    (dist) => {
      const a: Camera = { x: 0, y: 0, zoom: 1 }
      const b: Camera = { x: dist, y: dist * 0.5, zoom: 1.2 }
      const fn = flightCamera(a, b, vp)
      for (let i = 0; i <= 20; i++) {
        const c = fn(i / 20)
        expect(Number.isFinite(c.x)).toBe(true)
        expect(Number.isFinite(c.y)).toBe(true)
        expect(Number.isFinite(c.zoom)).toBe(true)
        expect(c.zoom).toBeGreaterThanOrEqual(ZOOM_MIN)
        expect(c.zoom).toBeLessThanOrEqual(ZOOM_MAX)
      }
    },
  )

  it('no dip for an on-screen target and a dip (zoom lower than both ends) for a far one', () => {
    const a: Camera = { x: 0, y: 0, zoom: 1 }
    // Target whose center is inside the current 1000x800 viewport
    const onScreen: Camera = { x: 100, y: 80, zoom: 1.5 }
    const fnNear = flightCamera(a, onScreen, vp)
    for (let i = 0; i <= 20; i++) {
      const z = fnNear(i / 20).zoom
      expect(z).toBeGreaterThanOrEqual(Math.min(a.zoom, onScreen.zoom) - 1e-9)
      expect(z).toBeLessThanOrEqual(Math.max(a.zoom, onScreen.zoom) + 1e-9)
    }

    // Far target well outside the viewport
    const far: Camera = { x: 5000, y: 4000, zoom: 1.2 }
    const fnFar = flightCamera(a, far, vp)
    const mid = fnFar(0.5)
    expect(mid.zoom).toBeLessThan(Math.min(a.zoom, far.zoom))
  })

  it('flightDuration stays within [250, 1200] ms and scales with distance', () => {
    const a: Camera = { x: 0, y: 0, zoom: 1 }
    const same = flightDuration(a, a, vp)
    const medium = flightDuration(a, { x: 800, y: 600, zoom: 1 }, vp)
    const far = flightDuration(a, { x: 1e6, y: 1e6, zoom: 1 }, vp)

    expect(same).toBe(250)
    expect(medium).toBeGreaterThanOrEqual(250)
    expect(medium).toBeLessThanOrEqual(1200)
    expect(far).toBe(1200)
    expect(far).toBeGreaterThan(medium)
    expect(medium).toBeGreaterThan(same)
  })

  it('cameraFor handles a zero-size rect and a rect larger than the viewport', () => {
    const zero = cameraFor({ minX: 100, minY: 200, maxX: 100, maxY: 200 }, vp)
    expect(zero.zoom).toBe(2) // default maxZoom
    // Center of viewport in world coordinates should be (100, 200)
    expect(zero.x + vp.width / (2 * zero.zoom)).toBeCloseTo(100, 5)
    expect(zero.y + vp.height / (2 * zero.zoom)).toBeCloseTo(200, 5)

    const huge = cameraFor({ minX: 0, minY: 0, maxX: 10000, maxY: 8000 }, vp)
    expect(huge.zoom).toBeGreaterThanOrEqual(ZOOM_MIN)
    expect(huge.zoom).toBeLessThan(1)
    expect(huge.x + vp.width / (2 * huge.zoom)).toBeCloseTo(5000, 5)
    expect(huge.y + vp.height / (2 * huge.zoom)).toBeCloseTo(4000, 5)
  })
})

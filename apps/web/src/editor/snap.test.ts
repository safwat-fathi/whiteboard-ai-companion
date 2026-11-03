import { describe, expect, it } from 'vitest'
import { snapBox } from './snap'

const r = (x: number, y: number, w = 100, h = 40) => ({
  minX: x,
  minY: y,
  maxX: x + w,
  maxY: y + h,
})

describe('snapBox', () => {
  const other = r(300, 0)

  it('snaps an edge within 6 screen px and not beyond', () => {
    // the moving box's left edge is 5.9 px from the other's left edge (300), at zoom 1
    expect(snapBox(r(294.1, 100), [other], 1).dx).toBeCloseTo(5.9, 6)
    expect(snapBox(r(293.9, 100), [other], 1).dx).toBe(0)
  })

  it('the threshold is 6 screen px: 3 world units at zoom 2, 60 at zoom 0.1', () => {
    expect(snapBox(r(297.1, 100), [other], 2).dx).toBeCloseTo(2.9, 6)
    expect(snapBox(r(296.9, 100), [other], 2).dx).toBe(0)
    // a 10-wide box at 245: its right edge (255) is 45 from the other's left edge, inside 60; at 200 it is 90 away
    expect(snapBox(r(245, 100, 10, 40), [other], 0.1).dx).toBeCloseTo(45, 6)
    expect(snapBox(r(200, 100, 10, 40), [other], 0.1).dx).toBe(0)
  })

  it('aligns right edges, and centres', () => {
    // right edge 398 -> 400
    expect(snapBox(r(298, 100), [other], 1).dx).toBeCloseTo(2, 6) // also left edge 298 -> 300: nearest is 2 either way
    // centre: 100 wide at 305 has centre 355; the other's centre is 350
    const wide = r(100, 0, 300, 40) // centre 250
    expect(snapBox(r(203, 100, 100, 40), [wide], 1).dx).toBeCloseTo(-3, 6) // centre 253 -> 250
  })

  it('the nearest candidate wins on an axis', () => {
    // two others whose left edges are 300 and 304: a left edge at 302.5 is 1.5 from 304 and 2.5 from 300
    const s = snapBox(r(302.5, 100), [r(300, 0), r(304, 0, 20, 40)], 1)
    expect(s.dx).toBeCloseTo(1.5, 6)
  })

  it('returns a guide line for each axis it snapped on', () => {
    const s = snapBox(r(298, 3), [other], 1)
    expect(s.dx).toBeCloseTo(2, 6)
    expect(s.dy).toBeCloseTo(-3, 6)
    expect(s.guides).toContainEqual({ axis: 'x', at: 300, from: 0, to: 40 })
    expect(s.guides).toContainEqual({ axis: 'y', at: 0, from: 300, to: 400 })
  })

  it('nothing to snap to is no move and no guides', () => {
    expect(snapBox(r(0, 0), [], 1)).toEqual({ dx: 0, dy: 0, guides: [] })
  })
})

import { DEFAULT_STYLE, type Element } from '@whiteboard/core'
import { describe, expect, it } from 'vitest'
import {
  CameraHistory,
  cameraRect,
  edgeIndicator,
  isOutside,
  locateTarget,
  shouldFollow,
} from './locate'

const box = (id: string, x: number, y: number, w = 100, h = 50): Element =>
  ({
    id,
    type: 'shape',
    x,
    y,
    w,
    h,
    rotation: 0,
    z: `a${id}`,
    style: { ...DEFAULT_STYLE },
    locked: false,
    author: { kind: 'agent', id: 'tutor:t1' },
    v: 0,
    data: { kind: 'rect' },
  }) as Element
const scene = (els: Element[]) => ({ els: new Map(els.map((e) => [e.id, e])) })

describe('locateTarget', () => {
  it('is the union of where the elements are now, so Locate follows an element the student moved', () => {
    const s = scene([box('a', 500, 500), box('b', 700, 600)])
    const t = locateTarget(s, [
      { ids: ['a', 'b'], bounds: { x: 0, y: 0, w: 300, h: 100 } },
    ])
    expect(t).toEqual({
      rect: { minX: 500, minY: 500, maxX: 800, maxY: 650 },
      ids: ['a', 'b'],
      ghost: false,
    })
  })
  it('uses only the elements that still exist', () => {
    const s = scene([box('a', 10, 10)])
    const t = locateTarget(s, [
      { ids: ['a', 'gone'], bounds: { x: 900, y: 900, w: 10, h: 10 } },
    ])
    expect(t).toMatchObject({
      rect: { minX: 10, minY: 10, maxX: 110, maxY: 60 },
      ids: ['a'],
      ghost: false,
    })
  })
  it('falls back to the stored bounds as a ghost when nothing survives', () => {
    const t = locateTarget(scene([]), [
      { ids: ['x'], bounds: { x: 100, y: 200, w: 50, h: 40 } },
      { ids: ['y'], bounds: { x: 200, y: 200, w: 50, h: 40 } },
    ])
    expect(t).toEqual({
      rect: { minX: 100, minY: 200, maxX: 250, maxY: 240 },
      ids: [],
      ghost: true,
    })
  })
  it('is null when it knows neither the elements nor a place', () => {
    expect(locateTarget(scene([]), [{ ids: ['x'], bounds: null }])).toBeNull()
    expect(locateTarget(scene([]), [])).toBeNull()
  })
  it('spans several batches of a turn', () => {
    const s = scene([box('a', 0, 0), box('b', 1000, 1000)])
    const t = locateTarget(s, [
      { ids: ['a'], bounds: null },
      { ids: ['b'], bounds: null },
    ])
    expect(t?.rect).toEqual({ minX: 0, minY: 0, maxX: 1100, maxY: 1050 })
  })
})

describe('CameraHistory', () => {
  it('keeps the last five cameras, newest first out', () => {
    const h = new CameraHistory()
    for (let i = 1; i <= 7; i++) h.push({ x: i, y: 0, zoom: 1 })
    expect(h.size).toBe(5)
    expect(h.pop()?.x).toBe(7)
    expect(h.pop()?.x).toBe(6)
    h.pop()
    h.pop()
    expect(h.pop()?.x).toBe(3)
    expect(h.pop()).toBeUndefined()
  })
})

describe('where is the AI working', () => {
  const view = { minX: 0, minY: 0, maxX: 800, maxY: 600 }
  it('knows when a target is entirely outside what the student sees', () => {
    expect(
      isOutside({ minX: 900, minY: 100, maxX: 1000, maxY: 200 }, view),
    ).toBe(true)
    expect(
      isOutside({ minX: 700, minY: 100, maxX: 900, maxY: 200 }, view),
    ).toBe(false) // partly inside
    expect(
      isOutside({ minX: 100, minY: 100, maxX: 200, maxY: 200 }, view),
    ).toBe(false)
  })
  it('turns a camera into the world rectangle it shows', () => {
    expect(
      cameraRect({ x: 100, y: 50, zoom: 2 }, { width: 800, height: 600 }),
    ).toEqual({ minX: 100, minY: 50, maxX: 500, maxY: 350 })
  })
  it('puts the arrow on the edge of the board, 16 px in, pointing at the target', () => {
    const size = { w: 800, h: 600 }
    expect(edgeIndicator({ dx: 1000, dy: 0 }, size, 16)).toMatchObject({
      x: 784,
      y: 300,
      angle: 0,
    })
    expect(edgeIndicator({ dx: -1000, dy: 0 }, size, 16)).toMatchObject({
      x: 16,
      y: 300,
    })
    expect(edgeIndicator({ dx: 0, dy: 1000 }, size, 16)).toMatchObject({
      x: 400,
      y: 584,
    })
    const diag = edgeIndicator({ dx: 400, dy: 300 }, size, 16)
    expect(diag.x).toBeCloseTo(400 + 400 * (284 / 300)) // the ray meets the bottom edge first
    expect(diag.y).toBeCloseTo(584)
    expect(diag.angle).toBeCloseTo(Math.atan2(300, 400))
  })
  it('follows at most every 600 ms', () => {
    expect(shouldFollow(1000, 0)).toBe(true)
    expect(shouldFollow(1300, 1000)).toBe(false)
    expect(shouldFollow(1600, 1000)).toBe(true)
  })
})

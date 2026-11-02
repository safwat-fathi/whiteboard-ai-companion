// @vitest-environment jsdom
import {
  DEFAULT_STYLE,
  type Element,
  lockedAspect,
  ordered,
  type Point,
} from '@whiteboard/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '../editor'
import { drag, ev, key, ptr, put, rotPt, setup } from '../test-utils'

let ed: Editor
let done: () => void
beforeEach(() => {
  ;({ ed, done } = setup())
})
afterEach(() => done())

const HASH = 'a'.repeat(64)

const mkImage = (
  id: string,
  x: number,
  y: number,
  w = 200,
  h = 100,
  extra: {
    naturalW?: number
    naturalH?: number
    crop?: { x: number; y: number; w: number; h: number }
    rotation?: number
  } = {},
): Element & { type: 'image' } => ({
  id,
  type: 'image',
  x,
  y,
  w,
  h,
  rotation: extra.rotation ?? 0,
  z: 'a0',
  style: { ...DEFAULT_STYLE },
  locked: false,
  author: { kind: 'human', id: 'local' },
  v: 0,
  data: {
    blobId: HASH,
    naturalW: extra.naturalW ?? 400,
    naturalH: extra.naturalH ?? 200,
    ...(extra.crop ? { crop: extra.crop } : {}),
  },
})

const getImg = (id = 'img1') =>
  ed.scene.els.get(id) as (Element & { type: 'image' }) | undefined

describe('image crop tool', () => {
  it('double-click on image enters crop mode; crop to top-left quarter keeps the quarter world position', () => {
    const img = mkImage('img1', 100, 50, 200, 100, {
      naturalW: 400,
      naturalH: 200,
    })
    put(ed, img)
    ed.setTool('select')
    ptr('dblclick', 150, 80)
    expect(ed.tool.id).toBe('crop')
    expect(ed.hidden).toBe('img1')

    // Drag SE handle from (300, 150) to center (200, 100) -> top-left quarter
    drag(ed.tool, [
      [300, 150],
      [200, 100],
    ])
    expect(key(ed.tool, 'Enter')).toBe(true)
    expect(ed.tool.id).toBe('select')
    expect(ed.hidden).toBeNull()

    const after = getImg()
    if (!after) throw new Error('missing image')
    expect(after.data.crop).toEqual({ x: 0, y: 0, w: 200, h: 100 })
    expect([after.x, after.y, after.w, after.h]).toEqual([100, 50, 100, 50])
  })

  it('crop to bottom-right quarter moves x, y so visible pixels stay where they were, and click-away commits', () => {
    const img = mkImage('img1', 100, 50, 200, 100, {
      naturalW: 400,
      naturalH: 200,
    })
    put(ed, img)
    ed.editCrop('img1')

    // Drag NW handle from (100, 50) to (200, 100)
    drag(ed.tool, [
      [100, 50],
      [200, 100],
    ])
    // Click outside to commit
    ed.tool.onPointerDown(ev(10, 10))
    expect(ed.tool.id).toBe('select')

    const after = getImg()
    if (!after) throw new Error('missing image')
    expect(after.data.crop).toEqual({ x: 200, y: 100, w: 200, h: 100 })
    expect([after.x, after.y, after.w, after.h]).toEqual([200, 100, 100, 50])
  })

  it('crop then resize keeps the aspect of the crop', () => {
    const img = mkImage('img1', 100, 50, 200, 200, {
      naturalW: 200,
      naturalH: 200,
    })
    put(ed, img)
    ed.editCrop('img1')

    // Crop height in half (S handle from y=250 to y=150) -> 2:1 aspect
    drag(ed.tool, [
      [200, 250],
      [200, 150],
    ])
    key(ed.tool, 'Enter')

    const cropped = getImg()
    if (!cropped) throw new Error('missing image')
    expect(cropped.data.crop).toEqual({ x: 0, y: 0, w: 200, h: 100 })
    expect([cropped.w, cropped.h]).toEqual([200, 100])
    expect(lockedAspect(cropped)).toBeCloseTo(2, 5)

    // Resize in select tool: aspect must stay 2:1
    ed.setTool('select')
    ed.selection.add('img1')
    drag(ed.tool, [
      [cropped.x + cropped.w, cropped.y + cropped.h],
      [cropped.x + 300, cropped.y + 300],
    ])
    const resized = getImg()
    if (!resized) throw new Error('missing image')
    expect(resized.w / resized.h).toBeCloseTo(2, 4)
  })

  it('crop then undo restores crop, x, y, w, h in one step', () => {
    const img = mkImage('img1', 100, 50, 200, 100, {
      naturalW: 400,
      naturalH: 200,
      crop: { x: 40, y: 20, w: 200, h: 100 },
    })
    put(ed, img)
    const before = structuredClone(getImg())

    const commit = vi.spyOn(ed, 'commit')
    ed.editCrop('img1')
    drag(ed.tool, [
      [100, 50],
      [150, 75],
    ])
    key(ed.tool, 'Enter')

    expect(commit).toHaveBeenCalledTimes(1)
    expect(getImg()?.data.crop).toEqual({ x: 90, y: 45, w: 150, h: 75 })

    ed.undoOnce()
    const restored = getImg()
    expect(restored?.data.crop).toEqual(before?.data.crop)
    expect([restored?.x, restored?.y, restored?.w, restored?.h]).toEqual([
      before?.x,
      before?.y,
      before?.w,
      before?.h,
    ])
  })

  it('crop to 1 px and drag outside the image clamps to [0, naturalW] x [0, naturalH]', () => {
    const img = mkImage('img1', 100, 50, 200, 100, {
      naturalW: 200,
      naturalH: 100,
    })
    put(ed, img)
    ed.editCrop('img1')

    // Drag SE handle way past NW corner -> clamps to 1x1 px at (0, 0)
    drag(ed.tool, [
      [300, 150],
      [-500, -500],
    ])
    key(ed.tool, 'Enter')
    expect(getImg()?.data.crop).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect([getImg()?.w, getImg()?.h]).toEqual([1, 1])

    // Now drag SE handle way past bottom-right of natural image -> clamps to full naturalW x naturalH
    ed.editCrop('img1')
    drag(ed.tool, [
      [101, 51],
      [2000, 2000],
    ])
    key(ed.tool, 'Enter')
    // Full image crop either equals full rect or unsets crop
    const finalCrop = getImg()?.data.crop
    expect(
      finalCrop === undefined ||
        (finalCrop.x === 0 &&
          finalCrop.y === 0 &&
          finalCrop.w === 200 &&
          finalCrop.h === 100),
    ).toBe(true)
    expect([getImg()?.x, getImg()?.y, getImg()?.w, getImg()?.h]).toEqual([
      100, 50, 200, 100,
    ])
  })

  it('crop on an image rotated 30 deg keeps the remaining pixels at their world positions', () => {
    const angle = Math.PI / 6 // 30 degrees
    const img = mkImage('img1', 100, 50, 200, 100, {
      naturalW: 200,
      naturalH: 100,
      rotation: angle,
    })
    put(ed, img)
    const c0: Point = { x: img.x + img.w / 2, y: img.y + img.h / 2 }
    // World position of the top-left corner before crop
    const topLeftWorldBefore = rotPt({ x: img.x, y: img.y }, c0, angle)

    ed.editCrop('img1')
    // SE handle in world space is rotPt({x: 300, y: 150}, c0, angle)
    // Drag it to the element's center c0 (top-left quarter)
    const seWorld = rotPt({ x: 300, y: 150 }, c0, angle)
    drag(ed.tool, [
      [seWorld.x, seWorld.y],
      [c0.x, c0.y],
    ])
    key(ed.tool, 'Enter')

    const after = getImg()
    if (!after) throw new Error('missing image')
    expect(after.data.crop).toEqual({ x: 0, y: 0, w: 100, h: 50 })
    expect(after.w).toBeCloseTo(100, 4)
    expect(after.h).toBeCloseTo(50, 4)

    const c1: Point = { x: after.x + after.w / 2, y: after.y + after.h / 2 }
    const topLeftWorldAfter = rotPt(
      { x: after.x, y: after.y },
      c1,
      after.rotation,
    )
    expect(topLeftWorldAfter.x).toBeCloseTo(topLeftWorldBefore.x, 3)
    expect(topLeftWorldAfter.y).toBeCloseTo(topLeftWorldBefore.y, 3)
  })

  it('handles hit at zoom 0.05 and 20 with 7 px screen tolerance', () => {
    for (const zoom of [0.05, 20]) {
      ed.setScene([
        mkImage('img1', 100, 50, 200, 100, {
          naturalW: 200,
          naturalH: 100,
        }),
      ])
      ed.camera = { x: 0, y: 0, zoom }
      ed.editCrop('img1')

      // Click 6.5 screen px away from SE handle (300, 150) -> within 7 px tolerance
      const offsetWorld = 6.5 / zoom
      const startW: Point = { x: 300 + offsetWorld, y: 150 }
      const endW: Point = { x: 200, y: 100 }
      ed.tool.onPointerDown({
        screen: { x: startW.x * zoom, y: startW.y * zoom },
        world: startW,
        shift: false,
        alt: false,
        button: 0,
        pointerType: 'mouse',
      })
      ed.tool.onPointerMove({
        screen: { x: endW.x * zoom, y: endW.y * zoom },
        world: endW,
        shift: false,
        alt: false,
        button: 0,
        pointerType: 'mouse',
      })
      ed.tool.onPointerUp({
        screen: { x: endW.x * zoom, y: endW.y * zoom },
        world: endW,
        shift: false,
        alt: false,
        button: 0,
        pointerType: 'mouse',
      })
      key(ed.tool, 'Enter')

      expect(getImg()?.data.crop).toEqual({ x: 0, y: 0, w: 100, h: 50 })
    }
  })

  it('Esc leaves the element identical (v unchanged)', () => {
    const img = mkImage('img1', 100, 50, 200, 100, {
      naturalW: 400,
      naturalH: 200,
    })
    put(ed, img)
    const before = structuredClone(ordered(ed.scene)[0])
    const commit = vi.spyOn(ed, 'commit')

    ed.editCrop('img1')
    drag(ed.tool, [
      [300, 150],
      [200, 100],
    ])
    expect(key(ed.tool, 'Escape')).toBe(true)
    expect(commit).not.toHaveBeenCalled()
    expect(ed.tool.id).toBe('select')
    expect(ed.hidden).toBeNull()
    expect(ordered(ed.scene)[0]).toEqual(before)
  })
})

// @vitest-environment jsdom
import {
  type Batch,
  DEFAULT_STYLE,
  type Element,
  type Op,
  OpError,
  ordered,
  type Platform,
  screenToWorld,
} from '@whiteboard/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from './editor'
import { tools } from './tools'

const shape = (id: string, x = 0): Element => ({
  id,
  type: 'shape',
  x,
  y: 0,
  w: 10,
  h: 10,
  rotation: 0,
  z: 'a0',
  style: { ...DEFAULT_STYLE },
  locked: false,
  author: { kind: 'human', id: 'u' },
  v: 0,
  data: { kind: 'rect' },
})
const batch = (...ops: Op[]): Batch => ({ batchId: 'b', label: 'T', ops })
const add = (id: string) => batch({ op: 'add', el: shape(id) })

const ctx = new Proxy({} as Record<string, unknown>, {
  get: (t, k: string) => t[k] ?? (() => {}),
  set: (t, k: string, v) => {
    t[k] = v
    return true
  },
})
const platform: Platform = {
  createCanvas: () => ({ width: 0, height: 0, getContext: () => null }),
  measureText: (_f, t) => t.length * 8,
  registerFont: () => {},
  createPath2D: () => ({}) as Path2D,
}

let frames: FrameRequestCallback[] = []
let host: HTMLElement
let ed: Editor

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  HTMLCanvasElement.prototype.getContext = (() =>
    ctx) as unknown as HTMLCanvasElement['getContext']
  host = document.createElement('div')
  document.body.append(host)
  ed = new Editor(host, { platform })
})
afterEach(() => {
  ed.dispose()
  host.remove()
  vi.unstubAllGlobals()
})

const ids = () => ordered(ed.scene).map((e) => e.id)

describe('Editor', () => {
  it('rejects an invalid batch with OpError and leaves the scene unchanged', () => {
    ed.commit(add('a'))
    expect(() => ed.commit(add('a'))).toThrow(OpError)
    expect(() => ed.commit(batch())).toThrow()
    expect(ids()).toEqual(['a'])
    expect(ed.undo.canUndo).toBe(true)
  })

  it('commit, undoOnce, redoOnce restores the scene', () => {
    ed.commit(add('a'))
    ed.undoOnce()
    expect(ids()).toEqual([])
    ed.redoOnce()
    expect(ids()).toEqual(['a'])
    expect(ed.undo.canRedo).toBe(false)
  })

  it('an edit after an undo clears redo', () => {
    ed.commit(add('a'))
    ed.undoOnce()
    expect(ed.undo.canRedo).toBe(true)
    ed.commit(add('b'))
    expect(ed.undo.canRedo).toBe(false)
  })

  it('undo with an all-skipped result commits nothing', () => {
    ed.commit(add('a'))
    ed.commit(batch({ op: 'patch', id: 'a', set: { x: 5 } }))
    ed.scene.els.set('a', { ...shape('a'), x: 99, v: 9 }) // drifted since
    const before = ed.scene.els.get('a')
    const onChange = vi.fn()
    ed.onChange(onChange)
    ed.undoOnce()
    expect(ed.scene.els.get('a')).toBe(before)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('prunes selection ids that no longer exist', () => {
    ed.commit(add('a'))
    ed.selection.add('a')
    ed.undoOnce()
    expect(ed.selection.size).toBe(0)
  })

  it('invalidate() x10 in one tick schedules one frame', () => {
    for (const f of frames.splice(0)) f(0) // flush the constructor's frame
    for (let i = 0; i < 10; i++) ed.invalidate()
    expect(frames).toHaveLength(1)
    frames[0]?.(0)
    ed.invalidate()
    expect(frames).toHaveLength(2)
  })

  it('setTool throws on unknown ids and cancels the old tool', () => {
    expect(() => ed.setTool('nope')).toThrow()
    const onCancel = vi.fn()
    const other = {
      id: 'other',
      key: 'o',
      onPointerDown() {},
      onPointerMove() {},
      onPointerUp() {},
      onCancel,
    }
    tools.other = other
    try {
      ed.setTool('other')
      ed.setTool('hand')
      expect(onCancel).toHaveBeenCalledTimes(1)
    } finally {
      delete tools.other
    }
  })

  it('ctrl+wheel zooms keeping the world point under the cursor fixed', () => {
    ed.camera = { x: 100, y: 50, zoom: 2 }
    const vp = ed.viewport
    const before = screenToWorld({ x: 300, y: 200 }, ed.camera, vp)
    host.dispatchEvent(
      new WheelEvent('wheel', {
        ctrlKey: true,
        deltaY: -100,
        clientX: 300,
        clientY: 200,
        cancelable: true,
      }),
    )
    expect(ed.camera.zoom).toBeCloseTo(2 * Math.exp(1))
    const after = screenToWorld({ x: 300, y: 200 }, ed.camera, vp)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('plain wheel pans by delta / zoom', () => {
    ed.camera = { x: 0, y: 0, zoom: 2 }
    host.dispatchEvent(
      new WheelEvent('wheel', { deltaX: 40, deltaY: 20, cancelable: true }),
    )
    expect(ed.camera).toEqual({ x: 20, y: 10, zoom: 2 })
  })

  it('hand tool drag pans; ToolEvent.world uses the top-left convention', () => {
    ed.camera = { x: 10, y: 10, zoom: 2 }
    expect(ed.screenToWorldPoint(20, 40)).toEqual({ x: 20, y: 30 })
    ed.setTool('hand')
    const over = host.querySelectorAll('canvas')[1] as HTMLCanvasElement
    const ev = (type: string, x: number, y: number) =>
      over.dispatchEvent(
        new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }),
      )
    ev('pointerdown', 100, 100)
    ev('pointermove', 80, 90)
    ev('pointerup', 80, 90)
    expect(ed.camera).toEqual({ x: 20, y: 15, zoom: 2 })
  })

  it('readOnly blocks commit', () => {
    ed.readOnly = true
    expect(() => ed.commit(add('a'))).toThrow()
    expect(ids()).toEqual([])
  })

  it('getSnapshot and setScene round trip', () => {
    ed.commit(add('a'))
    const snap = JSON.parse(JSON.stringify(ed.getSnapshot()))
    ed.setScene([])
    expect(ids()).toEqual([])
    ed.setScene(snap.elements, snap.camera, snap.undo)
    expect(ids()).toEqual(['a'])
    ed.undoOnce()
    expect(ids()).toEqual([])
  })
})

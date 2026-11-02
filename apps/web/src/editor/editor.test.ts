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

const ev = (x: number, y: number) => ({
  screen: { x, y },
  world: { x, y },
  shift: false,
  alt: false,
  button: 0,
  pointerType: 'mouse',
})
const key = (
  k: string,
  init: KeyboardEventInit = {},
  t: EventTarget = document.body,
) =>
  t.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: k,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  )
const ptr = (type: string, x: number, y: number) =>
  (host.querySelectorAll('canvas')[1] as HTMLCanvasElement).dispatchEvent(
    new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }),
  )

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

  it('invalidateOverlay() redraws the overlay but not the scene', () => {
    const flush = () => {
      for (const f of frames.splice(0)) f(0)
    }
    const draw = vi.fn()
    ed.setTool('select')
    ed.tool.drawOverlay = draw
    flush()
    const rendered = ed.lastRender
    draw.mockClear()
    ed.invalidateOverlay()
    flush()
    expect(draw).toHaveBeenCalledTimes(1)
    expect(ed.lastRender).toBe(rendered)
    ed.invalidate()
    flush()
    expect(draw).toHaveBeenCalledTimes(2)
    expect(ed.lastRender).not.toBe(rendered)
  })

  const stub = (onCancel = () => {}, navigates = false) => ({
    id: 'other',
    key: 'q',
    navigates,
    onPointerDown() {},
    onPointerMove() {},
    onPointerUp() {},
    onCancel,
  })

  it('setTool throws on unknown ids and cancels the old tool', () => {
    expect(() => ed.setTool('nope')).toThrow()
    const onCancel = vi.fn()
    ed.tools.other = stub(onCancel)
    ed.setTool('other')
    ed.setTool('hand')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('two editors have independent tool state', () => {
    const host2 = document.createElement('div')
    document.body.append(host2)
    const ed2 = new Editor(host2, { platform })
    expect(ed2.tools.hand).not.toBe(ed.tools.hand)
    ed.tools.hand?.onPointerDown(ev(0, 0))
    ed2.tools.hand?.onPointerMove(ev(50, 50)) // ed2 never pressed: no pan
    expect(ed2.camera).toEqual({ x: 0, y: 0, zoom: 1 })
    ed2.dispose()
    host2.remove()
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

  it('ctrl/cmd+Z, ctrl+shift+Z and ctrl+Y undo/redo; inputs are ignored', () => {
    ed.commit(add('a'))
    key('z', { ctrlKey: true })
    expect(ids()).toEqual([])
    key('z', { ctrlKey: true, shiftKey: true })
    expect(ids()).toEqual(['a'])
    key('z', { metaKey: true })
    expect(ids()).toEqual([])
    key('y', { ctrlKey: true })
    expect(ids()).toEqual(['a'])
    const input = document.createElement('input')
    document.body.append(input)
    key('z', { ctrlKey: true }, input)
    expect(ids()).toEqual(['a'])
    input.remove()
  })

  describe('shortcuts on a non-Latin keyboard layout match the physical key', () => {
    it('tool letters: an Arabic letter on KeyR selects the rectangle, KeyV select, KeyT text', () => {
      key('ر', { code: 'KeyR' })
      expect(ed.tool.id).toBe('rect')
      key('ف', { code: 'KeyV' })
      expect(ed.tool.id).toBe('select')
      key('ت', { code: 'KeyT' })
      expect(ed.tool.id).toBe('text')
    })

    it('Ctrl/Cmd+Z, +Shift+Z and +Y undo and redo', () => {
      ed.commit(add('a'))
      key('ئ', { ctrlKey: true, code: 'KeyZ' })
      expect(ids()).toEqual([])
      key('ئ', { ctrlKey: true, shiftKey: true, code: 'KeyZ' })
      expect(ids()).toEqual(['a'])
      key('ئ', { metaKey: true, code: 'KeyZ' })
      expect(ids()).toEqual([])
      key('ن', { ctrlKey: true, code: 'KeyY' })
      expect(ids()).toEqual(['a'])
    })

    it('shifted and other non-letter keys of the layout map by position too (Arabic Shift+Z types ~)', () => {
      ed.commit(add('a'))
      key('ئ', { ctrlKey: true, code: 'KeyZ' })
      expect(ids()).toEqual([])
      key('~', { ctrlKey: true, shiftKey: true, code: 'KeyZ' }) // redo
      expect(ids()).toEqual(['a'])
    })

    it('AltGr (reported as ctrl+alt) never maps by position: Polish AltGr+Z is not an undo', () => {
      ed.commit(add('a'))
      key('ż', { ctrlKey: true, altKey: true, code: 'KeyZ' })
      expect(ids()).toEqual(['a'])
      ed.undoOnce()
      key('ż', { ctrlKey: true, altKey: true, shiftKey: true, code: 'KeyZ' })
      key('ź', { ctrlKey: true, altKey: true, code: 'KeyY' }) // not a redo either
      expect(ids()).toEqual([])
    })

    it('the layout letter wins while it is Latin (Dvorak, AZERTY); named keys never map', () => {
      key('p', { code: 'KeyR' }) // Dvorak: the key at QWERTY R types p
      expect(ed.tool.id).toBe('hand')
      key('a', { code: 'KeyQ' }) // AZERTY: a is at QWERTY Q
      expect(ed.tool.id).toBe('arrow')
      key('Process', { code: 'KeyR' }) // an IME is handling the key
      key('Dead', { code: 'KeyR' })
      expect(ed.tool.id).toBe('arrow')
    })

    it('nothing fires while a textarea is focused', () => {
      const ta = document.createElement('textarea')
      document.body.append(ta)
      ed.commit(add('a'))
      key('ر', { code: 'KeyR' }, ta)
      key('ئ', { ctrlKey: true, code: 'KeyZ' }, ta)
      expect(ed.tool.id).toBe('hand')
      expect(ids()).toEqual(['a'])
      ta.remove()
    })
  })

  it('tool keys come from the registry', () => {
    ed.tools.other = stub()
    key('q')
    expect(ed.tool.id).toBe('other')
    key('h')
    expect(ed.tool.id).toBe('hand')
  })

  it('readOnly: navigating tools get pointer events, others are inert, h still works', () => {
    ed.readOnly = true
    ptr('pointerdown', 10, 10)
    ptr('pointermove', 0, 0)
    expect(ed.camera.x).toBe(10)
    const down = vi.fn()
    ed.tools.other = { ...stub(), onPointerDown: down }
    ed.tool = ed.tools.other
    ptr('pointerdown', 1, 1)
    expect(down).not.toHaveBeenCalled()
    key('h')
    expect(ed.tool.id).toBe('hand')
    ed.tools.other = stub()
    key('q')
    expect(ed.tool.id).toBe('hand')
  })

  it('Space-drag pans only when focus is on the board; blur releases it', () => {
    const btn = document.createElement('button')
    document.body.append(btn)
    expect(key(' ', { code: 'Space' }, btn)).toBe(true) // not prevented
    btn.remove()
    expect(key(' ', { code: 'Space' })).toBe(false) // body: claimed
    ed.setTool('hand')
    ed.tools.other = stub()
    ed.tool = ed.tools.other
    ptr('pointerdown', 10, 10)
    ptr('pointermove', 0, 0)
    expect(ed.camera.x).toBe(10)
    ptr('pointerup', 0, 0)
    window.dispatchEvent(new Event('blur'))
    ptr('pointerdown', 10, 10)
    ptr('pointermove', 0, 0)
    expect(ed.camera.x).toBe(10)
  })

  it('a focused button keeps Enter, so a keyboard user can press a toolbar button', () => {
    const onKey = vi.fn(() => true)
    ed.tools.other = { ...stub(), onKey }
    ed.tool = ed.tools.other
    const btn = document.createElement('button')
    document.body.append(btn)
    expect(key('Enter', {}, btn)).toBe(true) // not prevented
    expect(onKey).not.toHaveBeenCalled()
    btn.remove()
    expect(key('Enter')).toBe(false) // body: the tool claims it
    expect(onKey).toHaveBeenCalledTimes(1)
  })

  it('normalises wheel deltaMode lines', () => {
    host.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 2, deltaMode: 1, cancelable: true }),
    )
    expect(ed.camera.y).toBe(32)
  })

  it('dispose removes listeners and schedules no frames', () => {
    const cancel = vi.fn()
    ed.tools.other = { ...stub(cancel) }
    ed.tool = ed.tools.other
    ed.dispose()
    expect(cancel).toHaveBeenCalled()
    frames.length = 0
    host.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 10, cancelable: true }),
    )
    key('z', { ctrlKey: true })
    key('h')
    ed.invalidate()
    expect(ed.camera.y).toBe(0)
    expect(frames).toHaveLength(0)
  })

  it("dispose still tears everything down when the tool's onCancel throws", () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    ed.tools.other = stub(() => {
      throw new Error('boom')
    })
    ed.tool = ed.tools.other
    expect(() => ed.dispose()).not.toThrow()
    expect(err).toHaveBeenCalled() // logged, not swallowed silently
    expect(host.querySelector('canvas')).toBeNull() // the canvases are gone
    frames.length = 0
    host.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 10, cancelable: true }),
    )
    key('z', { ctrlKey: true })
    ed.invalidate()
    expect(ed.camera.y).toBe(0) // the listeners are gone
    expect(frames).toHaveLength(0)
    ed.tool = ed.tools.hand as typeof ed.tool // the afterEach dispose must not log again
    err.mockRestore()
  })

  it('a devicePixelRatio change resizes the canvases and renders', () => {
    const listeners: (() => void)[] = []
    vi.stubGlobal('matchMedia', () => ({
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => {},
    }))
    Object.defineProperty(host, 'clientWidth', {
      value: 100,
      configurable: true,
    })
    Object.defineProperty(host, 'clientHeight', {
      value: 50,
      configurable: true,
    })
    const h2 = document.createElement('div')
    Object.defineProperty(h2, 'clientWidth', { value: 100 })
    Object.defineProperty(h2, 'clientHeight', { value: 50 })
    document.body.append(h2)
    const e2 = new Editor(h2, { platform })
    const c = h2.querySelector('canvas') as HTMLCanvasElement
    expect(c.width).toBe(100)
    ;(ctx as { fillRect: unknown }).fillRect = vi.fn()
    vi.stubGlobal('devicePixelRatio', 2)
    listeners.shift()?.()
    expect([c.width, c.height]).toEqual([200, 100])
    expect(ctx.fillRect).toHaveBeenCalled()
    expect(listeners).toHaveLength(1) // re-armed
    e2.dispose()
    h2.remove()
  })
})

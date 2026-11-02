// @vitest-environment jsdom
import {
  type Batch,
  cameraFor,
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
  createPath2D: () => new Proxy({}, { get: () => () => {} }) as Path2D,
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
  vi.restoreAllMocks()
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
/** A Space keydown (default: on the body, i.e. focus on the board). Returns false when the Editor claimed it. */
const space = (t?: EventTarget, init: KeyboardEventInit = {}) =>
  key(' ', { code: 'Space', ...init }, t)
const spaceUp = (t: EventTarget = document.body) =>
  t.dispatchEvent(
    new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }),
  )
/** A real PointerEvent on the overlay: touch and pen carry a pointerType and an id (the MouseEvents of `ptr` carry neither). */
const tptr = (
  type: string,
  x: number,
  y: number,
  pointerType: string,
  pointerId = 1,
) =>
  (host.querySelectorAll('canvas')[1] as HTMLCanvasElement).dispatchEvent(
    new PointerEvent(type, {
      clientX: x,
      clientY: y,
      pointerType,
      pointerId,
      bubbles: true,
    }),
  )
const cursor = () =>
  (host.querySelectorAll('canvas')[1] as HTMLCanvasElement).style.cursor
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
    expect(ed2.tools.rect).not.toBe(ed.tools.rect)
    ed.tools.rect?.onPointerDown(ev(0, 0))
    ed2.tools.rect?.onPointerMove(ev(50, 50)) // ed2 never pressed: no gesture
    ed2.tools.rect?.onPointerUp(ev(50, 50))
    expect(ed2.scene.els.size).toBe(0)
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

  it('Space-drag pans by the screen delta over the zoom; ToolEvent.world uses the top-left convention', () => {
    ed.camera = { x: 10, y: 10, zoom: 2 }
    expect(ed.screenToWorldPoint(20, 40)).toEqual({ x: 20, y: 30 })
    space()
    ptr('pointerdown', 100, 100)
    ptr('pointermove', 80, 90)
    ptr('pointerup', 80, 90)
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
    const nav = vi.fn()
    ed.tools.nav = { ...stub(() => {}, true), key: '', onPointerDown: nav }
    ed.tool = ed.tools.nav
    ptr('pointerdown', 10, 10)
    expect(nav).toHaveBeenCalledTimes(1)
    ed.setTool('hand')
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

  describe('Hand tool cursor and Space panning', () => {
    const drag = (from: [number, number], to: [number, number]) => {
      ptr('pointerdown', ...from)
      ptr('pointermove', ...to)
      ptr('pointerup', ...to)
    }

    it('Hand shows the open hand, every other tool the default arrow; on every way of switching', () => {
      expect(ed.tool.id).toBe('hand')
      expect(cursor()).toBe('grab') // the Editor starts on Hand
      for (const id of Object.keys(ed.tools).filter((t) => t !== 'hand')) {
        ed.setTool(id)
        expect(cursor(), id).toBe('')
        ed.setTool('hand')
        expect(cursor(), id).toBe('grab')
      }
      key('r')
      expect(cursor()).toBe('')
      key('h')
      expect(cursor()).toBe('grab')
    })

    it('a plain Hand drag moves nothing and has no side effects', () => {
      ed.commit(add('a'))
      ed.selection.add('a')
      const undoBefore = ed.undo.toJSON()
      const changed = vi.fn()
      const moved = vi.fn()
      ed.onChange(changed)
      ed.onCameraChange(moved)
      drag([100, 100], [60, 40])
      expect(ed.camera).toEqual({ x: 0, y: 0, zoom: 1 })
      expect([...ed.selection]).toEqual(['a'])
      expect(changed).not.toHaveBeenCalled()
      expect(moved).not.toHaveBeenCalled()
      expect(ed.undo.toJSON()).toEqual(undoBefore)
    })

    it.each([
      ['hand', 'grab'],
      ['select', ''],
      ['rect', ''],
      ['text', ''],
      ['math', ''],
      ['image', ''],
      ['crop', ''],
    ])(
      'Space shows the closed hand and drags pan whatever the tool (%s); keyup restores the tool cursor',
      (id, base) => {
        ed.setTool(id)
        expect(space()).toBe(false) // claimed: the page does not scroll
        expect(cursor()).toBe('grabbing')
        drag([100, 100], [70, 90])
        expect(ed.camera).toEqual({ x: 30, y: 10, zoom: 1 })
        expect(ids()).toEqual([]) // a shape tool drew nothing
        expect(cursor()).toBe('grabbing')
        spaceUp()
        expect(cursor()).toBe(base)
        drag([100, 100], [70, 90]) // no Space: the drag is the tool's again
        expect(ed.camera).toEqual({ x: 30, y: 10, zoom: 1 })
      },
    )

    it('auto-repeat keydown neither toggles the state nor interrupts a pan', () => {
      space()
      ptr('pointerdown', 100, 100)
      ptr('pointermove', 90, 100)
      space(undefined, { repeat: true })
      space(undefined, { repeat: true })
      expect(cursor()).toBe('grabbing')
      ptr('pointermove', 80, 100)
      expect(ed.camera.x).toBe(20)
      ptr('pointerup', 80, 100)
      space(undefined, { repeat: true })
      expect(cursor()).toBe('grabbing')
      spaceUp() // one keyup ends it however many repeats came
      expect(cursor()).toBe('grab')
      drag([100, 100], [0, 0])
      expect(ed.camera.x).toBe(20)
    })

    it.each([
      ['the window loses focus', () => window.dispatchEvent(new Event('blur'))],
      [
        'the tab is hidden',
        () => {
          vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
          document.dispatchEvent(new Event('visibilitychange'))
        },
      ],
    ])(
      'Space resets when %s, even mid-drag: no stuck grabbing or panning',
      (_n, lose) => {
        space()
        ptr('pointerdown', 100, 100)
        ptr('pointermove', 90, 100)
        expect(ed.camera.x).toBe(10)
        lose()
        expect(cursor()).toBe('grab')
        ptr('pointermove', 50, 100) // the drag is over
        expect(ed.camera.x).toBe(10)
        ptr('pointerup', 50, 100)
        drag([100, 100], [50, 100]) // and Space is not held
        expect(ed.camera.x).toBe(10)
        vi.restoreAllMocks()
      },
    )

    it('Space in a text field types a space and a focused button keeps it: no panning, no closed hand', () => {
      for (const tag of ['textarea', 'input', 'button']) {
        const el = document.createElement(tag)
        document.body.append(el)
        expect(space(el), tag).toBe(true) // not prevented
        expect(cursor(), tag).toBe('grab')
        drag([100, 100], [70, 90])
        expect(ed.camera, tag).toEqual({ x: 0, y: 0, zoom: 1 })
        el.remove()
      }
    })

    it('cursor precedence: Space grabbing > select hover pointer > the tool cursor', () => {
      ed.commit(add('a')) // 10x10 at 0,0, no fill: hit on its edge
      ed.setTool('select')
      ptr('pointermove', 0, 5)
      expect(cursor()).toBe('pointer')
      space()
      expect(cursor()).toBe('grabbing')
      ptr('pointermove', 100, 100) // the hover goes while Space is held...
      expect(cursor()).toBe('grabbing')
      ptr('pointermove', 0, 5)
      spaceUp()
      expect(cursor()).toBe('pointer') // ...and returns with the hover
      ed.setTool('hand')
      expect(cursor()).toBe('grab')
    })

    it.each(['touch', 'pen'])(
      'a %s Hand drag pans without Space; a mouse one does not',
      (pt) => {
        tptr('pointerdown', 100, 100, pt)
        tptr('pointermove', 70, 90, pt)
        expect(cursor()).toBe('grabbing')
        tptr('pointerup', 70, 90, pt)
        expect(ed.camera).toEqual({ x: 30, y: 10, zoom: 1 })
        expect(cursor()).toBe('grab')
        for (const t of ['mouse', '', 'unknown']) {
          tptr('pointerdown', 100, 100, t)
          tptr('pointermove', 0, 0, t)
          tptr('pointerup', 0, 0, t)
        }
        expect(ed.camera).toEqual({ x: 30, y: 10, zoom: 1 })
      },
    )

    it('touch and pen drags pan only with the Hand tool; other tools get them as before', () => {
      const home = { x: 0, y: 0, zoom: 1 }
      ed.setTool('text')
      for (const pt of ['touch', 'pen']) {
        tptr('pointerdown', 100, 100, pt)
        tptr('pointermove', 70, 90, pt)
        tptr('pointerup', 70, 90, pt)
        expect(ed.camera, `text ${pt}`).toEqual(home)
      }
      ed.setTool('rect')
      tptr('pointerdown', 100, 100, 'touch')
      tptr('pointermove', 170, 150, 'touch')
      tptr('pointerup', 170, 150, 'touch')
      expect(ids()).toHaveLength(1) // a touch drag draws
      expect(ed.camera).toEqual(home)
      const [id] = ids() as [string]
      expect(ed.tool.id).toBe('select') // the new shape is selected
      tptr('pointerdown', 120, 100, 'pen') // a pen drag on its top edge moves it
      tptr('pointermove', 150, 100, 'pen')
      tptr('pointerup', 150, 100, 'pen')
      expect(ed.scene.els.get(id)?.x).toBe(130)
      expect(ed.camera).toEqual(home)
    })

    it('a pointer whose capture throws starts no pan: nothing stuck', () => {
      const over = host.querySelectorAll('canvas')[1] as HTMLCanvasElement
      over.setPointerCapture = () => {
        throw new DOMException('no such pointer', 'NotFoundError')
      }
      tptr('pointerdown', 100, 100, 'touch')
      expect(cursor()).toBe('grab')
      tptr('pointermove', 70, 90, 'touch')
      tptr('pointerup', 70, 90, 'touch')
      expect(ed.camera).toEqual({ x: 0, y: 0, zoom: 1 })
    })

    it('a second pointer neither moves the anchor nor ends the pan', () => {
      tptr('pointerdown', 100, 100, 'touch', 1)
      tptr('pointermove', 90, 100, 'touch', 1)
      expect(ed.camera.x).toBe(10)
      tptr('pointerdown', 300, 300, 'touch', 2)
      tptr('pointermove', 200, 300, 'touch', 2)
      tptr('pointercancel', 200, 300, 'touch', 2)
      tptr('pointerup', 200, 300, 'touch', 2)
      expect(ed.camera).toEqual({ x: 10, y: 0, zoom: 1 })
      expect(cursor()).toBe('grabbing')
      tptr('pointermove', 80, 100, 'touch', 1)
      expect(ed.camera.x).toBe(20) // from the first finger's anchor
      tptr('pointerup', 80, 100, 'touch', 1)
      expect(cursor()).toBe('grab')
    })

    it('a Space pan is single-pointer too', () => {
      space()
      tptr('pointerdown', 100, 100, 'mouse', 1)
      tptr('pointerdown', 300, 300, 'touch', 2)
      tptr('pointermove', 200, 300, 'touch', 2)
      tptr('pointermove', 90, 100, 'mouse', 1)
      expect(ed.camera).toEqual({ x: 10, y: 0, zoom: 1 })
    })

    it('releasing Space mid-drag keeps the closed hand until the pointer is up', () => {
      space()
      ptr('pointerdown', 100, 100)
      spaceUp()
      expect(cursor()).toBe('grabbing')
      ptr('pointermove', 90, 100)
      expect(ed.camera.x).toBe(10) // the pan carries on
      expect(cursor()).toBe('grabbing')
      ptr('pointerup', 90, 100)
      expect(cursor()).toBe('grab')
    })

    it('a cancelled pointer ends the pan and restores the cursor', () => {
      space()
      ptr('pointerdown', 100, 100)
      ptr('pointercancel', 100, 100)
      expect(cursor()).toBe('grabbing') // Space is still held
      ptr('pointermove', 50, 100)
      expect(ed.camera.x).toBe(0)
      spaceUp()
      expect(cursor()).toBe('grab')

      tptr('pointerdown', 100, 100, 'touch')
      expect(cursor()).toBe('grabbing')
      tptr('pointercancel', 100, 100, 'touch')
      expect(cursor()).toBe('grab')
      tptr('pointermove', 50, 100, 'touch')
      expect(ed.camera.x).toBe(0)
    })

    it('a tool switch while Space is held keeps the closed hand', () => {
      space()
      ed.setTool('rect')
      expect(cursor()).toBe('grabbing')
      key('h')
      expect(cursor()).toBe('grabbing')
      spaceUp()
      expect(cursor()).toBe('grab')
    })

    it('Space-held double-click starts no tool action', () => {
      const dbl = vi.fn()
      ed.tools.other = { ...stub(), onDoubleClick: dbl }
      ed.setTool('other')
      const over = host.querySelectorAll('canvas')[1] as HTMLCanvasElement
      const dblclick = () =>
        over.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      space()
      dblclick()
      expect(dbl).not.toHaveBeenCalled()
      spaceUp()
      dblclick()
      expect(dbl).toHaveBeenCalledTimes(1)
    })

    it.each(['ctrlKey', 'metaKey', 'altKey'])(
      '%s+Space is not claimed (an OS shortcut that may swallow the keyup): no grabbing, nothing to get stuck',
      (mod) => {
        expect(space(undefined, { [mod]: true })).toBe(true) // not prevented
        expect(cursor()).toBe('grab')
        drag([100, 100], [70, 90])
        expect(ed.camera).toEqual({ x: 0, y: 0, zoom: 1 })
      },
    )

    it('read-only: Hand stays selectable and Space-drag pans, a plain drag does not', () => {
      ed.readOnly = true
      ed.setTool('rect')
      key('h')
      expect(ed.tool.id).toBe('hand')
      expect(cursor()).toBe('grab')
      drag([10, 10], [0, 0])
      expect(ed.camera.x).toBe(0)
      space()
      expect(cursor()).toBe('grabbing')
      drag([10, 10], [0, 0])
      expect(ed.camera.x).toBe(10)
      spaceUp()
      expect(cursor()).toBe('grab')
      tptr('pointerdown', 10, 10, 'touch') // touch has no Space key: it drags
      tptr('pointermove', 0, 0, 'touch')
      tptr('pointerup', 0, 0, 'touch')
      expect(ed.camera.x).toBe(20)
    })
  })

  describe('flyTo and pulse', () => {
    const runNextFrame = (now: number) => {
      vi.spyOn(performance, 'now').mockReturnValue(now)
      const cb = frames.shift()
      cb?.(now)
    }

    it('flyTo resolves done with the camera equal to the target', async () => {
      ed.viewport = { width: 800, height: 600, dpr: 1 }
      vi.spyOn(performance, 'now').mockReturnValue(1000)
      const targetRect = { minX: 400, minY: 300, maxX: 600, maxY: 450 }
      const expected = cameraFor(targetRect, ed.viewport)

      const p = ed.flyTo(targetRect, { duration: 400 })
      runNextFrame(1200) // mid-flight (t = 0.5)
      expect(ed.camera.x).not.toBe(0)
      expect(ed.camera).not.toEqual(expected)

      runNextFrame(1400) // end of flight (t = 1)
      expect(await p).toBe('done')
      expect(ed.camera).toEqual(expected)
    })

    it('a wheel event mid-flight resolves cancelled and leaves the camera where it was', async () => {
      ed.viewport = { width: 800, height: 600, dpr: 1 }
      vi.spyOn(performance, 'now').mockReturnValue(1000)
      const p = ed.flyTo(
        { minX: 1000, minY: 1000, maxX: 1200, maxY: 1200 },
        { duration: 400 },
      )
      runNextFrame(1200)
      const midCam = { ...ed.camera }

      host.dispatchEvent(
        new WheelEvent('wheel', { deltaX: 0, deltaY: 0, cancelable: true }),
      )
      expect(await p).toBe('cancelled')
      expect(ed.camera).toEqual(midCam)
    })

    it('a second flyTo replaces the first', async () => {
      ed.viewport = { width: 800, height: 600, dpr: 1 }
      vi.spyOn(performance, 'now').mockReturnValue(1000)
      const p1 = ed.flyTo(
        { minX: 500, minY: 500, maxX: 700, maxY: 700 },
        { duration: 400 },
      )
      const secondRect = { minX: 2000, minY: 1500, maxX: 2200, maxY: 1700 }
      const p2 = ed.flyTo(secondRect, { duration: 400 })
      expect(await p1).toBe('cancelled')

      runNextFrame(1400)
      expect(await p2).toBe('done')
      expect(ed.camera).toEqual(cameraFor(secondRect, ed.viewport))
    })

    it('prefers-reduced-motion: reduce jumps in the same call', async () => {
      ed.viewport = { width: 800, height: 600, dpr: 1 }
      vi.stubGlobal('matchMedia', (q: string) => ({
        matches: q.includes('prefers-reduced-motion'),
        addEventListener: () => {},
        removeEventListener: () => {},
      }))
      const rect = { minX: 300, minY: 200, maxX: 500, maxY: 400 }
      const res = await ed.flyTo(rect)
      expect(res).toBe('done')
      expect(ed.camera).toEqual(cameraFor(rect, ed.viewport))
    })

    it('Space-drag mid-flight cancels the flight and pans from where it was', async () => {
      ed.viewport = { width: 800, height: 600, dpr: 1 }
      vi.spyOn(performance, 'now').mockReturnValue(1000)
      const p = ed.flyTo(
        { minX: 1000, minY: 1000, maxX: 1200, maxY: 1200 },
        { duration: 400 },
      )
      runNextFrame(1200)
      const mid = { ...ed.camera }
      space()
      ptr('pointerdown', 100, 100)
      ptr('pointermove', 90, 100)
      expect(await p).toBe('cancelled')
      expect(ed.camera.x).toBeCloseTo(mid.x + 10 / mid.zoom)
      expect(ed.camera.y).toBe(mid.y)
      ptr('pointerup', 90, 100)
      spaceUp()
    })

    it('pulse of a deleted id does not throw, and neither flyTo nor pulse marks dirty or adds undo', async () => {
      ed.viewport = { width: 800, height: 600, dpr: 1 }
      ed.commit(add('a'))
      const undoBefore = ed.undo.toJSON()
      const changed = vi.fn()
      ed.onChange(changed)

      vi.spyOn(performance, 'now').mockReturnValue(1000)
      ed.pulse(['a', 'missing-id'])
      expect(() => runNextFrame(1100)).not.toThrow()

      // Delete 'a' while pulse is active
      ed.scene.els.delete('a')
      expect(() => runNextFrame(1300)).not.toThrow()

      const p = ed.flyTo(
        { minX: 100, minY: 100, maxX: 200, maxY: 200 },
        { duration: 300 },
      )
      runNextFrame(1600)
      expect(await p).toBe('done')

      expect(changed).not.toHaveBeenCalled()
      expect(ed.undo.toJSON()).toEqual(undoBefore)
    })
  })
})

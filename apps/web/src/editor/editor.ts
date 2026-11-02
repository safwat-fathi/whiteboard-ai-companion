import {
  applyBatch,
  type Batch,
  type Camera,
  createScene,
  type Element,
  type Id,
  OpError,
  ordered,
  type Platform,
  type Point,
  RenderCache,
  type RenderStats,
  render,
  type Scene,
  SpatialIndex,
  screenToWorld,
  type UndoJSON,
  UndoManager,
  type Viewport,
  worldToScreen,
  zoomAt,
} from '@whiteboard/core'
import { shortcutKey } from './keys'
import { browserPlatform } from './platform'
import { type Tool, type ToolEvent, tools as toolFactories } from './tools'
import type { TextTool } from './tools/text'

export type Snapshot = { elements: Element[]; camera: Camera; undo: UndoJSON }

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)

const canvas = (z: number) => {
  const c = document.createElement('canvas')
  c.style.cssText = `position:absolute;inset:0;width:100%;height:100%;z-index:${z}`
  return c
}

export class Editor {
  scene: Scene
  camera: Camera = { x: 0, y: 0, zoom: 1 }
  undo: UndoManager
  selection = new Set<Id>()
  readonly tools: Record<string, Tool>
  tool: Tool
  readOnly = false
  /** Element drawn by a DOM overlay (text being edited); omitted from the canvas so it is never drawn twice. */
  hidden: Id | null = null
  viewport: Viewport = { width: 0, height: 0, dpr: 1 }
  /** Stats and JS time (ms) of the last scene render; a new object per frame. Read by the /bench page. */
  lastRender: (RenderStats & { ms: number }) | null = null

  readonly index = new SpatialIndex() // tools read it (pick/search)
  private cache = new RenderCache()
  /** Bytes held by the render cache (read by the /bench page). */
  get cacheBytes(): number {
    return this.cache.bytes
  }
  readonly platform: Platform
  private listeners = new Set<() => void>()
  private camListeners = new Set<() => void>()
  private toolListeners = new Set<() => void>()
  private sceneCanvas = canvas(0)
  private overlay = canvas(1)
  private ro?: ResizeObserver
  private raf = 0
  private sceneDirty = true
  private disposed = false
  private space = false
  private panning: Point | null = null
  private off: (() => void)[] = []
  private unDpr?: () => void

  constructor(
    readonly host: HTMLElement,
    opts: { board?: Scene; platform?: Platform } = {},
  ) {
    this.scene = opts.board ?? createScene()
    this.index.load([...this.scene.els.values()])
    this.undo = new UndoManager(this.scene)
    this.platform = opts.platform ?? browserPlatform()
    this.tools = Object.fromEntries(
      Object.entries(toolFactories).map(([id, make]) => [id, make(this)]),
    )
    this.tool = this.tools.hand as Tool

    if (getComputedStyle(host).position === 'static')
      host.style.position = 'relative'
    host.style.touchAction = 'none'
    host.append(this.sceneCanvas, this.overlay)

    const on = <T extends EventTarget>(
      el: T,
      type: string,
      fn: (e: never) => void,
      o?: AddEventListenerOptions,
    ) => {
      el.addEventListener(type, fn as EventListener, o)
      this.off.push(() => el.removeEventListener(type, fn as EventListener, o))
    }
    on(host, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false })
    on(this.overlay, 'pointerdown', (e: PointerEvent) =>
      this.onPointer('down', e),
    )
    on(this.overlay, 'pointermove', (e: PointerEvent) =>
      this.onPointer('move', e),
    )
    on(this.overlay, 'pointerup', (e: PointerEvent) => this.onPointer('up', e))
    on(this.overlay, 'pointerleave', () => this.tool.onPointerLeave?.())
    on(this.overlay, 'dblclick', (e: MouseEvent) => {
      if (this.readOnly) return
      const screen = this.toScreen(e.clientX, e.clientY)
      this.tool.onDoubleClick?.({
        screen,
        world: screenToWorld(screen, this.camera, this.viewport),
        shift: e.shiftKey,
        alt: e.altKey,
        button: e.button,
        pointerType: 'mouse',
      })
    })
    // A cancelled gesture (touch palm rejection, lost capture) must not commit.
    on(this.overlay, 'pointercancel', () => {
      this.panning = null
      this.tool.onCancel?.()
    })
    // The window-level key listeners assume one Editor per page.
    on(window, 'keydown', (e: KeyboardEvent) => this.onKeyDown(e))
    on(window, 'keyup', (e: KeyboardEvent) => {
      if (e.code === 'Space') this.space = false
    })
    const release = () => {
      this.space = false
      this.panning = null
    }
    on(window, 'blur', release)
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') release()
    })
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize())
      this.ro.observe(host)
    }
    this.resize()
    this.watchDpr()
  }

  commit(batch: Batch, kind: 'edit' | 'undo' | 'redo' = 'edit'): void {
    if (this.readOnly) throw new Error('editor is read-only')
    const applied = applyBatch(this.scene, batch) // validates; throws OpError and changes nothing
    for (const id of applied.touched) {
      const el = this.scene.els.get(id)
      if (el) this.index.upsert(el)
      else this.index.remove(id)
    }
    this.undo.record(applied, batch, kind)
    for (const id of this.selection)
      if (!this.scene.els.has(id)) this.selection.delete(id)
    this.changed()
  }

  // The toolbar keeps focus in a text field, so undo/redo can arrive mid-gesture or mid-edit: end it first (a text edit is
  // committed, then undone), or a later commit would patch an element that undo removed.
  undoOnce(): void {
    this.tool.onCancel?.()
    this.replay(this.undo.undo(), 'undo')
  }

  redoOnce(): void {
    this.tool.onCancel?.()
    this.replay(this.undo.redo(), 'redo')
  }

  // An entry loaded from storage can pass the batch schema yet fail element validation when applied (OpError, nothing
  // changed): the entry is consumed and undo carries on, it never throws.
  private replay(r: { batch: Batch } | null, kind: 'undo' | 'redo') {
    if (!r?.batch.ops.length) return
    try {
      this.commit(r.batch, kind)
    } catch (e) {
      if (!(e instanceof OpError)) throw e
    }
  }

  setTool(id: string): void {
    const next = this.tools[id]
    if (!next) throw new Error(`unknown tool: ${id}`)
    if (next === this.tool) return
    this.tool.onCancel?.()
    this.tool = next
    this.invalidate()
    for (const fn of this.toolListeners) fn()
  }

  /** Enters edit mode for a text element (double-click / Enter in the select tool). */
  editText(id: Id): void {
    const el = this.scene.els.get(id)
    if (this.readOnly || el?.type !== 'text' || el.locked) return
    this.setTool('text')
    ;(this.tools.text as TextTool).edit(el)
  }

  /** The scene or camera changed: the next frame repaints the scene canvas and the overlay. */
  invalidate(): void {
    this.sceneDirty = true
    this.request()
  }

  /** Overlay-only change (selection, marquee, handles, previews): the next frame leaves the scene canvas as it is. */
  invalidateOverlay(): void {
    this.request()
  }

  /** CSS cursor over the board; '' is the default arrow. Tools set it and reset it in `onCancel`. */
  setCursor(cursor: string): void {
    this.overlay.style.cursor = cursor
  }

  private request(): void {
    if (this.raf || this.disposed) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.frame()
    })
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Fires on pan/zoom (not on commits); autosave needs it because the camera is part of the saved board. */
  onCameraChange(fn: () => void): () => void {
    this.camListeners.add(fn)
    return () => this.camListeners.delete(fn)
  }

  /** Fires when the active tool changes, whoever changed it (a shortcut, a tool finishing, the toolbar). */
  onToolChange(fn: () => void): () => void {
    this.toolListeners.add(fn)
    return () => this.toolListeners.delete(fn)
  }

  /** Replaces the board contents; undo history is reset unless `undo` JSON is given. */
  setScene(elements: Element[], camera?: Camera, undo?: UndoJSON): void {
    this.scene.els = createScene(elements).els
    this.index.load(elements)
    this.undo = undo
      ? UndoManager.fromJSON(this.scene, undo)
      : new UndoManager(this.scene)
    this.selection.clear()
    this.cache.dispose()
    if (camera) this.camera = camera
    this.changed()
  }

  /** Tells change listeners (autosave) that the saved board is stale without committing anything (an open text draft). */
  markDirty(): void {
    for (const fn of this.listeners) fn()
  }

  /** The board as it should be saved: the scene plus the open text draft (replacing its element by id, or appended). */
  getSnapshot(): Snapshot {
    const draft = (this.tools.text as TextTool | undefined)?.draft()
    let els = ordered(this.scene)
    if (draft)
      els = els.some((e) => e.id === draft.id)
        ? els.map((e) => (e.id === draft.id ? draft : e))
        : [...els, draft]
    return {
      elements: structuredClone(els),
      camera: { ...this.camera },
      undo: this.undo.toJSON(),
    }
  }

  screenToWorldPoint(clientX: number, clientY: number): Point {
    return screenToWorld(
      this.toScreen(clientX, clientY),
      this.camera,
      this.viewport,
    )
  }

  worldToClient(p: Point): Point {
    const s = worldToScreen(p, this.camera, this.viewport)
    const r = this.host.getBoundingClientRect()
    return { x: s.x + r.left, y: s.y + r.top }
  }

  /** Pans by a screen-space (CSS px) delta; content follows the pointer. */
  panBy(dx: number, dy: number): void {
    const { x, y, zoom } = this.camera
    this.camera = { x: x - dx / zoom, y: y - dy / zoom, zoom }
    this.cameraChanged()
  }

  dispose(): void {
    try {
      this.tool.onCancel?.()
    } catch (err) {
      console.error('cancelling the tool failed', err) // the teardown below must still run
    }
    this.disposed = true
    this.unDpr?.()
    cancelAnimationFrame(this.raf)
    for (const f of this.off) f()
    this.ro?.disconnect()
    this.cache.dispose()
    this.sceneCanvas.remove()
    this.overlay.remove()
    this.listeners.clear()
    this.camListeners.clear()
    this.toolListeners.clear()
  }

  private cameraChanged() {
    this.invalidate()
    for (const fn of this.camListeners) fn()
  }

  private changed() {
    this.invalidate()
    this.markDirty()
  }

  private toScreen(clientX: number, clientY: number): Point {
    const r = this.host.getBoundingClientRect()
    return { x: clientX - r.left, y: clientY - r.top }
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1
    const width = this.host.clientWidth
    const height = this.host.clientHeight
    this.viewport = { width, height, dpr }
    for (const c of [this.sceneCanvas, this.overlay]) {
      const w = Math.round(width * dpr)
      const h = Math.round(height * dpr)
      if (c.width !== w) c.width = w
      if (c.height !== h) c.height = h
    }
    // Assigning width/height clears the canvas: repaint now so a resize never shows a blank frame.
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.sceneDirty = true
    this.frame()
  }

  // Page zoom or moving to another monitor changes devicePixelRatio without resizing the host box.
  private watchDpr() {
    this.unDpr?.()
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const fn = () => {
      this.resize()
      this.watchDpr()
    }
    mq.addEventListener('change', fn, { once: true })
    this.unDpr = () => mq.removeEventListener('change', fn)
  }

  private frame() {
    const { width, height, dpr } = this.viewport
    this.tool.onFrame?.()
    const sctx = this.sceneCanvas.getContext('2d')
    if (sctx && this.sceneDirty) {
      this.sceneDirty = false
      const scene = this.hidden
        ? {
            els: new Map(
              [...this.scene.els].filter(([i]) => i !== this.hidden),
            ),
          }
        : this.scene
      const t0 = performance.now()
      const stats = render(
        sctx,
        scene,
        this.camera,
        this.viewport,
        this.platform,
        { index: this.index, cache: this.cache },
      )
      this.lastRender = { ...stats, ms: performance.now() - t0 }
    }
    const octx = this.overlay.getContext('2d')
    if (octx) {
      octx.setTransform(1, 0, 0, 1, 0, 0)
      octx.clearRect(0, 0, width * dpr, height * dpr)
      const s = this.camera.zoom * dpr
      octx.setTransform(s, 0, 0, s, -this.camera.x * s, -this.camera.y * s)
      this.tool.drawOverlay?.(octx)
    }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault()
    const unit =
      e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.viewport.height : 1
    const dx = e.deltaX * unit
    const dy = e.deltaY * unit
    if (e.ctrlKey || e.metaKey)
      this.camera = zoomAt(
        this.camera,
        this.toScreen(e.clientX, e.clientY),
        Math.exp(-dy * 0.01),
      )
    else {
      this.panBy(-dx, -dy)
      return
    }
    this.cameraChanged()
  }

  private onPointer(kind: 'down' | 'move' | 'up', e: PointerEvent) {
    const screen = this.toScreen(e.clientX, e.clientY)
    if (this.panning || (kind === 'down' && this.space)) {
      if (kind === 'down') {
        this.panning = screen
        this.overlay.setPointerCapture?.(e.pointerId)
      } else if (this.panning) {
        if (kind === 'move')
          this.panBy(screen.x - this.panning.x, screen.y - this.panning.y)
        this.panning = kind === 'up' ? null : screen
      }
      return
    }
    if (this.readOnly && !this.tool.navigates) return
    const ev: ToolEvent = {
      screen,
      world: screenToWorld(screen, this.camera, this.viewport),
      shift: e.shiftKey,
      alt: e.altKey,
      button: e.button,
      pointerType: e.pointerType,
    }
    if (kind === 'down') this.overlay.setPointerCapture?.(e.pointerId)
    if (kind === 'down') this.tool.onPointerDown(ev)
    else if (kind === 'move') this.tool.onPointerMove(ev)
    else this.tool.onPointerUp(ev)
  }

  private onKeyDown(e: KeyboardEvent) {
    if (typing(e.target)) return
    const mod = e.ctrlKey || e.metaKey
    const k = shortcutKey(e) // the physical key on a non-Latin layout, so Arabic typists keep R/V/T and Ctrl+Z
    if (e.code === 'Space') {
      // Only claim Space when focus is on the board, so buttons and links keep Space activation.
      const t = e.target
      if (
        t === document.body ||
        t === this.host ||
        t === this.sceneCanvas ||
        t === this.overlay
      ) {
        this.space = true
        e.preventDefault()
      }
    } else if (mod && k === 'z') {
      e.preventDefault()
      if (this.readOnly) return
      if (e.shiftKey) this.redoOnce()
      else this.undoOnce()
    } else if (mod && k === 'y') {
      e.preventDefault()
      if (!this.readOnly) this.redoOnce()
    } else if (
      !this.readOnly &&
      // A focused button keeps Enter (like Space above) so it can be pressed from the keyboard.
      !(e.key === 'Enter' && e.target instanceof HTMLButtonElement) &&
      this.tool.onKey?.(e)
    ) {
      e.preventDefault()
    } else if (!mod && !e.altKey) {
      const t = Object.values(this.tools).find((t) => t.key === k)
      if (t && (!this.readOnly || t.navigates)) this.setTool(t.id)
    }
  }
}

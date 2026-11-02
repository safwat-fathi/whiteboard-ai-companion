import {
  DEFAULT_STYLE,
  type Element,
  type Platform,
  type Point,
} from '@whiteboard/core'
import { vi } from 'vitest'
import { Editor } from './editor'
import type { Tool, ToolEvent } from './tools'

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

/** A real Editor in jsdom with a no-op canvas. Call `done()` in afterEach. At zoom 1 and camera 0 screen == world. */
export function setup() {
  vi.stubGlobal('requestAnimationFrame', () => 1)
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
  const host = document.createElement('div')
  document.body.append(host)
  const ed = new Editor(host, { platform })
  return {
    ed,
    done: () => {
      ed.dispose()
      host.remove()
      vi.unstubAllGlobals()
    },
  }
}

export const ev = (
  x: number,
  y: number,
  mod: Partial<ToolEvent> = {},
): ToolEvent => ({
  screen: { x, y },
  world: { x, y },
  shift: false,
  alt: false,
  button: 0,
  pointerType: 'mouse',
  ...mod,
})

/** down at the first point, a move through each following point, up at the last. */
export const drag = (
  tool: Tool,
  pts: [number, number][],
  mod: Partial<ToolEvent> = {},
) => {
  const [first, ...rest] = pts as [[number, number], ...[number, number][]]
  tool.onPointerDown(ev(...first, mod))
  for (const p of rest) tool.onPointerMove(ev(...p, mod))
  const last = rest.at(-1) ?? first
  tool.onPointerUp(ev(...last, mod))
}

export const key = (tool: Tool, k: string, init: KeyboardEventInit = {}) =>
  tool.onKey?.(new KeyboardEvent('keydown', { key: k, ...init }))

export const mk = (
  id: string,
  x: number,
  y: number,
  w = 100,
  h = 60,
  extra: {
    kind?: 'rect' | 'ellipse' | 'arrow' | 'line'
    rotation?: number
    locked?: boolean
    points?: [number, number][]
    start?: { id: string; fx: number; fy: number }
    end?: { id: string; fx: number; fy: number }
    z?: string
  } = {},
): Element => ({
  id,
  type: 'shape',
  x,
  y,
  w,
  h,
  rotation: extra.rotation ?? 0,
  z: extra.z ?? 'a0',
  style: { ...DEFAULT_STYLE, fill: '#ffffff' },
  locked: extra.locked ?? false,
  author: { kind: 'human', id: 'local' },
  v: 0,
  data: {
    kind: extra.kind ?? 'rect',
    ...(extra.points ? { points: extra.points } : {}),
    ...(extra.start ? { start: extra.start } : {}),
    ...(extra.end ? { end: extra.end } : {}),
  },
})

export const put = (ed: Editor, ...els: Element[]) =>
  ed.commit({
    batchId: 'seed',
    label: 'seed',
    ops: els.map((el) => ({ op: 'add' as const, el })),
  })

export const rotPt = (p: Point, c: Point, a: number): Point => ({
  x: c.x + (p.x - c.x) * Math.cos(a) - (p.y - c.y) * Math.sin(a),
  y: c.y + (p.x - c.x) * Math.sin(a) + (p.y - c.y) * Math.cos(a),
})

import type { Camera, Element } from '@whiteboard/core'
import type { Editor } from '../editor/editor'
import { importImage } from '../editor/images'
import { browserPlatform } from '../editor/platform'
import type { Tool } from '../editor/tools'
import {
  type BenchImage,
  describeScene,
  makeChartScene,
  makeImageScene,
  makeInkScene,
  makeMathScene,
  makeMixedScene,
  makeScene,
  makeTextScene,
  mathLatex,
} from './scene'

// The S1 method (spikes/s1-canvas/web/bench.ts + render.ts measureFrames) run against a real Editor on a fixed
// 1440x900 CSS px host, so results do not depend on the window. Core's camera (x, y) is the top-left corner
// (S1: the centre), so every S1 camera is converted with cam().
const W = 1440
const H = 900

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
const pct = (a: number[], p: number) =>
  [...a].sort((x, y) => x - y)[Math.ceil(p * a.length) - 1] as number // nearest rank
const round = (x: number, d: number) => Number(x.toFixed(d))
const mb = (bytes: number) => round(bytes / 2 ** 20, 1)

const worldOf = (n: number) => {
  const s = Math.sqrt(n / 5000) // 1000x600 for 5,000 elements, 2000x1200 for 20,000 (same density as S1)
  return { x: 0, y: 0, w: 1000 * s, h: 600 * s }
}
const cam = (cx: number, cy: number, zoom: number): Camera => ({
  x: cx - W / 2 / zoom,
  y: cy - H / 2 / zoom,
  zoom,
})

function idleDeltas(count: number) {
  return new Promise<number[]>((done) => {
    const d: number[] = []
    let last = -1
    const f = (t: number) => {
      if (last >= 0) d.push(t - last)
      last = t
      if (d.length < count) requestAnimationFrame(f)
      else done(d)
    }
    requestAnimationFrame(f)
  })
}

function clockTick() {
  let min = Number.POSITIVE_INFINITY
  let a = performance.now()
  for (let i = 0; i < 200000; i++) {
    const b = performance.now()
    if (b > a) {
      min = Math.min(min, b - a)
      a = b
    }
  }
  return min
}

function environment() {
  const gl = document.createElement('canvas').getContext('webgl')
  const ext = gl?.getExtension('WEBGL_debug_renderer_info')
  const glRenderer = gl
    ? String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
    : 'none'
  gl?.getExtension('WEBGL_lose_context')?.loseContext()
  const ua = navigator.userAgent
  return {
    ua,
    devicePixelRatio,
    glRenderer,
    headless: /HeadlessChrome/.test(ua) || /SwiftShader/i.test(glRenderer),
    windowInner: `${innerWidth}x${innerHeight}`,
    screen: `${screen.width}x${screen.height}`,
  }
}

const foreground = () =>
  `${document.visibilityState}, ${document.hasFocus() ? 'focused' : 'not focused'}`

/** Resolves at the end of the next rAF callback: call it AFTER the call that makes the Editor request its frame. */
const frameEnd = () =>
  new Promise<number>((r) => requestAnimationFrame(() => r(performance.now())))

export type BenchKind =
  | 'mix'
  | 'math200'
  | 'text200'
  | 'images50'
  | 'mixed5000'
  | 'ink'
  | 'chart200'

type InkSample = { lat: number; wait: number; work: number }

/** lat = wait + work: wait is the time to the frame's start (vsync alignment), work is the frame itself. */
const firstInkStats = (ink: InkSample[], sceneRepaints: number) => ({
  p95Ms: round(
    pct(
      ink.map((i) => i.lat),
      0.95,
    ),
    2,
  ),
  maxMs: round(Math.max(...ink.map((i) => i.lat)), 2),
  waitP95Ms: round(
    pct(
      ink.map((i) => i.wait),
      0.95,
    ),
    2,
  ),
  workP95Ms: round(
    pct(
      ink.map((i) => i.work),
      0.95,
    ),
    2,
  ),
  sceneRepaints,
  samples: ink.map((i) => round(i.lat, 1)),
})

/** Ten synthetic images, 1,000 to 4,000 px on the long edge, imported through the real pipeline (limits, hashing). */
async function importBenchImages(editor: Editor): Promise<BenchImage[]> {
  const out: BenchImage[] = []
  for (let k = 0; k < 10; k++) {
    const w = 1000 + Math.round((k * 3000) / 9)
    const h = Math.round((w * 3) / 4)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.fillStyle = `hsl(${k * 36} 60% 85%)`
    g.fillRect(0, 0, w, h)
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `hsl(${(k * 36 + i * 9) % 360} 70% ${30 + (i % 5) * 10}%)`
      g.fillRect(
        ((i * 97) % 90) * (w / 100),
        ((i * 53) % 90) * (h / 100),
        w / 10,
        h / 10,
      )
    }
    const blob = await new Promise<Blob>((res, rej) =>
      c.toBlob(
        (b) => (b ? res(b) : rej(new Error('toBlob failed'))),
        'image/png',
      ),
    )
    const { blobId, naturalW, naturalH } = await importImage(
      new File([blob], `bench-${k}.png`, { type: 'image/png' }),
      editor.blobs,
    )
    out.push({ blobId, w: naturalW, h: naturalH })
  }
  return out
}

/** Asks the Editor's own math provider for every formula first, so scene boxes come from real metrics. */
async function mathMetrics(editor: Editor, count: number) {
  const math = editor.platform.math
  if (!math) throw new Error('no math provider')
  const color = '#1e1e1e'
  for (let i = 0; i < count; i++)
    await new Promise<void>((r) => math.request(mathLatex(i), true, color, r))
  return (latex: string) => {
    const e = math.peek(latex, true, color)
    if (!e?.ok) throw new Error(`math failed: ${latex}`)
    return e
  }
}

export async function runBench(
  editor: Editor,
  n: number,
  requestedDpr: string | null,
  alive: { stop: boolean },
  kind: BenchKind = 'mix',
) {
  const stopIf = () => {
    if (alive.stop) throw new Error('stopped')
  }
  const world = worldOf(kind === 'mix' ? n : 5000)
  const cx = world.w / 2
  const cy = world.h / 2
  const genPlatform = browserPlatform() // a separate Platform: the Editor's layout memo starts cold
  let els: Element[]
  if (kind === 'mix')
    els = makeScene(n, n === 20000 ? 2 : 1, world, genPlatform)
  else if (kind === 'text200') els = makeTextScene(200, world, genPlatform)
  else if (kind === 'math200')
    els = makeMathScene(200, world, await mathMetrics(editor, 200))
  else if (kind === 'images50')
    els = makeImageScene(50, world, await importBenchImages(editor))
  else if (kind === 'ink') els = makeInkScene(world)
  else if (kind === 'chart200') els = makeChartScene(200, world)
  else
    els = makeMixedScene(
      5000,
      1,
      world,
      genPlatform,
      await mathMetrics(editor, 250),
      await importBenchImages(editor),
    )
  const sel = editor.tools.select as Tool
  editor.setTool('select')

  /** Repaints at `c` (loading `scene` first, which empties the render cache) and resolves with the time the frame ended; throws if the Editor did not render. */
  const repaint = async (c: Camera, scene?: Element[]) => {
    const before = editor.lastRender
    if (scene) editor.setScene(scene, c)
    else {
      editor.camera = c
      editor.invalidate()
    }
    const end = await frameEnd()
    if (editor.lastRender === before) throw new Error('no editor frame')
    return end
  }

  await sleep(3000) // let navigation tooling settle before anything is timed
  stopIf()
  const fgStart = foreground()
  const env = environment()
  const idleFps = 1000 / mean(await idleDeltas(60))
  const tick = clockTick()

  // Unmeasured warm-up: one cold frame at each zoom the phases use (the RenderCache buckets are zoom * dpr), then 1 s of each path.
  const cold: number[] = []
  for (const zoom of [1, 0.6, 1.4]) {
    await repaint(cam(cx, cy, zoom), zoom === 1 ? els : undefined)
    cold.push(editor.lastRender?.ms ?? 0)
  }
  const pan = (s: number) =>
    cam(
      cx + 150 * Math.sin(2 * Math.PI * 0.6 * s),
      cy + 100 * Math.sin(2 * Math.PI * 0.4 * s),
      1,
    ) // Lissajous 3:2
  const zoomPath = (s: number) =>
    cam(cx, cy, 1 + 0.4 * Math.sin((2 * Math.PI * s) / 2.5)) // 0.6 to 1.4 about the centre

  // Drives the camera from the Editor's own frame loop (Tool.onFrame runs first in Editor.frame, so the new camera is
  // rendered in the same frame, then invalidate() asks for the next one). t is the rAF timestamp of the frame.
  const phase = (ms: number, camAt: (s: number) => Camera) =>
    new Promise<{
      deltas: number[]
      draws: number[]
      minDrawn: number
      maxCulled: number
    }>((done) => {
      const deltas: number[] = []
      const draws: number[] = []
      let t0 = -1
      let last = 0
      let minDrawn = Number.POSITIVE_INFINITY
      let maxCulled = 0
      sel.onFrame = () => {
        const t = Number(document.timeline.currentTime)
        const r = editor.lastRender
        if (t0 < 0) t0 = t
        else if (r) {
          deltas.push(t - last)
          draws.push(r.ms) // the previous frame's render
          minDrawn = Math.min(minDrawn, r.drawn)
          maxCulled = Math.max(maxCulled, r.culled)
        }
        last = t
        if (t - t0 >= ms) {
          sel.onFrame = undefined
          done({ deltas, draws, minDrawn, maxCulled })
          return
        }
        editor.camera = camAt((t - t0) / 1000)
        editor.invalidate()
      }
      editor.invalidate()
    })

  await phase(1000, pan)
  await phase(1000, zoomPath)
  const frames = []
  for (const [name, path] of [
    ['pan', pan],
    ['zoom', zoomPath],
  ] as const) {
    stopIf()
    const p = await phase(5000, path)
    frames.push({
      phase: name,
      meanFps: round(1000 / mean(p.deltas), 1),
      p95FrameMs: round(pct(p.deltas, 0.95), 2),
      drawMsMean: round(mean(p.draws), 2),
      minDrawn: p.minDrawn,
      maxCulled: p.maxCulled,
    })
  }
  const cacheMB = mb(editor.cacheBytes)

  // The M1-only measurements: first ink and opening a 20,000-element board.
  const tail = async () => {
    // First ink. M1 has no pen, so this is the Editor's pointerdown -> overlay-frame latency with the select tool starting
    // a marquee on empty board (an empty marquee, not a stroke; sceneRepaints counts frames that also repainted the scene).
    // The camera fits the board with a 150 px empty band on top, which the pointer lands in. Starts after 500 ms of idle.
    const fz = Math.min(1, W / world.w, (H - 150) / world.h)
    await repaint({ x: cx - W / 2 / fz, y: -150 / fz, zoom: fz })
    await sleep(500)
    const overlay = editor.host.querySelectorAll(
      'canvas',
    )[1] as HTMLCanvasElement
    let overlayFrames = 0
    let overlayStart = 0
    const drawOverlay = sel.drawOverlay?.bind(sel)
    sel.drawOverlay = (ctx) => {
      overlayStart = performance.now()
      drawOverlay?.(ctx)
      overlayFrames++
    }
    const pointer = (type: string, i: number) =>
      overlay.dispatchEvent(
        new PointerEvent(type, {
          clientX: 200 + i * 50,
          clientY: 75,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          pressure: 0.5,
          bubbles: true,
        }),
      )
    const ink: { lat: number; wait: number; work: number }[] = []
    let sceneRepaints = 0
    for (let i = 0; i < 20; i++) {
      stopIf()
      await sleep(50 + Math.random() * 50)
      const frames0 = overlayFrames
      const scene0 = editor.lastRender
      const t0 = performance.now()
      pointer('pointerdown', i)
      const end = await frameEnd()
      if (overlayFrames === frames0)
        throw new Error('pointerdown made no frame')
      if (editor.lastRender !== scene0) sceneRepaints++
      ink.push({
        lat: end - t0,
        wait: overlayStart - t0,
        work: end - overlayStart,
      })
      pointer('pointerup', i)
    }
    sel.drawOverlay = drawOverlay

    // Open a 20,000-element board with the camera fitting all of it: JSON.parse -> setScene (store + index, cache disposed)
    // -> end of the first painted frame. The Editor's layout memo and path cache key on element objects, which are new here.
    const world20k = worldOf(20000)
    const els20k = makeScene(20000, 2, world20k, genPlatform)
    const json = JSON.stringify(els20k)
    await sleep(500)
    stopIf()
    const fit = Math.min(W / world20k.w, H / world20k.h)
    const t0 = performance.now()
    const parsed = JSON.parse(json) as Element[]
    const end = await repaint(cam(world20k.w / 2, world20k.h / 2, fit), parsed)
    const open20k = {
      ms: round(end - t0, 1),
      drawn: editor.lastRender?.drawn,
      culled: editor.lastRender?.culled,
      renderMs: round(editor.lastRender?.ms ?? 0, 1),
      cacheMB: mb(editor.cacheBytes),
      jsonMB: round(json.length / 2 ** 20, 1),
      scene: describeScene(els20k, world20k),
    }
    return {
      firstInk: firstInkStats(ink, sceneRepaints),
      open20k,
    }
  } // tail

  // The M6 first-ink measure, with real input. Playwright (bench/bench.spec.ts) presses the mouse where the page says
  // (`__inkTarget`) with the pen tool active; each pointerdown is timed from the event's own timestamp (when the browser
  // received it, so delivery is included) to the end of the next painting rAF, and the overlay must have drawn in that
  // frame. Escape cancels the stroke (the pen commits nothing), so the scene stays as it was. 20 presses, 50 to 100 ms
  // apart, on the empty band above the board, after 500 ms of idle.
  const inkTail = async () => {
    const fz = Math.min(1, W / world.w, (H - 150) / world.h)
    await repaint({ x: cx - W / 2 / fz, y: -150 / fz, zoom: fz })
    editor.setTool('pen')
    await sleep(500)
    const pen = editor.tools.pen as Tool
    let overlayFrames = 0
    let overlayStart = 0
    const drawOverlay = pen.drawOverlay?.bind(pen)
    pen.drawOverlay = (ctx) => {
      overlayStart = performance.now()
      drawOverlay?.(ctx)
      overlayFrames++
    }
    const ink: (InkSample & { delivery: number })[] = []
    let sceneRepaints = 0
    let missed = false
    const w = window as unknown as {
      __inkTarget?: { x: number; y: number }
      __inkSamples?: number
    }
    // A window listener runs after the Editor's own (on the overlay), so the rAF it registers runs after the Editor's frame.
    const onDown = (e: PointerEvent) => {
      const heard = performance.now()
      const t0 =
        heard - e.timeStamp >= 0 && heard - e.timeStamp < 100
          ? e.timeStamp
          : heard // not a believable stamp: time from now
      const frames0 = overlayFrames
      const scene0 = editor.lastRender
      frameEnd().then((end) => {
        if (overlayFrames === frames0) missed = true
        if (editor.lastRender !== scene0) sceneRepaints++
        ink.push({
          lat: end - t0,
          wait: overlayStart - t0,
          work: end - overlayStart,
          delivery: heard - t0,
        })
        w.__inkSamples = ink.length
      })
    }
    window.addEventListener('pointerdown', onDown)
    w.__inkSamples = 0
    w.__inkTarget = { x: 200, y: 75 }
    for (let t = 0; ink.length < 20 && t < 120_000; t += 50) {
      stopIf()
      await sleep(50)
    }
    window.removeEventListener('pointerdown', onDown)
    pen.drawOverlay = drawOverlay
    if (ink.length < 20)
      throw new Error(`first ink: ${ink.length} of 20 presses seen in 2 min`)
    if (missed)
      throw new Error('first ink: a pointerdown made no overlay frame')
    return {
      firstInk: {
        ...firstInkStats(ink, sceneRepaints),
        deliveryP95Ms: round(
          pct(
            ink.map((i) => i.delivery),
            0.95,
          ),
          2,
        ),
      },
    }
  } // inkTail

  return {
    n,
    requestedDpr,
    host: `${W}x${H} CSS px, fixed`,
    env: {
      ...env,
      idleRafFps: round(idleFps, 1),
      clockTickMs: round(tick, 4),
      foregroundStart: fgStart,
      foregroundEnd: foreground(),
    },
    scene: describeScene(els, world),
    frames,
    coldFrameMs: cold.map((c) => round(c, 1)),
    cacheMB,
    cacheCapMB: mb(editor.cacheCap),
    ...(kind === 'mix' ? await tail() : kind === 'ink' ? await inkTail() : {}),
  }
}

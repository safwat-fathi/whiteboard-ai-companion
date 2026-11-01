import RBush from 'rbush';
import { getStroke } from 'perfect-freehand';
import { bbox, MATH, IMAGES, type El } from './scene';

export type Variant = 'direct' | 'cached' | 'worker';
/** x, y: world point at the canvas centre; zoom: CSS px per world unit; dpr: canvas px per CSS px. */
export type Camera = { x: number; y: number; zoom: number; dpr: number };
type Item = { minX: number; minY: number; maxX: number; maxY: number; el: El };
type BitmapEntry = { v: number; b: ImageBitmap | null };

export const PEN = { thinning: 0.6, smoothing: 0.5, streamline: 0.5, last: true };
// ponytail: bitmaps over 4096 px a side (zoom >~ 8 at DPR 2) fall back to direct drawing; tile them if deep zoom on long text matters.
const MAX_SIDE = 4096;

const trees = new WeakMap<El[], RBush<Item>>();
export function indexOf(els: El[]): RBush<Item> {
  let t = trees.get(els);
  if (!t) trees.set(els, (t = new RBush<Item>().load(els.map((el) => ({ ...bbox(el), el })))));
  return t;
}

// Both variants memoise freehand outlines (getStroke never runs per frame); only `cached` keeps Path2Ds and bitmaps.
let outlines = new WeakMap<El, number[][]>();
let paths = new WeakMap<El, Path2D>();
let bitmaps = new Map<number, Map<string, BitmapEntry>>(); // key (zoomBucket, id, v)
export let cacheBytes = 0;
export function resetCaches() {
  for (const m of bitmaps.values()) for (const e of m.values()) e.b?.close();
  outlines = new WeakMap();
  paths = new WeakMap();
  bitmaps = new Map();
  cacheBytes = 0;
}

function outline(el: El) {
  let o = outlines.get(el);
  if (!o) outlines.set(el, (o = getStroke(el.data.points, { ...PEN, size: el.data.size })));
  return o;
}

// World-space geometry for shapes, lines and strokes: traced into ctx every frame (direct) or once into a Path2D (cached).
function trace(p: CanvasPath, el: El) {
  const { x, y, w, h } = el;
  if (el.type === 'freehand') {
    const o = outline(el);
    p.moveTo(x + o[0][0], y + o[0][1]);
    for (let i = 1; i < o.length - 1; i++)
      p.quadraticCurveTo(x + o[i][0], y + o[i][1], x + (o[i][0] + o[i + 1][0]) / 2, y + (o[i][1] + o[i + 1][1]) / 2);
    p.closePath();
  } else if (el.type === 'line') {
    const [x1, y1, x2, y2] = el.data.flip ? [x + 6, y + h - 6, x + w - 6, y + 6] : [x + 6, y + 6, x + w - 6, y + h - 6];
    p.moveTo(x1, y1);
    p.lineTo(x2, y2);
    if (el.data.arrow) {
      const a = Math.atan2(y2 - y1, x2 - x1);
      for (const d of [2.7, -2.7]) {
        p.moveTo(x2, y2);
        p.lineTo(x2 + 6 * Math.cos(a + d), y2 + 6 * Math.sin(a + d));
      }
    }
  } else if (el.data.kind === 'ellipse') {
    p.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, el.rotation, 0, 2 * Math.PI);
  } else {
    const cx = x + w / 2, cy = y + h / 2, c = Math.cos(el.rotation), s = Math.sin(el.rotation);
    const pts =
      el.data.kind === 'rect' ? [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
      : el.data.kind === 'diamond' ? [[0, -h / 2], [w / 2, 0], [0, h / 2], [-w / 2, 0]]
      : [[0, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    p.moveTo(cx + pts[0][0] * c - pts[0][1] * s, cy + pts[0][0] * s + pts[0][1] * c);
    for (let i = 1; i < pts.length; i++) p.lineTo(cx + pts[i][0] * c - pts[i][1] * s, cy + pts[i][0] * s + pts[i][1] * c);
    p.closePath();
  }
}

function drawText(g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, el: El, x: number, y: number) {
  g.font = `${el.data.size}px sans-serif`;
  g.direction = el.data.dir;
  g.fillStyle = el.style.stroke;
  g.fillText(el.data.text, x, y);
}

const sourceOf = (el: El) => (el.type === 'math' ? MATH[el.data.src] : IMAGES[el.data.blob]);

function bitmapOf(el: El, m: Map<string, BitmapEntry>, k: number): ImageBitmap | null {
  const e = m.get(el.id);
  if (e && e.v === el.v) return e.b;
  e?.b?.close();
  const w = Math.max(1, Math.ceil(el.w * k)), h = Math.max(1, Math.ceil(el.h * k));
  let b: ImageBitmap | null = null;
  if (w <= MAX_SIDE && h <= MAX_SIDE) {
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d')!;
    g.scale(k, k);
    if (el.type === 'text') {
      g.textBaseline = 'top';
      drawText(g, el, 0, 0);
    } else {
      g.imageSmoothingQuality = 'high';
      g.drawImage(sourceOf(el), 0, 0, el.w, el.h);
    }
    b = c.transferToImageBitmap();
    cacheBytes += w * h * 4;
  }
  m.set(el.id, { v: el.v, b });
  return b;
}

/** Draws the elements the R-tree finds in the viewport, in z order; returns how many were drawn. */
export function renderScene(ctx: CanvasRenderingContext2D, els: El[], cam: Camera, variant: Variant): number {
  const { width: W, height: H } = ctx.canvas, s = cam.zoom * cam.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(s, 0, 0, s, W / 2 - cam.x * s, H / 2 - cam.y * s);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const hw = W / s / 2, hh = H / s / 2;
  const hits = indexOf(els).search({ minX: cam.x - hw, minY: cam.y - hh, maxX: cam.x + hw, maxY: cam.y + hh });
  hits.sort((a, b) => a.el.z - b.el.z);

  const bucket = 2 ** Math.ceil(Math.log2(cam.zoom)); // power of two at or above the zoom: never magnified
  const k = bucket * cam.dpr;
  let m = bitmaps.get(bucket);
  if (!m) bitmaps.set(bucket, (m = new Map()));

  let drawn = 0;
  for (const { el } of hits) {
    if (el.type === 'shape' || el.type === 'line' || el.type === 'freehand') {
      let p: Path2D | undefined;
      if (variant === 'cached') {
        p = paths.get(el);
        if (!p) {
          p = new Path2D();
          trace(p, el);
          paths.set(el, p);
        }
      } else {
        ctx.beginPath();
        trace(ctx, el);
      }
      if (el.type === 'freehand') {
        ctx.fillStyle = el.style.stroke;
        p ? ctx.fill(p) : ctx.fill();
      } else {
        if (el.style.fill) {
          ctx.fillStyle = el.style.fill;
          p ? ctx.fill(p) : ctx.fill();
        }
        ctx.lineWidth = el.style.strokeWidth;
        ctx.strokeStyle = el.style.stroke;
        p ? ctx.stroke(p) : ctx.stroke();
      }
      drawn++;
    } else if (el.type === 'text' || el.type === 'math' || el.type === 'image') {
      const b = variant === 'cached' ? bitmapOf(el, m, k) : null;
      if (b) ctx.drawImage(b, el.x, el.y, b.width / k, b.height / k);
      else if (el.type === 'text') drawText(ctx, el, el.x, el.y);
      else ctx.drawImage(sourceOf(el), el.x, el.y, el.w, el.h);
      drawn++;
    }
  }
  return drawn;
}

// Two canvases with dirty flags: the scene repaints only when the scene or camera changes, the overlay only for ink.
export const view = {
  els: [] as El[],
  cam: { x: 0, y: 0, zoom: 1, dpr: 1 } as Camera,
  variant: 'direct' as Variant,
  sceneDirty: false,
  overlayDirty: false,
  ink: [] as number[][], // stroke in progress, CSS px
  drawn: 0,
  drawMs: 0,
  frameStart: 0,
  inkMs: 0,
  onFrame: (_t: number) => {}, // runs at the start of each frame, before painting
};
let sctx: CanvasRenderingContext2D, octx: CanvasRenderingContext2D, pending = false;
const ends: ((t: number) => void)[] = [];

/** The worker variant mounts its OffscreenCanvas as the scene and the page mounts only the overlay. */
export function mount(scene: HTMLCanvasElement | OffscreenCanvas | null, overlay?: HTMLCanvasElement) {
  if (scene) sctx = scene.getContext('2d', { alpha: false }) as CanvasRenderingContext2D;
  if (overlay) octx = overlay.getContext('2d')!;
}
export function invalidate() {
  if (!pending) {
    pending = true;
    requestAnimationFrame(frame);
  }
}
/** Resolves with performance.now() taken at the end of the next painted frame. */
export const frameEnd = () => new Promise<number>((r) => ends.push(r));

function frame(t: number) {
  pending = false;
  view.frameStart = performance.now();
  view.onFrame(t);
  if (view.sceneDirty) {
    view.sceneDirty = false;
    const t0 = performance.now();
    view.drawn = renderScene(sctx, view.els, view.cam, view.variant);
    view.drawMs = performance.now() - t0;
  }
  if (view.overlayDirty) {
    view.overlayDirty = false;
    const t0 = performance.now();
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, octx.canvas.width, octx.canvas.height);
    octx.setTransform(view.cam.dpr, 0, 0, view.cam.dpr, 0, 0);
    const o = getStroke(view.ink, { ...PEN, size: 8, last: false });
    octx.beginPath();
    o.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)));
    octx.fillStyle = '#1e1e1e';
    octx.fill();
    view.inkMs = performance.now() - t0;
  }
  const now = performance.now();
  for (const r of ends.splice(0)) r(now);
}

// Measurements on the mounted scene canvas, run by the page (direct, cached) or inside the worker (worker).

export const pan = (s: number) => ({ x: 500 + 150 * Math.sin(2 * Math.PI * 0.6 * s), y: 300 + 100 * Math.sin(2 * Math.PI * 0.4 * s), zoom: 1 }); // Lissajous 3:2
export const zoomPath = (s: number) => ({ x: 500, y: 300, zoom: 1 + 0.4 * Math.sin((2 * Math.PI * s) / 2.5) }); // 0.6 ↔ 1.4 about the centre

// Drives the camera from elapsed rAF time for `ms`; records rAF deltas, renderScene time and the drawn count per frame.
function phase(ms: number, camAt: (s: number) => Partial<Camera>) {
  return new Promise<{ deltas: number[]; draws: number[]; minDrawn: number }>((done) => {
    const deltas: number[] = [], draws: number[] = [];
    let t0 = -1, last = 0, minDrawn = Infinity;
    view.onFrame = (t) => {
      if (t0 < 0) t0 = t;
      else {
        deltas.push(t - last);
        draws.push(view.drawMs); // previous frame's paint
        minDrawn = Math.min(minDrawn, view.drawn);
      }
      last = t;
      if (t - t0 >= ms) {
        view.onFrame = () => {};
        return done({ deltas, draws, minDrawn });
      }
      Object.assign(view.cam, camAt((t - t0) / 1000));
      view.sceneDirty = true;
      invalidate();
    };
    invalidate();
  });
}

/** Unmeasured warm-up (one cold frame at each zoom bucket the phases use: 1, 1, 2; then 1 s of each path), then 5 s pan and 5 s zoom. */
export async function measureFrames(home: Camera) {
  resetCaches();
  const cold = [1, 0.6, 1.4].map((zoom) => {
    const t0 = performance.now();
    renderScene(sctx, view.els, { ...home, zoom }, view.variant);
    return performance.now() - t0;
  });
  await phase(1000, pan);
  await phase(1000, zoomPath);
  const phases = [];
  for (const [name, path] of [['pan', pan], ['zoom', zoomPath]] as const) phases.push({ name, ...(await phase(5000, path)) });
  return { cold, phases, bitmapMB: cacheBytes / 2 ** 20 };
}

/** renderScene's count at zoom 0.05 and 20 vs a fresh R-tree query and a brute-force scan of a viewport rect computed here from CSS size. */
export function checkExtremes(home: Camera, cssW: number, cssH: number) {
  return [0.05, 20].map((zoom) => {
    const drawn = renderScene(sctx, view.els, { ...home, zoom }, view.variant);
    const r = { minX: home.x - cssW / 2 / zoom, minY: home.y - cssH / 2 / zoom, maxX: home.x + cssW / 2 / zoom, maxY: home.y + cssH / 2 / zoom };
    const rtree = indexOf(view.els).search(r).length;
    const brute = view.els.filter((e) => {
      const b = bbox(e);
      return b.minX <= r.maxX && b.maxX >= r.minX && b.minY <= r.maxY && b.maxY >= r.minY;
    }).length;
    return { zoom, drawn, rtree, brute, ok: drawn > 0 && drawn === rtree && rtree === brute };
  });
}

export async function show(cam: Camera) {
  Object.assign(view.cam, cam);
  view.sceneDirty = true;
  const painted = frameEnd();
  invalidate();
  await painted;
}

/** Opens a board: JSON.parse → store → rbush.load → end of the first painted frame, from cold caches. */
export async function open(json: string, cam: Camera) {
  resetCaches();
  const t0 = performance.now();
  const els: El[] = JSON.parse(json);
  const store = new Map(els.map((e) => [e.id, e]));
  indexOf(els);
  Object.assign(view, { els, cam, sceneDirty: true });
  const painted = frameEnd();
  invalidate();
  return { ms: (await painted) - t0, stored: store.size, drawn: view.drawn };
}

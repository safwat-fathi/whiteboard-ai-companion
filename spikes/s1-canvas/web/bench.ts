import RBush from 'rbush';
import { getStroke } from 'perfect-freehand';
import { makeScene, bbox, type El } from './scene';
import { view, mount, invalidate, frameEnd, measureFrames, checkExtremes, show, open, settle, PEN, type Camera, type Variant } from './render';

const q = new URLSearchParams(location.search);
const variant = (q.get('variant') ?? 'direct') as Variant;
const dpr = (q.get('dpr') === '1' ? 1 : 2) as 1 | 2;
// Fixed CSS size, independent of the window: holds the 1000×600 world rect at zoom 1.4 and along the whole pan path.
const W = 1440, H = 900;

const out = document.getElementById('out')!;
const sceneCv = document.getElementById('scene') as HTMLCanvasElement;
const overlayCv = document.getElementById('overlay') as HTMLCanvasElement;
for (const c of [sceneCv, overlayCv]) {
  c.width = W * dpr;
  c.height = H * dpr;
  c.style.width = `${W}px`;
  c.style.height = `${H}px`;
}
// The worker variant hands the scene canvas to worker.ts; everything else stays on this thread.
const worker = variant === 'worker' ? new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) : null;
const ask = (msg: any, transfer: Transferable[] = []) =>
  new Promise<any>((r) => {
    worker!.onmessage = (e) => r(e.data);
    worker!.postMessage(msg, transfer);
  });
mount(worker ? null : sceneCv, overlayCv);

let inkAt = 0;
overlayCv.addEventListener('pointerdown', (e) => {
  inkAt = e.timeStamp;
  view.ink = [[e.clientX, e.clientY, e.pressure]];
  view.overlayDirty = true; // the scene canvas stays clean
  invalidate();
});

const els = makeScene(5000, 1, { x: 0, y: 0, w: 1000, h: 600 });
const home: Camera = { x: 500, y: 300, zoom: 1, dpr };
Object.assign(view, { els, cam: { ...home }, variant });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.ceil(p * a.length) - 1]; // nearest rank
const round = (x: number, d: number) => Number(x.toFixed(d));
const mix = (a: El[]) => JSON.stringify(Object.fromEntries(Object.entries(Object.groupBy(a, (e) => e.type)).map(([t, l]) => [t, l!.length])));
const foreground = () => `${document.visibilityState}, ${document.hasFocus() ? 'focused' : 'not focused'}`;

function idleDeltas(n: number) {
  return new Promise<number[]>((done) => {
    const d: number[] = [];
    let last = -1;
    const f = (t: number) => {
      if (last >= 0) d.push(t - last);
      last = t;
      if (d.length < n) requestAnimationFrame(f);
      else done(d);
    };
    requestAnimationFrame(f);
  });
}

function clockTick() {
  let min = Infinity, a = performance.now();
  for (let i = 0; i < 200000; i++) {
    const b = performance.now();
    if (b > a) {
      min = Math.min(min, b - a);
      a = b;
    }
  }
  return min;
}

function environment() {
  const gl = document.createElement('canvas').getContext('webgl');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  const glRenderer = gl ? String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : 'none';
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  const ua = navigator.userAgent;
  return { ua, dpr: devicePixelRatio, glRenderer, headless: /HeadlessChrome/.test(ua) || /SwiftShader/i.test(glRenderer) };
}

async function run() {
  out.textContent = `running ${variant} dpr${dpr}…`;
  await sleep(3000); // let navigation tooling settle before anything is timed
  const fgStart = foreground();
  const env = environment();
  const idleFps = 1000 / mean(await idleDeltas(60));
  const tick = clockTick();

  // Warm-up and the measured pan and zoom phases (render.ts measureFrames), here or in the worker.
  let m: Awaited<ReturnType<typeof measureFrames>>;
  if (worker) {
    const canvas = sceneCv.transferControlToOffscreen();
    m = await ask({ canvas, dpr }, [canvas]);
  } else m = await measureFrames(home);
  const frames = m.phases.map((p) => ({ variant, dpr, phase: p.name, meanFps: round(1000 / mean(p.deltas), 1), p95FrameMs: round(pct(p.deltas, 0.95), 2), drawMsMean: round(mean(p.draws), 2) }));
  const minDrawn = Object.fromEntries(m.phases.map((p) => [p.name, p.minDrawn]));
  const bitmapMB = round(m.bitmapMB, 1);

  // Zoom extremes (render.ts checkExtremes): renderScene's count vs a fresh R-tree query and a brute-force scan.
  const extremes: { ok: boolean }[] = worker ? await ask({ extremes: true, cssW: W, cssH: H }) : checkExtremes(home, W, H);

  // First ink: 20 synthetic pointerdowns at times independent of rAF, 5,000-element scene on the (static) scene canvas,
  // starting once the render loop has been idle for 500 ms (no dirty frame, no cold bitmap fill) on every thread.
  if (worker) {
    await ask({ show: true });
    await ask({ settle: 500 });
  } else await show(home);
  await settle(500);
  const ink: { lat: number; wait: number; paint: number }[] = [];
  for (let i = 0; i < 20; i++) {
    await sleep(50 + Math.random() * 50);
    const painted = frameEnd();
    overlayCv.dispatchEvent(new PointerEvent('pointerdown', { clientX: 200 + i * 50, clientY: 450, pressure: 0.5, pointerType: 'pen', isPrimary: true, bubbles: true }));
    const end = await painted;
    ink.push({ lat: end - inkAt, wait: view.frameStart - inkAt, paint: view.inkMs });
  }

  // Open a 20,000-element board (render.ts open) with the camera fitting the whole 2000×1200 world,
  // so all 20,000 elements are drawn in the first frame.
  const src20k = makeScene(20000, 2, { x: 0, y: 0, w: 2000, h: 1200 });
  const json = JSON.stringify(src20k);
  const cam20k: Camera = { x: 1000, y: 600, zoom: Math.min(W / 2000, H / 1200), dpr };
  const opened: { ms: number; stored: number; drawn: number } = worker ? await ask({ json, cam: cam20k }) : await open(json, cam20k);

  // R-tree on the 20k board: bulk load (median of 5), 1000×600 viewport queries (~5,000 hits each), remove + insert.
  const items = src20k.map((el) => ({ ...bbox(el), el }));
  const loads = Array.from({ length: 5 }, () => {
    const t = performance.now();
    new RBush().load(items);
    return performance.now() - t;
  });
  const tree = new RBush<(typeof items)[number]>().load(items);
  const query = () => {
    const x = Math.random() * 1000, y = Math.random() * 600;
    return tree.search({ minX: x, minY: y, maxX: x + 1000, maxY: y + 600 }).length;
  };
  for (let i = 0; i < 50; i++) query();
  const qt: number[] = [];
  let hits = 0;
  for (let i = 0; i < 1000; i++) {
    const t = performance.now();
    hits += query();
    qt.push(performance.now() - t);
  }
  const move = () => {
    const it = items[Math.floor(Math.random() * items.length)];
    tree.remove(it);
    const dx = Math.random() * 40 - 20, dy = Math.random() * 40 - 20;
    it.minX += dx;
    it.maxX += dx;
    it.minY += dy;
    it.maxY += dy;
    tree.insert(it);
  };
  for (let i = 0; i < 100; i++) move();
  const tm = performance.now();
  for (let i = 0; i < 1000; i++) move();
  const moveAvgMs = (performance.now() - tm) / 1000;

  // getStroke on one smooth stroke of 500 / 1,000 / 5,000 points, after warm-up, averaged.
  const freehand = ([500, 1000, 5000] as const).map((points) => {
    let x = 0, y = 0, a = 0;
    const pts = Array.from({ length: points }, (_, j) => {
      a += 0.2 * Math.sin(j / 13);
      x += 2 * Math.cos(a);
      y += 2 * Math.sin(a);
      return [x, y, 0.5 + 0.3 * Math.sin(j / 7)];
    });
    const opts = { ...PEN, size: 6 };
    for (let i = 0; i < 5; i++) getStroke(pts, opts);
    const reps = points === 5000 ? 20 : 100;
    const t = performance.now();
    for (let i = 0; i < reps; i++) getStroke(pts, opts);
    return { points, getStrokeMs: round((performance.now() - t) / reps, 3) };
  });

  const result = {
    env,
    frames,
    open20kMs: round(opened.ms, 1),
    firstInkP95Ms: round(pct(ink.map((i) => i.lat), 0.95), 2),
    rbush: { load20kMs: round(pct(loads, 0.5), 2), queryP95Ms: round(pct(qt, 0.95), 3), moveAvgMs: round(moveAvgMs, 4) },
    freehand,
  };
  (window as any).__s1 = result;

  const lines: string[] = [];
  const check = (name: string, ok: boolean, detail: string) => lines.push(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  for (const f of frames) check(`frames ${f.variant} dpr${f.dpr} ${f.phase}`, f.meanFps >= 58 && f.p95FrameMs <= 17.5, `meanFps ${f.meanFps} (>= 58), p95FrameMs ${f.p95FrameMs} (<= 17.5), drawMsMean ${f.drawMsMean}`);
  check('open20kMs', result.open20kMs < 2000, `${result.open20kMs} (< 2000)`);
  check('firstInkP95Ms', result.firstInkP95Ms <= 16, `${result.firstInkP95Ms} (<= 16)`);
  check('rbush.load20kMs', result.rbush.load20kMs <= 50, `${result.rbush.load20kMs} (<= 50)`);
  check('rbush.queryP95Ms', result.rbush.queryP95Ms <= 1, `${result.rbush.queryP95Ms} (<= 1)`);
  check('rbush.moveAvgMs', result.rbush.moveAvgMs <= 0.1, `${result.rbush.moveAvgMs} (<= 0.1)`);
  const at1k = freehand.find((f) => f.points === 1000)!.getStrokeMs;
  check('getStrokeMs@1000', at1k <= 2, `${at1k} (<= 2)`);
  check('zoom-extreme assertion', extremes.every((e) => e.ok), JSON.stringify(extremes));
  lines.push(
    '',
    `canvas: ${W}x${H} CSS px at dpr ${dpr} (${W * dpr}x${H * dpr}); window inner ${innerWidth}x${innerHeight}; device dpr ${devicePixelRatio}`,
    `foreground: start ${fgStart}; end ${foreground()}`,
    `idle rAF: ${round(idleFps, 1)} fps; performance.now() tick: ${round(tick, 4)} ms`,
    `scene 5k mix: ${mix(els)}; scene 20k mix: ${mix(src20k)}`,
    `min drawn per frame: pan ${minDrawn.pan}, zoom ${minDrawn.zoom} (of ${els.length})`,
    `cold renderScene ms at zoom 1 / 0.6 / 1.4: ${m.cold.map((c) => round(c, 1)).join(' / ')}; bitmap cache after phases: ${bitmapMB} MB`,
    `first ink: wait-for-rAF p95 ${round(pct(ink.map((i) => i.wait), 0.95), 2)} ms; overlay paint max ${round(Math.max(...ink.map((i) => i.paint)), 2)} ms; samples ${ink.map((i) => round(i.lat, 1)).join(' ')}`,
    `open20k: store ${opened.stored} elements, drawn in first frame ${opened.drawn}, JSON ${round(json.length / 2 ** 20, 1)} MB`,
    `rbush: loads ${loads.map((l) => round(l, 1)).join(' ')} ms; queries 1000x600 in a 2000x1200 world, mean hits ${Math.round(hits / 1000)}`,
  );
  out.textContent = `${lines.join('\n')}\n\n${JSON.stringify(result, null, 1)}`;
  console.log(lines.join('\n'));
}

if (q.get('auto') === '1') run();
else if (!worker) {
  view.sceneDirty = true;
  invalidate();
}

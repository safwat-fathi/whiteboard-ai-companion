// S1 scene: the plan's fixed element mix, seeded. Elements are plain JSON (what a DB row holds);
// freehand keeps raw points and math/images keep a bitmap key, so outlines and caches are built after load.

export type Rect = { x: number; y: number; w: number; h: number };
export type El = {
  id: string;
  type: 'shape' | 'line' | 'text' | 'math' | 'image' | 'freehand';
  x: number; y: number; w: number; h: number;
  rotation: number;
  z: number; // ponytail: numeric z; the engine's fractional-index strings would sort as strings each frame
  v: number;
  style: { stroke: string; fill: string | null; strokeWidth: number };
  data: any;
};

// Per 5,000 elements.
const MIX = { shape: 1800, line: 500, text: 1500, math: 400, image: 300, freehand: 500 };
const INK = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#6741d9', '#0c8599', '#c2255c'];
const FILL = ['#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99', '#d0bfff'];
// Generated words, so nearly every text element is a distinct string (no flattering shape-cache hits).
const SYLLABLES = 'ka lo mi ren to sa vi ne tor que lin dar fo pel mu chi ga sto ber ix'.split(' ');
const ARABIC_LETTERS = 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي';
const EQUATIONS = ['E = mc²', '∫₀¹ x² dx = ⅓', 'a² + b² = c²', '∑ 1/n² = π²/6', 'x = (−b ± √Δ) / 2a', '∇ · E = ρ / ε₀', 'e^(iπ) + 1 = 0', 'det(A − λI) = 0'];

export function rng(seed: number) {
  // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const measure = new OffscreenCanvas(1, 1).getContext('2d')!;
function widthOf(text: string, font: string) {
  measure.font = font;
  return measure.measureText(text).width;
}
const round2 = (x: number) => Math.round(x * 100) / 100;

// Pre-rasterised bitmaps shared by every math element (8 distinct, stand-ins for MathJax output)
// and every image element (3 distinct, stand-ins for decoded uploads).
export const MATH = EQUATIONS.map((eq) => {
  const c = new OffscreenCanvas(Math.ceil(widthOf(eq, 'italic 64px serif')) + 16, 96);
  const g = c.getContext('2d')!;
  g.font = 'italic 64px serif';
  g.textBaseline = 'middle';
  g.fillStyle = '#1e1e1e';
  g.fillText(eq, 8, 48);
  return c.transferToImageBitmap();
});
export const IMAGES = [0, 1, 2].map((i) => {
  const c = new OffscreenCanvas(512, 384);
  const g = c.getContext('2d')!;
  const r = rng(100 + i);
  const grad = g.createLinearGradient(0, 0, 512, 384);
  grad.addColorStop(0, FILL[i]);
  grad.addColorStop(1, INK[i + 3]);
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 384);
  for (let k = 0; k < 40; k++) {
    g.fillStyle = `hsla(${r() * 360}, 70%, 50%, 0.5)`;
    g.beginPath();
    g.arc(r() * 512, r() * 384, 10 + r() * 60, 0, 2 * Math.PI);
    g.fill();
  }
  return c.transferToImageBitmap();
});

// Axis-aligned box of the (possibly rotated) element plus half its stroke width.
export function bbox(el: El) {
  const c = Math.abs(Math.cos(el.rotation)), s = Math.abs(Math.sin(el.rotation));
  const hx = (el.w * c + el.h * s) / 2 + el.style.strokeWidth / 2;
  const hy = (el.w * s + el.h * c) / 2 + el.style.strokeWidth / 2;
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
  return { minX: cx - hx, minY: cy - hy, maxX: cx + hx, maxY: cy + hy };
}

export function makeScene(n: number, seed: number, world: Rect): El[] {
  const r = rng(seed), k = n / 5000;
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const between = (lo: number, hi: number) => lo + r() * (hi - lo);
  const pick = (a: any) => a[Math.floor(r() * a.length)];

  const types: El['type'][] = [];
  for (const [type, count] of Object.entries(MIX)) for (let i = 0; i < count * k; i++) types.push(type as El['type']);
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [types[i], types[j]] = [types[j], types[i]];
  }

  let shapes = 0, texts = 0;
  const els = types.map((type, i): El => {
    const el: El = {
      id: `s${seed}-${i}`, type, x: 0, y: 0, w: 0, h: 0, rotation: 0, z: i, v: 1,
      style: { stroke: pick(INK), fill: null, strokeWidth: int(1, 3) }, data: {},
    };
    if (type === 'shape') {
      el.w = between(10, 60);
      el.h = between(10, 60);
      el.data = { kind: pick(['rect', 'ellipse', 'diamond', 'triangle']) };
      if (r() < 0.5) el.style.fill = pick(FILL);
      if (shapes++ % 4 === 0) el.rotation = between(0.1, 2 * Math.PI - 0.1); // exactly 25% rotated
    } else if (type === 'line') {
      el.w = between(12, 80);
      el.h = between(12, 80);
      el.data = { flip: r() < 0.5, arrow: r() < 0.5 };
    } else if (type === 'text') {
      const arabic = texts++ % 5 < 2; // exactly 40% Arabic
      const word = () =>
        arabic
          ? Array.from({ length: int(3, 6) }, () => pick(ARABIC_LETTERS)).join('')
          : Array.from({ length: int(2, 3) }, () => pick(SYLLABLES)).join('');
      const text = Array.from({ length: int(1, 3) }, word).join(' ');
      const size = int(12, 32);
      el.data = { text, size, dir: arabic ? 'rtl' : 'ltr' };
      el.w = widthOf(text, `${size}px sans-serif`);
      el.h = size * 1.25;
    } else if (type === 'math') {
      const src = int(0, 7), s = between(0.15, 0.35);
      el.data = { src };
      el.w = MATH[src].width * s;
      el.h = MATH[src].height * s;
    } else if (type === 'image') {
      el.data = { blob: int(0, 2) };
      el.w = between(30, 110);
      el.h = el.w * 0.75;
    } else {
      const size = between(2, 8), pts: number[][] = [];
      let x = 0, y = 0, a = r() * 2 * Math.PI;
      for (let j = int(40, 200); j > 0; j--) {
        a += (r() - 0.5) * 0.6;
        x += 2 * Math.cos(a);
        y += 2 * Math.sin(a);
        pts.push([x, y, 0.5 + 0.3 * Math.sin(j / 7)]);
      }
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const x0 = Math.min(...xs) - size, y0 = Math.min(...ys) - size;
      el.data = { size, points: pts.map(([px, py, p]) => [round2(px - x0), round2(py - y0), round2(p)]) };
      el.w = Math.max(...xs) - x0 + size;
      el.h = Math.max(...ys) - y0 + size;
    }
    // Place the centre so the whole bounding box lies inside the world rect.
    const b = bbox(el), hx = (b.maxX - b.minX) / 2, hy = (b.maxY - b.minY) / 2;
    el.x = between(world.x + hx, world.x + world.w - hx) - el.w / 2;
    el.y = between(world.y + hy, world.y + world.h - hy) - el.h / 2;
    return el;
  });

  const count = (f: (e: El) => boolean) => els.filter(f).length;
  for (const [type, c] of Object.entries(MIX)) console.assert(count((e) => e.type === type) === c * k, `makeScene(${n}): ${type} count`);
  console.assert(count((e) => e.type === 'shape' && e.rotation !== 0) === MIX.shape * k * 0.25, `makeScene(${n}): 25% of shapes rotated`);
  console.assert(count((e) => e.type === 'text' && e.data.dir === 'rtl') === MIX.text * k * 0.4, `makeScene(${n}): 40% of text Arabic`);
  return els;
}

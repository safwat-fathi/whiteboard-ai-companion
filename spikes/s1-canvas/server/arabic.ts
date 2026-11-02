import { createCanvas, getTextRenderer } from '@napi-rs/canvas';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerFonts } from './fonts.ts';

type Fixture = { id: number; kind: string; text: string };
const fixtures: Fixture[] = JSON.parse(readFileSync(new URL('../fixtures/arabic.json', import.meta.url), 'utf8'));
const outDir = fileURLToPath(new URL('../out/', import.meta.url));
mkdirSync(outDir, { recursive: true });

// Drawing geometry; web/arabic.html uses the same numbers.
const SIZE = 40, W = 1000, PAD = 24, GUTTER = 130, ROW = 92, BASE = 62, LINE = 64;
// Same font or no shaping gives widths that are exactly equal; real differences seen are >= 0.25 px (a 1 px floor wrongly failed
// genuine 0.6 px shaping effects and 0.25 px coincidences between two different fonts). So "differs" means at least 0.1 px apart.
const MIN_DELTA = 0.1;
const GHOST = 'NoSuchFamilyS1'; // not installed anywhere, so measuring it gives the system fallback

const fams = registerFonts();
const probe = createCanvas(10, 10).getContext('2d');
probe.direction = 'rtl';
const width = (font: string, text: string) => ((probe.font = font), probe.measureText(text).width);
const stack = (fam: string) => `${SIZE}px ${fam}, ${fam}-Latin`; // bundled families only, no system names

// Arabic words that can join: a letter that connects forward followed by one that accepts a connection.
const DUAL = 'ئبتثجحخسشصضطظعغفقكلمنهىي';
const RIGHT = 'آأؤإاةدذرزو';
const clusters = (w: string) => w.match(/\P{M}\p{M}*/gu) ?? []; // letter + its harakat: a ZWNJ must not detach a mark
const hasJoin = (cs: string[]) => cs.some((c, i) => i + 1 < cs.length && DUAL.includes(c[0]) && (DUAL + RIGHT).includes(cs[i + 1][0]));
const words = fixtures.flatMap((f) => f.text.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{M}]/gu, ''))).filter(Boolean);
const arabic = words.filter((t) => /^[\p{Script=Arabic}\p{M}]+$/u.test(t));
const joinable = arabic.filter((t) => hasJoin(clusters(t)));
const latin = words.filter((t) => /^[A-Za-z]{2,}$/.test(t));

const failures: string[] = [];
const min = () => ({ d: Infinity, w: '' });

for (const [name, fam] of Object.entries(fams)) {
  const m = { zwnj: min(), isolated: min(), ghost: min(), latin: min() };
  const note = (k: keyof typeof m, w: string, a: number, b: number) => {
    const d = Math.abs(a - b);
    if (d < m[k].d) m[k] = { d, w };
    if (d < MIN_DELTA) failures.push(`${name} ${k} "${w}": ${a.toFixed(2)} vs ${b.toFixed(2)}`);
  };
  const f = `${SIZE}px ${fam}`;
  for (const w of joinable) {
    const cs = clusters(w);
    const joined = width(f, w);
    note('zwnj', w, joined, width(f, cs.join('‌'))); // joining happens
    note('isolated', w, joined, cs.reduce((s, c) => s + width(f, c), 0)); // same, without relying on ZWNJ having a glyph
    note('ghost', w, joined, width(`${SIZE}px ${GHOST}`, w)); // the registered font is drawn, not a system fallback
  }
  for (const t of latin) note('latin', t, width(stack(fam), t), width(`${SIZE}px ${GHOST}`, t));
  const r = (k: keyof typeof m) => `${m[k].d.toFixed(2)} (${m[k].w})`;
  console.log(`${name}: ${joinable.length} joinable Arabic words (${arabic.length - joinable.length} with no joinable pair skipped), ${latin.length} Latin words`);
  console.log(`  min |joined - zwnj| ${r('zwnj')}, |joined - isolated sum| ${r('isolated')}, |bundled - nonexistent family| ${r('ghost')}, latin ${r('latin')}`);
}

function wrap(text: string, font: string, maxW: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && width(font, next) > maxW) (lines.push(line), (line = word));
    else line = next;
  }
  return [...lines, line];
}

for (const [name, fam] of Object.entries(fams)) {
  const font = stack(fam);
  const rows = fixtures.map((f) => (f.kind === 'paragraph' ? wrap(f.text, font, W - PAD - GUTTER) : [f.text]));
  const heights = rows.map((r) => (r.length > 1 ? r.length * LINE + 30 : ROW));
  const canvas = createCanvas(W, heights.reduce((a, b) => a + b, 0));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = 0;
  fixtures.forEach((f, i) => {
    ctx.fillStyle = '#888';
    ctx.font = `14px ${fam}-Latin`;
    ctx.direction = 'ltr';
    ctx.textAlign = 'left';
    ctx.fillText(`${String(f.id).padStart(2, '0')} ${f.kind}`, PAD, y + BASE);
    ctx.fillStyle = '#000';
    ctx.font = font;
    ctx.direction = 'rtl';
    ctx.textAlign = 'right';
    rows[i].forEach((line, j) => ctx.fillText(line, W - PAD, y + BASE + j * LINE));
    y += heights[i];
    ctx.fillStyle = '#ddd';
    ctx.fillRect(0, y - 1, W, 1);
  });
  writeFileSync(`${outDir}arabic-${name}.png`, canvas.toBuffer('image/png'));
  console.log(`wrote out/arabic-${name}.png ${canvas.width}x${canvas.height}; line widths @${SIZE}px, ids 1..${fixtures.length}: ${fixtures.map((f, i) => (f.kind === 'paragraph' ? rows[i].length + ' lines' : width(font, f.text).toFixed(2))).join(' ')}`);
}

console.log(`text renderer: ${getTextRenderer()}`);
if (failures.length) {
  console.error(`FAIL: ${failures.length} assertion(s)\n  ${failures.join('\n  ')}`);
  process.exitCode = 1;
} else console.log('PASS: every assertion held for both fonts');

import { convertSVGTextToPath, createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mathjax } from '@mathjax/src/js/mathjax.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { SVG } from '@mathjax/src/js/output/svg.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import '@mathjax/src/js/util/asyncLoad/esm.js';
// Exactly the allowlist in docs/plans/math-renderer.md "Security configuration": no html, require, unicode or newcommand.
import '@mathjax/src/js/input/tex/base/BaseConfiguration.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';
import '@mathjax/src/js/input/tex/cancel/CancelConfiguration.js';
import '@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js';
import '@mathjax/src/js/input/tex/mhchem/MhchemConfiguration.js';
import '@mathjax/src/js/input/tex/noundefined/NoUndefinedConfiguration.js';
// Not loaded by the mhchem TeX package in the direct API: without it \ce arrows are missing-glyph boxes and MathJax warns "Invalid variant: -mhchem".
import { MathJaxMhchemFontExtension } from '@mathjax/mathjax-mhchem-font-extension/js/svg.js';
import { registerFonts } from './fonts.ts';

type Eq = { id: number; cat: string; latex: string };
const eqs: Eq[] = JSON.parse(readFileSync(new URL('../fixtures/equations.json', import.meta.url), 'utf8'));
const outDir = fileURLToPath(new URL('../out/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const fams = registerFonts();
const STACK = `${fams.naskh}, ${fams.naskh}-Latin`; // best effort for \text{} Arabic: the bundled families
const GHOST = 'NoSuchFamilyS1';

const failures: string[] = [];
const warnings: string[] = [];
console.warn = (...a: unknown[]) => void warnings.push(a.join(' ')); // MathJax reports font and variant problems by warning, not by throwing

const EM = 16, EX = 8; // MathJax's own defaults; they only steer layout decisions, the output is in 1000 units per em
const adaptor = liteAdaptor({ fontSize: EM });
RegisterHTMLHandler(adaptor);
const svgJax = new SVG({ fontCache: 'none' }); // explicit paths, so each SVG is self-contained and rasterises without <use>
svgJax.addExtension(MathJaxMhchemFontExtension);
const html = mathjax.document('', {
  InputJax: new TeX({
    packages: ['base', 'ams', 'boldsymbol', 'cancel', 'mathtools', 'mhchem', 'noundefined'],
    maxMacros: 1000, // the defaults, pinned
    maxBuffer: 5 * 1024,
    formatError: (_jax: unknown, err: Error) => {
      throw err; // never render an error as a "successful" SVG
    },
  }),
  OutputJax: svgJax,
});

async function toSvg(latex: string) {
  if (latex.length > 4000) throw new Error('input over the 4,000 character limit');
  const node = await html.convertPromise(latex, { display: true, em: EM, ex: EX, containerWidth: 80 * EM });
  return adaptor.serializeXML(adaptor.tags(node, 'svg')[0]) as string;
}

// `noundefined` turns an unknown macro into red text of width > 0 instead of an error. \notamacro shows what marks it.
const UNDEFINED = 'fill="red"';
if (!(await toSvg('\\notamacro')).includes(UNDEFINED)) failures.push(`cannot detect undefined macros: \\notamacro has no ${UNDEFINED}`);

const meta = (svg: string) => {
  const r = svg.match(/^<svg[^>]*>/)![0];
  const [, , vw, vh] = r.match(/viewBox="([^"]+)"/)![1].split(/\s+/).map(Number);
  return { vw, vh, wEx: parseFloat(r.match(/ width="([\d.]+)ex"/)![1]) };
};
// Skia resolves `ex` from an installed default font (README), so rewrite the root size to px: 1000 viewBox units = 1 em.
const sized = (svg: string, w: number, h: number) =>
  svg
    .replace(/^<svg[^>]*>/, (t) => t.replace(/ width="[^"]*"/, ` width="${w}"`).replace(/ height="[^"]*"/, ` height="${h}"`))
    .replaceAll('currentColor', '#000');
const withFamily = (svg: string, fam: string) => svg.replace(/font-family="[^"]*"/g, `font-family="${fam}"`);

const EMPX = 40; // raster px per em
const COLS = 5, CW = 380, CH = 190;
const sheet = createCanvas(COLS * CW, Math.ceil(eqs.length / COLS) * CH);
const sg = sheet.getContext('2d');
sg.fillStyle = '#fff';
sg.fillRect(0, 0, sheet.width, sheet.height);

const svgs = new Map<number, string>();
for (const [i, eq] of eqs.entries()) {
  const cx = (i % COLS) * CW, cy = Math.floor(i / COLS) * CH;
  sg.strokeStyle = '#ddd';
  sg.strokeRect(cx + 0.5, cy + 0.5, CW - 1, CH - 1);
  sg.fillStyle = '#888';
  sg.font = `12px ${fams.naskh}-Latin`;
  sg.fillText(`${String(eq.id).padStart(2, '0')} ${eq.cat}`, cx + 8, cy + 16);
  try {
    const svg = await toSvg(eq.latex);
    svgs.set(eq.id, svg);
    if (svg.includes(UNDEFINED)) throw new Error('rendered an undefined macro (red text)');
    const { vw, vh } = meta(svg);
    const wPx = (vw / 1000) * EMPX, hPx = (vh / 1000) * EMPX;
    const s = Math.min(1, (CW - 24) / wPx, (CH - 44) / hPx);
    const [w, h] = [wPx * s, hPx * s];
    const img = await loadImage(Buffer.from(sized(withFamily(svg, STACK), w, h)));
    if (!(img.width > 0 && img.height > 0)) throw new Error(`rasterised to ${img.width}x${img.height}`);
    sg.drawImage(img, cx + (CW - w) / 2, cy + 28 + (CH - 28 - h) / 2, w, h);
  } catch (e) {
    failures.push(`#${eq.id} ${eq.cat}: ${(e as Error).message}`);
    sg.fillStyle = '#c00';
    sg.fillText(`ERROR ${(e as Error).message}`.slice(0, 60), cx + 8, cy + 60);
  }
}
writeFileSync(`${outDir}math-contact.png`, sheet.toBuffer('image/png'));
console.log(`wrote out/math-contact.png ${sheet.width}x${sheet.height} (${svgs.size}/${eqs.length} rendered)`);

const withText = [...svgs].filter(([, s]) => /<text[ >]/.test(s)).map(([id]) => id);
console.log(`SVGs containing <text: ${withText.length ? withText.join(', ') : 'none'}`);
if (svgs.size) {
  const m = meta([...svgs.values()][0]);
  const skiaEx = (await loadImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1000ex" height="1000ex"/>'))).width / 1000;
  console.log(`ex: MathJax 1ex = ${(m.vw / 1000 / m.wEx).toFixed(4)} em (viewBox width / width in ex, the same for every SVG) = ${((m.vw / 1000 / m.wEx) * EM).toFixed(2)} px at ${EM} px/em; Skia resolves 1ex to ${skiaEx.toFixed(3)} px from an installed font, so root sizes are rewritten to px from the viewBox`);
}

// Arabic inside \text{}: MathJax emits <text font-family="serif">. Rasterise it four ways and compare with canvas fillText.
const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i + 3] !== b[i + 3] || a[i] !== b[i]) n++;
  return n;
};
const variants = [
  ['as emitted (serif)', 'serif', false],
  ['registered family', STACK, false],
  ['nonexistent family', GHOST, false],
  ['registered + convertSVGTextToPath', STACK, true],
] as const;
const tiles = eqs
  .filter((e) => e.cat === 'text-arabic' && svgs.has(e.id))
  .map((e) => {
    const svg = svgs.get(e.id)!;
    const { vw, vh } = meta(svg);
    const w = Math.min(1000, (vw / 1000) * EMPX);
    return { id: e.id, svg, w, h: (vh / vw) * w };
  });
const cmp = createCanvas(1100, tiles.reduce((a, t) => a + variants.length * (t.h + 34) + 70, 6));
const cg = cmp.getContext('2d');
cg.fillStyle = '#fff';
cg.fillRect(0, 0, cmp.width, cmp.height);
let y = 6;
for (const { id, svg, w, h } of tiles) {
  const px: Uint8ClampedArray[] = [];
  for (const [label, fam, toPath] of variants) {
    const s = sized(withFamily(svg, fam), w, h);
    const img = await loadImage(toPath ? convertSVGTextToPath(s) : Buffer.from(s));
    const c = createCanvas(Math.ceil(w), Math.ceil(h));
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    px.push(c.getContext('2d').getImageData(0, 0, c.width, c.height).data);
    cg.fillStyle = '#888';
    cg.font = `12px ${fams.naskh}-Latin`;
    cg.fillText(`#${id} ${label}`, 8, y + 12);
    cg.drawImage(img, 8, y + 18, w, h);
    y += h + 34;
  }
  const words = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((t) => t[1]);
  cg.fillStyle = '#888';
  cg.fillText(`#${id} reference: the same words drawn by canvas fillText (direction rtl)`, 8, y + 12);
  cg.fillStyle = '#000';
  cg.font = `40px ${STACK}`;
  cg.direction = 'rtl';
  cg.textAlign = 'right';
  cg.fillText(words.join(' '), cmp.width - 20, y + 60);
  cg.direction = 'ltr';
  cg.textAlign = 'left';
  y += 70;
  console.log(`#${id} pixels differing: registered vs nonexistent family ${diff(px[1], px[2])}, registered vs as emitted ${diff(px[1], px[0])}, registered vs registered+convertSVGTextToPath ${diff(px[1], px[3])} of ${px[1].length / 4}`);
  for (const t of svg.matchAll(/<text[^>]*font-size="([\d.]+)px"[^>]*>([^<]*)<\/text>/g)) {
    const cc = createCanvas(10, 10).getContext('2d');
    cc.font = `${t[1]}px ${STACK}`;
    const iso = [...t[2]].reduce((s, ch) => s + cc.measureText(ch).width, 0);
    console.log(`#${id} <text> "${t[2]}": ${[...t[2]].length} chars; MathJax reserves ${[...t[2]].length * 600} units (0.6 em per char); correctly shaped it is ${cc.measureText(t[2]).width.toFixed(0)} units, as unjoined isolated forms ${iso.toFixed(0)}`);
  }
}
writeFileSync(`${outDir}math-arabic-compare.png`, cmp.toBuffer('image/png'));
console.log('wrote out/math-arabic-compare.png');

failures.push(...warnings.map((w) => `MathJax warning: ${w}`));
if (failures.length) {
  console.error(`FAIL: ${failures.length} problem(s)\n  ${failures.join('\n  ')}`);
  process.exitCode = 1;
} else console.log(`PASS: ${eqs.length} equations rendered, no throw, width and height > 0, none carries the undefined-macro mark, no MathJax warning`);

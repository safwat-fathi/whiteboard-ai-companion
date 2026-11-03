// S2 R2/R3/R4 on ~10 sampled pages per book. Usage: tsx --env-file=../../.env ocr.ts <bookIdx 0-3> <r2|r3|r4>
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CEILING = 1.0; // USD for all of S2's paid calls
const VISION = process.env.VISION_MODEL ?? 'google/gemini-3.8-flash';
const CARRIER = 'anthropic/claude-haiku-5.5'; // chat model that "reads" the parsed PDF; we discard its answer
const books = new URL('../books/', import.meta.url).pathname;
const out = new URL('./out/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const names = readdirSync(books).filter((n) => n.endsWith('.pdf')).sort();
const [bi, rung] = [Number(process.argv[2]), process.argv[3]];
const file = names[bi];
const tag = ['alg1', 'alg2', 'ck12', 'arabic'].find((_, i) => i === bi) ?? `b${bi}`;
console.log(bi, file, rung);

const spendFile = join(out, 'spend.json');
const spend = () => (existsSync(spendFile) ? JSON.parse(readFileSync(spendFile, 'utf8')).total : 0);
const addSpend = (c: number) => writeFileSync(spendFile, JSON.stringify({ total: spend() + c }));

const src = join(books, file);
const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [src]).toString())![1]);
// 10 evenly spaced pages from 12%..90% of the book (skips front matter)
const lo = Math.max(1, Math.floor(pages * 0.12)), hi = Math.floor(pages * 0.9);
const sample = Array.from(new Set(Array.from({ length: 10 }, (_, i) => Math.round(lo + ((hi - lo) * i) / 9))));
console.log('pages', pages, 'sample', sample.join(','));

const dir = join(out, tag);
mkdirSync(dir, { recursive: true });
const slice = join(dir, process.env.SLICE ?? 'slice.pdf');
if (!existsSync(join(dir, 'slice.pdf'))) {
  const parts = sample.map((p) => join(dir, `p${p}.pdf`));
  sample.forEach((p, i) => execFileSync('pdfseparate', ['-f', String(p), '-l', String(p), src, parts[i]]));
  execFileSync('pdfunite', [...parts, slice]);
  for (const p of sample) execFileSync('pdftoppm', ['-r', '130', '-png', '-singlefile', '-f', String(p), '-l', String(p), src, join(dir, `p${p}`)]);
}

const isMeta = process.env.PROVIDER === 'meta';

async function chat(body: object) {
  if (!isMeta && spend() > CEILING) throw new Error(`spend ceiling ${CEILING} hit`);
  const t0 = performance.now();
  const url = isMeta ? `${process.env.META_API_BASE_URL}/chat/completions` : 'https://openrouter.ai/api/v1/chat/completions';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${isMeta ? (process.env.MODEL_API_KEY || process.env.META_API_KEY) : process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (!isMeta) headers['X-Title'] = 'whiteboard-ai-s2';

  const reqBody = isMeta ? body : { ...body, usage: { include: true }, provider: { data_collection: 'deny' } };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(reqBody),
  });
  const json: any = await res.json();
  const cost = isMeta ? 0 : (json.usage?.cost ?? 0);
  if (!isMeta) addSpend(cost);
  return { json, cost, ms: Math.round(performance.now() - t0), status: res.status };
}

if (rung === 'r2' || rung === 'r3') {
  const engine = rung === 'r2' ? 'cloudflare-ai' : 'mistral-ocr';
  const b64 = readFileSync(slice).toString('base64');
  const r = await chat({
    model: CARRIER, max_tokens: 8,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK.' }, { type: 'file', file: { filename: 'slice.pdf', file_data: `data:application/pdf;base64,${b64}` } }] }],
    plugins: [{ id: 'file-parser', pdf: { engine } }],
  });
  writeFileSync(join(dir, `${rung}${process.env.SLICE ? '.3p' : ''}.raw.json`), JSON.stringify(r.json, null, 1));
  const ann = r.json.choices?.[0]?.message?.annotations;
  console.log({ status: r.status, ms: r.ms, cost: r.cost, annotations: ann?.length, error: r.json.error, keys: ann?.[0] && Object.keys(ann[0]), fileKeys: ann?.[0]?.file && Object.keys(ann[0].file) });
  console.log('usage', r.json.usage);
}

if (rung === 'r4') {
  let totalCost = 0, totalToks = { in: 0, out: 0 }, ms = 0, md = '';
  for (const p of sample) {
    const img = readFileSync(join(dir, `p${p}.png`)).toString('base64');
    const r = await chat({
      model: VISION, max_tokens: 4000,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Transcribe this textbook page to Markdown. Math as LaTeX ($...$ inline, $$...$$ display). Keep Arabic text exactly as printed (right-to-left, no translation). Keep headings, lists, tables. Output only the transcription; do not invent text that is not on the page; mark illegible parts as [illegible].' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } }] }],
    });
    ms += r.ms;
    if (isMeta) {
      const u = r.json.usage;
      const inTok = u?.prompt_tokens ?? 0;
      const outTok = u?.completion_tokens ?? 0;
      totalToks.in += inTok;
      totalToks.out += outTok;
      console.log('p', p, r.status, r.ms, 'ms', `tokens=${inTok}in/${outTok}out`);
    } else {
      totalCost += r.cost;
      console.log('p', p, r.status, r.ms, 'ms', r.cost);
    }
    md += `\n\n<!-- page ${p} -->\n${r.json.choices?.[0]?.message?.content ?? JSON.stringify(r.json.error)}`;
  }
  const outName = isMeta ? `r4.${VISION.replace('/', '_')}.md` : 'r4.md';
  writeFileSync(join(dir, outName), md);
  if (isMeta) {
    console.log({ model: VISION, pages: sample.length, totalTokens: totalToks, msPerPage: Math.round(ms / sample.length) });
  } else {
    console.log({ model: VISION, pages: sample.length, totalCost, msPerPage: Math.round(ms / sample.length) });
  }
}
if (!isMeta) console.log('total spend', spend());

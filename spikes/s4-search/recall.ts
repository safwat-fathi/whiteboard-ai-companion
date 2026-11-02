// S4b embeddings & hybrid retrieval recall on real books (ck12, alg1, arabic).
// Usage: pnpm --filter s4-search recall (or tsx recall.ts --bm25-only for offline check)
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { topK } from './topk.ts';

const CEILING = 0.5; // USD ceiling for S4b embeddings
const MODELS = ['baai/bge-m3', 'qwen/qwen3-embedding-8b', 'openai/text-embedding-3-small'] as const;
const BOOKS: { tag: string; pageCount: number }[] = [
  { tag: 'ck12', pageCount: 652 },
  { tag: 'alg1', pageCount: 700 },
  { tag: 'arabic', pageCount: 383 },
];

const rootDir = new URL('../../', import.meta.url).pathname;
const s2Out = join(rootDir, 'spikes/s2-ingestion/out');
const evalDir = join(rootDir, 'eval');
const dataDir = new URL('./data/', import.meta.url).pathname;
mkdirSync(dataDir, { recursive: true });

const spendFile = join(dataDir, 'spend.json');
const getSpend = (): number => (existsSync(spendFile) ? JSON.parse(readFileSync(spendFile, 'utf8')).total : 0);
const addSpend = (c: number) => writeFileSync(spendFile, JSON.stringify({ total: getSpend() + c }));

// Arabic & Latin normalisation from docs/plans/library-ingestion.md
export function normaliseText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\u0640\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase();
}

function ftsQuery(q: string): string {
  const toks = normaliseText(q)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  return toks.map((t) => `"${t}"`).join(' OR ');
}

type PageRow = { pageIndex: number; label: string | null; text: string; rung: string };
type Chunk = { id: number; pageFrom: number; pageTo: number; text: string; textNorm: string };
type EvalItem = { q: string; pages: number[]; numbering?: 'printed' | 'file' };

async function ensureArabicPages(): Promise<void> {
  const arDir = join(s2Out, 'arabic');
  const target = join(arDir, 'pages.jsonl');
  if (existsSync(target)) {
    const count = readFileSync(target, 'utf8').trim().split('\n').filter(Boolean).length;
    if (count >= 40) return;
  }
  const slices: { raw: string; pdf: string; pages: number[] }[] = [
    { raw: 'r3.raw.json', pdf: 'slice.pdf', pages: [45, 78, 111, 145, 178, 211, 244, 278, 311, 344] },
    { raw: 'slice_d1.raw.json', pdf: 'slice_d1.pdf', pages: [15, 25, 35, 55, 65, 90, 100, 125, 135, 160] },
    { raw: 'slice_d2.raw.json', pdf: 'slice_d2.pdf', pages: [170, 190, 200, 225, 235, 255, 265, 290, 300, 325] },
    { raw: 'slice_d3.raw.json', pdf: 'slice_d3.pdf', pages: [335, 355, 365, 375, 20, 60, 95, 155, 220, 295] },
  ];
  const rows: PageRow[] = [];
  for (const s of slices) {
    const rawPath = join(arDir, s.raw);
    if (!existsSync(rawPath)) {
      if (process.argv.includes('--bm25-only')) continue;
      const b64 = readFileSync(join(arDir, s.pdf)).toString('base64');
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Title': 'whiteboard-ai-s4b',
        },
        body: JSON.stringify({
          model: 'anthropic/claude-haiku-5.5',
          max_tokens: 8,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Reply OK.' },
                { type: 'file', file: { filename: s.pdf, file_data: `data:application/pdf;base64,${b64}` } },
              ],
            },
          ],
          plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
          usage: { include: true },
          provider: { data_collection: 'deny' },
        }),
      });
      const json: any = await res.json();
      if (!res.ok || json.error) throw new Error(`mistral-ocr failed on ${s.pdf}: ${JSON.stringify(json.error ?? res.status)}`);
      writeFileSync(rawPath, JSON.stringify(json, null, 1));
      console.log(`OCR ${s.pdf}: cost=$${(json.usage?.cost ?? 0).toFixed(4)}`);
    }
    const json = JSON.parse(readFileSync(rawPath, 'utf8'));
    const content: any[] = json.choices?.[0]?.message?.annotations?.[0]?.file?.content ?? [];
    const texts = content.filter((c) => c.type === 'text').slice(1, -1);
    if (texts.length !== s.pages.length) {
      throw new Error(`Expected ${s.pages.length} page texts in ${s.raw}, got ${texts.length}`);
    }
    for (let i = 0; i < s.pages.length; i++) {
      rows.push({ pageIndex: s.pages[i], label: null, text: texts[i].text.trim(), rung: 'R3' });
    }
  }
  rows.sort((a, b) => a.pageIndex - b.pageIndex);
  writeFileSync(target, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// Step 1: 400-800-token windows (~1600-3200 chars, target 2200 chars) with ~12% overlap (260 chars).
// Strip PDF control chars (\x00-\x1F) and PUA glyphs (\uE000-\uF8FF) emitted by pdfjs-dist on math fonts.
function chunkPages(pages: PageRow[]): Chunk[] {
  const TARGET = 2200;
  const OVERLAP = 260;
  const chunks: Chunk[] = [];
  for (const p of pages) {
    const t = p.text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uE000-\uF8FF]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (t.length <= TARGET) {
      chunks.push({ id: chunks.length, pageFrom: p.pageIndex, pageTo: p.pageIndex, text: t, textNorm: normaliseText(t) });
    } else {
      let start = 0;
      while (start < t.length) {
        const slice = t.slice(start, start + TARGET);
        chunks.push({ id: chunks.length, pageFrom: p.pageIndex, pageTo: p.pageIndex, text: slice, textNorm: normaliseText(slice) });
        if (start + TARGET >= t.length) break;
        start += TARGET - OVERLAP;
      }
    }
  }
  return chunks;
}

// Step 2: Normalise eval pages (printed labels -> 1-based file pageIndex via getPageLabels) and assert in [1, pageCount].
function loadEval(tag: string, pages: PageRow[], pageCount: number): { q: string; pages: number[] }[] {
  const labelMap = new Map<string, number>();
  for (const p of pages) if (p.label) labelMap.set(String(p.label), p.pageIndex);
  const raw = readFileSync(join(evalDir, `${tag}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as EvalItem);
  if (raw.length < 10) throw new Error(`${tag}: expected >= 10 eval questions, got ${raw.length}`);
  return raw.map((item, idx) => {
    const normPages = item.pages.map((p) => {
      const fileIdx = item.numbering === 'printed' ? labelMap.get(String(p)) : p;
      if (typeof fileIdx !== 'number' || !Number.isInteger(fileIdx) || fileIdx < 1 || fileIdx > pageCount) {
        throw new Error(`${tag} q[${idx}] invalid or unmapped page ${p} (numbering=${item.numbering ?? 'file'}) -> ${fileIdx}`);
      }
      return fileIdx;
    });
    return { q: item.q, pages: normPages };
  });
}

async function embedTexts(
  model: string,
  cacheKey: string,
  texts: string[]
): Promise<{ vectors: Float32Array; dims: number; cost: number; ms: number; retries: number; denyFallback: boolean }> {
  const cacheFile = join(dataDir, `emb-${model.replace(/\W+/g, '_')}-${cacheKey}.json`);
  let all: number[][] = [];
  let dims = 0;
  let cost = 0;
  let retries = 0;
  let denyFallback = false;
  let prevMs = 0;
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (cached.count === texts.length && Array.isArray(cached.flat) && cached.flat.length === texts.length * cached.dims) {
      return {
        vectors: new Float32Array(cached.flat),
        dims: cached.dims,
        cost: cached.cost,
        ms: cached.ms,
        retries: cached.retries ?? 0,
        denyFallback: cached.denyFallback ?? false,
      };
    }
    if (cached.totalTarget === texts.length && Array.isArray(cached.rows)) {
      all = cached.rows;
      dims = cached.dims ?? 0;
      cost = cached.cost ?? 0;
      retries = cached.retries ?? 0;
      denyFallback = cached.denyFallback ?? false;
      prevMs = cached.ms ?? 0;
    }
  }
  const BATCH = 64;
  const t0 = performance.now();
  for (let i = all.length; i < texts.length; i += BATCH) {
    if (getSpend() > CEILING) throw new Error(`S4b spend ceiling $${CEILING} exceeded ($${getSpend().toFixed(4)})`);
    const batch = texts.slice(i, i + BATCH);
    let json: any;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const useDeny = attempt <= 2 && !denyFallback;
      if (!useDeny && !denyFallback) {
        denyFallback = true;
        console.warn(`Note: ${model} falling back without data_collection:deny after 429s`);
      }
      const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Title': 'whiteboard-ai-s4b',
        },
        body: JSON.stringify({
          model,
          input: batch,
          usage: { include: true },
          ...(useDeny ? { provider: { data_collection: 'deny' } } : {}),
        }),
      });
      json = await res.json();
      if (res.ok && !json.error && Array.isArray(json.data)) break;
      const code = json?.error?.code ?? res.status;
      if ((code === 429 || code >= 500) && attempt < 6) {
        retries++;
        console.warn(`Retry ${attempt}/5 on ${model} (${cacheKey} +${i}, deny=${useDeny}) HTTP ${code}`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      throw new Error(`Embeddings error (${model}): ${JSON.stringify(json.error ?? json)}`);
    }
    const stepCost = json.usage?.cost ?? 0;
    cost += stepCost;
    addSpend(stepCost);
    const sorted = [...json.data].sort((a: any, b: any) => a.index - b.index);
    for (const d of sorted) {
      const emb: number[] = d.embedding;
      if (!dims) dims = emb.length;
      let norm = 0;
      for (let j = 0; j < dims; j++) norm += emb[j] * emb[j];
      norm = Math.sqrt(norm) || 1;
      all.push(emb.map((v) => v / norm));
    }
    writeFileSync(
      cacheFile,
      JSON.stringify({ totalTarget: texts.length, dims, cost, ms: prevMs + Math.round(performance.now() - t0), retries, denyFallback, rows: all })
    );
  }
  const ms = prevMs + Math.round(performance.now() - t0);
  const flat = all.flat();
  writeFileSync(cacheFile, JSON.stringify({ count: texts.length, dims, cost, ms, retries, denyFallback, flat }));
  return { vectors: new Float32Array(flat), dims, cost, ms, retries, denyFallback };
}

function scoreRanking(rankedChunkIds: number[], chunks: Chunk[], expectedPages: number[], k: number, neighbors = false): { hit: number; rr: number } {
  const exp = new Set(expectedPages);
  const top = rankedChunkIds.slice(0, k);
  for (let r = 0; r < top.length; r++) {
    const id = top[r];
    const lo = neighbors ? Math.max(0, id - 1) : id;
    const hi = neighbors ? Math.min(chunks.length - 1, id + 1) : id;
    for (let c = lo; c <= hi; c++) {
      for (let p = chunks[c].pageFrom; p <= chunks[c].pageTo; p++) {
        if (exp.has(p)) return { hit: 1, rr: 1 / (r + 1) };
      }
    }
  }
  return { hit: 0, rr: 0 };
}

function rrfFuse(bm25Ids: number[], vecIds: number[]): number[] {
  const scores = new Map<number, number>();
  bm25Ids.slice(0, 30).forEach((id, idx) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + idx + 1)));
  vecIds.slice(0, 30).forEach((id, idx) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + idx + 1)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

await ensureArabicPages();

const bookData = BOOKS.map((b) => {
  const pages = readFileSync(join(s2Out, b.tag, 'pages.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PageRow);
  const chunks = chunkPages(pages);
  const queries = loadEval(b.tag, pages, b.pageCount);
  const db = new Database(':memory:');
  db.exec('CREATE VIRTUAL TABLE fts USING fts5(text_norm)');
  const ins = db.prepare('INSERT INTO fts(rowid, text_norm) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const c of chunks) ins.run(c.id, c.textNorm);
  });
  tx();
  const bm25Lists = queries.map((q) => {
    const fq = ftsQuery(q.q);
    if (!fq) return [];
    return (db.prepare('SELECT rowid FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT 30').all(fq) as { rowid: number }[]).map((r) => r.rowid);
  });
  return { ...b, pages: pages.length, chunks, queries, bm25Lists };
});

for (const b of bookData) {
  for (const k of [5, 8, 12]) {
    const s = b.queries.map((q, qi) => scoreRanking(b.bm25Lists[qi], b.chunks, q.pages, k));
    const rec = s.reduce((a, x) => a + x.hit, 0) / s.length;
    const mrr = s.reduce((a, x) => a + x.rr, 0) / s.length;
    console.log(`BM25 ${b.tag} (pages=${b.pages}, chunks=${b.chunks.length}) k=${k}: recall=${(rec * 100).toFixed(1)}% mrr=${mrr.toFixed(3)}`);
  }
}

if (process.argv.includes('--bm25-only')) process.exit(0);

const summary: Record<string, any> = { books: {}, overall: {}, spendUsd: 0 };

for (const model of MODELS) {
  summary.overall[model] = {};
  const allVecScores: Record<number, { hit: number; rr: number }[]> = { 5: [], 8: [], 12: [] };
  const allHybScores: Record<number, { hit: number; rr: number }[]> = { 5: [], 8: [], 12: [] };
  const allHybNbr8: { hit: number; rr: number }[] = [];
  let modelDims = 0;
  let modelCost = 0;

  for (const b of bookData) {
    const cEmb = await embedTexts(model, `${b.tag}-chunks`, b.chunks.map((c) => c.text));
    const qEmb = await embedTexts(model, `${b.tag}-queries`, b.queries.map((q) => q.q));
    modelDims = cEmb.dims;
    modelCost += cEmb.cost + qEmb.cost;

    const vecLists = b.queries.map((_, qi) => {
      const qv = qEmb.vectors.subarray(qi * cEmb.dims, (qi + 1) * cEmb.dims);
      return topK(cEmb.vectors, cEmb.dims, qv, 30).map((r) => r.i);
    });
    const hybLists = b.queries.map((_, qi) => rrfFuse(b.bm25Lists[qi], vecLists[qi]));

    summary.books[b.tag] ??= { pages: b.pages, chunks: b.chunks.length, bm25: {}, models: {} };
    for (const k of [5, 8, 12]) {
      const bs = b.queries.map((q, qi) => scoreRanking(b.bm25Lists[qi], b.chunks, q.pages, k));
      summary.books[b.tag].bm25[k] = {
        recall: +(bs.reduce((a, x) => a + x.hit, 0) / bs.length).toFixed(3),
        mrr: +(bs.reduce((a, x) => a + x.rr, 0) / bs.length).toFixed(3),
      };
    }

    const mEntry: any = { dims: cEmb.dims, costUsd: +(cEmb.cost + qEmb.cost).toFixed(5), vector: {}, hybrid: {} };
    for (const k of [5, 8, 12]) {
      const vs = b.queries.map((q, qi) => scoreRanking(vecLists[qi], b.chunks, q.pages, k));
      const hs = b.queries.map((q, qi) => scoreRanking(hybLists[qi], b.chunks, q.pages, k));
      allVecScores[k].push(...vs);
      allHybScores[k].push(...hs);
      mEntry.vector[k] = {
        recall: +(vs.reduce((a, x) => a + x.hit, 0) / vs.length).toFixed(3),
        mrr: +(vs.reduce((a, x) => a + x.rr, 0) / vs.length).toFixed(3),
      };
      mEntry.hybrid[k] = {
        recall: +(hs.reduce((a, x) => a + x.hit, 0) / hs.length).toFixed(3),
        mrr: +(hs.reduce((a, x) => a + x.rr, 0) / hs.length).toFixed(3),
      };
    }
    const hn8 = b.queries.map((q, qi) => scoreRanking(hybLists[qi], b.chunks, q.pages, 8, true));
    allHybNbr8.push(...hn8);
    mEntry.hybridNeighbors8 = {
      recall: +(hn8.reduce((a, x) => a + x.hit, 0) / hn8.length).toFixed(3),
      mrr: +(hn8.reduce((a, x) => a + x.rr, 0) / hn8.length).toFixed(3),
    };
    summary.books[b.tag].models[model] = mEntry;
    console.log(
      `MODEL ${model} (dims=${cEmb.dims}) book=${b.tag}: vec@8=${(mEntry.vector[8].recall * 100).toFixed(1)}% hyb@8=${(mEntry.hybrid[8].recall * 100).toFixed(1)}% (mrr=${mEntry.hybrid[8].mrr.toFixed(3)}) nbr@8=${(mEntry.hybridNeighbors8.recall * 100).toFixed(1)}%`
    );
  }

  summary.overall[model] = {
    dims: modelDims,
    costUsd: +modelCost.toFixed(5),
    vector: Object.fromEntries(
      [5, 8, 12].map((k) => [
        k,
        {
          recall: +(allVecScores[k].reduce((a, x) => a + x.hit, 0) / allVecScores[k].length).toFixed(3),
          mrr: +(allVecScores[k].reduce((a, x) => a + x.rr, 0) / allVecScores[k].length).toFixed(3),
        },
      ])
    ),
    hybrid: Object.fromEntries(
      [5, 8, 12].map((k) => [
        k,
        {
          recall: +(allHybScores[k].reduce((a, x) => a + x.hit, 0) / allHybScores[k].length).toFixed(3),
          mrr: +(allHybScores[k].reduce((a, x) => a + x.rr, 0) / allHybScores[k].length).toFixed(3),
        },
      ])
    ),
    hybridNeighbors8: {
      recall: +(allHybNbr8.reduce((a, x) => a + x.hit, 0) / allHybNbr8.length).toFixed(3),
      mrr: +(allHybNbr8.reduce((a, x) => a + x.rr, 0) / allHybNbr8.length).toFixed(3),
    },
  };
  console.log(
    `OVERALL ${model} (dims=${modelDims}, cost=$${modelCost.toFixed(4)}): vec@8=${(summary.overall[model].vector[8].recall * 100).toFixed(1)}% hyb@8=${(summary.overall[model].hybrid[8].recall * 100).toFixed(1)}% (mrr=${summary.overall[model].hybrid[8].mrr.toFixed(3)}) nbr@8=${(summary.overall[model].hybridNeighbors8.recall * 100).toFixed(1)}%`
  );
}

summary.spendUsd = +getSpend().toFixed(5);
writeFileSync(join(dataDir, 'recall-results.json'), JSON.stringify(summary, null, 2));
console.log('Total S4b spendUsd:', summary.spendUsd);


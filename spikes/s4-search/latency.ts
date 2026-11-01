import Database from 'better-sqlite3';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { topK } from './topk.ts';

const DIMS = 1024, K = 8, WARM = 5, TIMED = 50, ROW = DIMS * 4;
const MiB = 1024 * 1024;
const rss = () => process.memoryUsage().rss / MiB;
const now = () => performance.now();
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with --expose-gc (pnpm --filter s4-search latency does)');
const settle = () => { gc(); gc(); };

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// n unit-length rows, uniform in [-1,1) then normalised in place
function unitRows(n: number, dims: number, rand: () => number) {
  const v = new Float32Array(n * dims);
  for (let r = 0; r < n; r++) {
    const o = r * dims;
    let sq = 0;
    for (let j = 0; j < dims; j++) { const x = rand() * 2 - 1; v[o + j] = x; sq += x * x; }
    const inv = 1 / Math.sqrt(sq);
    for (let j = 0; j < dims; j++) v[o + j] *= inv;
  }
  return v;
}

const pct = (sorted: number[], p: number) => sorted[Math.ceil((p / 100) * sorted.length) - 1]; // nearest rank
const f = (x: number, d = 2) => x.toFixed(d);

// --- environment ---
const db0 = new Database(':memory:');
const sqliteVersion = (db0.prepare('select sqlite_version() v').get() as { v: string }).v;
const fts5 = (db0.prepare("select sqlite_compileoption_used('ENABLE_FTS5') f").get() as { f: number }).f;
db0.close();
console.log(`node ${process.version} ${process.platform}/${process.arch}; ${cpus()[0].model} x${cpus().length}; ${f(totalmem() / MiB / 1024, 1)} GiB RAM`);
console.log(`loadavg ${loadavg().map((x) => f(x)).join(' ')}; sqlite ${sqliteVersion}; ENABLE_FTS5=${fts5}`);
if (fts5 !== 1) throw new Error('FTS5 is not compiled into this better-sqlite3');

// --- correctness: topK against a full sort, a planted vector, k > n, k <= 0, dims % 4 ---
{
  const r = mulberry32(7), dims = 128, n = 3000;
  const v = unitRows(n, dims, r), q = unitRows(1, dims, r);
  const ref = Array.from({ length: n }, (_, i) => {
    let s = 0;
    for (let j = 0; j < dims; j++) s += v[i * dims + j] * q[j];
    return { i, score: s };
  }).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, K);
  const got = topK(v, dims, q, K);
  if (JSON.stringify(got.map((x) => x.i)) !== JSON.stringify(ref.map((x) => x.i))) throw new Error('topK order differs from full sort');
  if (got.some((x, i) => Math.abs(x.score - ref[i].score) > 1e-9)) throw new Error('topK score differs from full sort');
  const planted = topK(v, dims, v.subarray(1234 * dims, 1235 * dims), K);
  if (planted[0].i !== 1234 || Math.abs(planted[0].score - 1) > 1e-5) throw new Error('planted vector is not top-1 with score 1');
  if (topK(v.subarray(0, 3 * dims), dims, q, K).length !== 3) throw new Error('k > n must return n rows');
  if (topK(v, dims, q, 0).length !== 0) throw new Error('k = 0 must return nothing');
  let threw = false;
  try { topK(v.subarray(0, 130), 130, v.subarray(0, 130), K); } catch { threw = true; }
  if (!threw) throw new Error('dims % 4 != 0 must throw');
  console.log('topK self-check: PASS');
}

// --- latency ---
type Row = { n: number; p50: number; p95: number; max: number; rssDelta: number };
const rows: Row[] = [];
let big: Float32Array | null = null;
let bigQueries: Float32Array | null = null;
for (const n of [600, 10_000, 100_000]) {
  settle();
  const rss0 = rss();
  const rand = mulberry32(n);
  const vectors = unitRows(n, DIMS, rand);
  const queries = unitRows(WARM + TIMED, DIMS, rand);
  const q = (i: number) => queries.subarray(i * DIMS, (i + 1) * DIMS);
  for (let i = 0; i < WARM; i++) topK(vectors, DIMS, q(i), K);
  const ms: number[] = [];
  for (let i = WARM; i < WARM + TIMED; i++) {
    const t = now();
    topK(vectors, DIMS, q(i), K);
    ms.push(now() - t);
  }
  const rssDelta = rss() - rss0; // vectors + queries, measured after the last query
  ms.sort((a, b) => a - b);
  rows.push({ n, p50: pct(ms, 50), p95: pct(ms, 95), max: ms[ms.length - 1], rssDelta });
  console.log(`N=${n}: p50 ${f(pct(ms, 50), 3)} ms, p95 ${f(pct(ms, 95), 3)} ms, max ${f(ms[ms.length - 1], 3)} ms, rss delta ${f(rssDelta, 1)} MiB (vectors alone ${f(vectors.byteLength / MiB, 1)} MiB)`);
  if (n === 100_000) { big = vectors; bigQueries = queries; }
}

// --- cold start: 100,000 x 4 KB BLOB rows in one transaction, then load them into one Float32Array ---
const N = 100_000;
const dbPath = fileURLToPath(new URL('./data/synthetic.db', import.meta.url));
mkdirSync(fileURLToPath(new URL('./data/', import.meta.url)), { recursive: true });
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
const probe = bigQueries!.subarray(0, DIMS);
const expected = topK(big!, DIMS, probe, K);

let t = now();
const wdb = new Database(dbPath);
wdb.pragma('journal_mode = WAL');
wdb.pragma('synchronous = NORMAL');
wdb.exec('create table chunks (id integer primary key, embedding blob not null)');
const ins = wdb.prepare('insert into chunks (embedding) values (?)');
const bulk = big!;
wdb.transaction(() => {
  for (let i = 0; i < N; i++) ins.run(Buffer.from(bulk.buffer, bulk.byteOffset + i * ROW, ROW));
})();
wdb.close(); // checkpoints the WAL
const writeMs = now() - t;
const dbMiB = statSync(dbPath).size / MiB;
console.log(`wrote ${N} x ${ROW} B rows in one transaction: ${f(writeMs, 0)} ms, ${f(dbMiB, 1)} MiB on disk`);

big = null; bigQueries = null;
settle();
const rssBefore = rss();
t = now();
const rdb = new Database(dbPath, { readonly: true });
const all = new Float32Array(N * DIMS);
const bytes = new Uint8Array(all.buffer);
let off = 0;
for (const [blob] of rdb.prepare('select embedding from chunks order by id').raw().iterate() as Iterable<[Buffer]>) {
  if (blob.length !== ROW) throw new Error(`row ${off / ROW} is ${blob.length} bytes`);
  bytes.set(blob, off);
  off += ROW;
}
const loadMs = now() - t;
rdb.close();
const loadRss = rss() - rssBefore;
if (off !== bytes.length) throw new Error('loaded fewer rows than written');
const got = topK(all, DIMS, probe, K);
if (JSON.stringify(got) !== JSON.stringify(expected)) throw new Error('top-8 after DB round trip differs from the in-memory one');
console.log(`cold-start load of ${N} rows into one Float32Array: ${f(loadMs, 0)} ms, rss delta ${f(loadRss, 1)} MiB (OS page cache warm: file was just written; round trip checked against topK of the original)`);

// --- thresholds ---
const r600 = rows.find((r) => r.n === 600)!, r100k = rows.find((r) => r.n === 100_000)!;
const checks = [
  [`N=600 p95 <= 5 ms`, r600.p95 <= 5, `${f(r600.p95, 3)} ms`],
  [`N=100000 p95 <= 100 ms`, r100k.p95 <= 100, `${f(r100k.p95, 3)} ms`],
  [`N=100000 rss delta <= 512 MiB`, r100k.rssDelta <= 512, `${f(r100k.rssDelta, 1)} MiB`],
] as const;
for (const [name, ok, val] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${val}`);
const exact = checks.every(([, ok]) => ok);
console.log(`vectorSearch: ${exact ? 'exact' : 'sqlite-vec-scheduled'}`);
if (!exact) process.exitCode = 1;

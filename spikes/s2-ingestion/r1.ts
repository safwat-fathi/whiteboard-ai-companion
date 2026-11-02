// S2 R1: local pdfjs-dist extraction. Per book: outline, page labels, text density, math/blank heuristics, timing.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const dir = new URL("../books/", import.meta.url).pathname;
const out = new URL("./out/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const MATHCH = /[=+\-×÷≤≥<>^√π∑∫±≠≈]/g;
const TAGS = ["alg1", "alg2", "ck12", "arabic"];

for (const [bi, f] of readdirSync(dir)
  .filter((n) => n.endsWith(".pdf"))
  .sort()
  .entries()) {
  const tag = TAGS[bi] ?? `b${bi}`;
  const t0 = performance.now();
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(join(dir, f))),
    useSystemFonts: true,
    verbosity: 0,
  }).promise;
  const outline = await doc.getOutline();
  const labels = await doc.getPageLabels();
  const dens: number[] = [];
  const jsonl: string[] = [];
  let empty = 0,
    mathDense = 0,
    pua = 0,
    arabic = 0;
  const sample: Record<number, string> = {};
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const text = tc.items.map((i: any) => i.str).join(" ");
    dens.push(text.length);
    if (text.trim().length < 50) empty++;
    if ((text.match(MATHCH)?.length ?? 0) / Math.max(text.length, 1) > 0.04)
      mathDense++;
    pua += (text.match(/[-]/g) ?? []).length;
    arabic += (text.match(/[؀-ۿﭐ-﻿]/g) ?? []).length;
    if ([1, 50, 100, 200].includes(p)) sample[p] = text.slice(0, 600);
    if (text.trim())
      jsonl.push(
        JSON.stringify({
          pageIndex: p,
          label: labels?.[p - 1] ?? null,
          text: text.trim(),
          rung: "R1",
        }),
      );
  }
  mkdirSync(join(out, tag), { recursive: true });
  if (jsonl.length)
    writeFileSync(join(out, tag, "pages.jsonl"), jsonl.join("\n") + "\n");
  const ms = performance.now() - t0;
  const sorted = [...dens].sort((a, b) => a - b);
  const r = {
    file: f,
    pages: doc.numPages,
    ms: Math.round(ms),
    msPerPage: +(ms / doc.numPages).toFixed(1),
    outlineTop: outline?.length ?? 0,
    outlineFirst: outline?.slice(0, 5).map((o: any) => o.title) ?? [],
    labelsFirst: labels?.slice(0, 20) ?? null,
    labelsCustom: labels
      ? labels.some((l: string, i: number) => l !== String(i + 1))
      : false,
    medianChars: sorted[sorted.length >> 1],
    emptyPages: empty,
    mathDensePages: mathDense,
    privateUseChars: pua,
    arabicChars: arabic,
  };
  console.log(JSON.stringify(r, null, 1));
  writeFileSync(
    join(out, f.slice(0, 12).replace(/\W+/g, "_") + ".r1.json"),
    JSON.stringify({ ...r, sample }, null, 1),
  );
}

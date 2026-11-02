// Page-copy slicer that prunes unreferenced resources (pdfseparate keeps shared resources: 5.4 MB per ck12 page)
import { PDFDocument } from 'pdf-lib';
import { readFileSync, writeFileSync } from 'node:fs';
const [src, dst, ...pages] = process.argv.slice(2);
const a = await PDFDocument.load(readFileSync(src), { ignoreEncryption: true });
const b = await PDFDocument.create();
for (const p of await b.copyPages(a, pages.map((n) => Number(n) - 1))) b.addPage(p);
writeFileSync(dst, await b.save());

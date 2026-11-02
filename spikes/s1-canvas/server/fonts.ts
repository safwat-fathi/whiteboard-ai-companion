import { GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';

// Format that worked: woff2, straight from the @fontsource files (no TTF source needed).
const file = (pkg: string, subset: string) =>
  fileURLToPath(new URL(`../node_modules/@fontsource/${pkg}/files/${pkg}-${subset}-400-normal.woff2`, import.meta.url));

// The fontsource `arabic` subsets hold no ASCII (no Latin letters, digits or . , ( )), and two files registered under one alias do
// not merge: the first face wins. So each font's `latin` subset gets its own companion family, used as the second name in the stack.
const FONTS = [
  ['S1-Naskh', 'noto-naskh-arabic', 'arabic'],
  ['S1-Naskh-Latin', 'noto-naskh-arabic', 'latin'],
  ['S1-Plex', 'ibm-plex-sans-arabic', 'arabic'],
  ['S1-Plex-Latin', 'ibm-plex-sans-arabic', 'latin'],
] as const;

export function registerFonts(): { naskh: string; plex: string } {
  for (const [family, pkg, subset] of FONTS)
    if (!GlobalFonts.registerFromPath(file(pkg, subset), family)) throw new Error(`registerFromPath failed for ${family}`);
  const have = new Set(GlobalFonts.families.map((f) => f.family));
  for (const [family] of FONTS) if (!have.has(family)) throw new Error(`${family} is not in GlobalFonts.families`);
  return { naskh: 'S1-Naskh', plex: 'S1-Plex' };
}

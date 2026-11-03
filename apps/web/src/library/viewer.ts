/** A page number kept inside 1..pages (a whole number; 1 for junk or an empty book). */
export function clampPage(n: number, pages: number): number {
  if (!Number.isFinite(n) || pages < 1) return 1
  return Math.min(pages, Math.max(1, Math.floor(n)))
}

/** The caption under a page: the printed label first (that is what a citation says), then where it sits in the file. */
export function pageCaption(o: {
  label: string | null
  page: number
  pages: number
}): string {
  if (o.label === null) return `page ${o.page} of ${o.pages}`
  if (o.label === String(o.page)) return `p. ${o.page} of ${o.pages}`
  return `p. ${o.label} (file page ${o.page} of ${o.pages})`
}

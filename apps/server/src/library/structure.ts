import type { SectionNode } from '../db'
import type { OutlineItem } from './pdf'

export const FIXED_SECTION_PAGES = 20

const fixedSections = (numPages: number): SectionNode[] =>
  Array.from({ length: Math.ceil(numPages / FIXED_SECTION_PAGES) }, (_, i) => {
    const pageStart = i * FIXED_SECTION_PAGES + 1
    const pageEnd = Math.min(numPages, (i + 1) * FIXED_SECTION_PAGES)
    return {
      title: `Pages ${pageStart}–${pageEnd}`,
      pageStart,
      pageEnd,
      children: [],
    }
  })

const countEntries = (items: OutlineItem[]): number =>
  items.reduce((n, it) => n + 1 + countEntries(it.children), 0)

type Located = { title: string; page: number; children: OutlineItem[] }

/** Entries with a resolvable page, clamped into [lo, hi] and in page order; an entry with no page hands its children up. */
const locate = (items: OutlineItem[], lo: number, hi: number): Located[] =>
  items
    .flatMap((it): Located[] =>
      it.page === null
        ? locate(it.children, lo, hi)
        : [
            {
              title: it.title,
              page: Math.min(hi, Math.max(lo, it.page)),
              children: it.children,
            },
          ],
    )
    .sort((a, b) => a.page - b.page)

function build(items: OutlineItem[], lo: number, hi: number): SectionNode[] {
  const located = locate(items, lo, hi)
  return located.map((l, i) => {
    const next = located[i + 1]
    const end = next ? Math.max(l.page, next.page - 1) : hi
    return {
      title: l.title || `Page ${l.page}`,
      pageStart: l.page,
      pageEnd: end,
      children: build(l.children, l.page, end),
    }
  })
}

/**
 * The section tree of a book: the PDF outline when it is usable, else fixed 20-page sections. A section ends where its
 * next sibling starts (the last ends with its parent, or the book). An outline with about one entry per page is a scan
 * that was bookmarked image by image (the Arabic book: "IMG_0001", "IMG_0002", ...), so it is ignored.
 * Pages before the first entry belong to no section.
 */
export function buildSections(
  outline: OutlineItem[],
  numPages: number,
): SectionNode[] {
  const entries = countEntries(outline)
  if (entries === 0 || (entries > 30 && entries > numPages / 2))
    return fixedSections(numPages)
  const tree = build(outline, 1, numPages)
  return tree.length ? tree : fixedSections(numPages)
}

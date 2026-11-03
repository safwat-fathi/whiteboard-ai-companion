import type { ChunkIn, SectionRow } from '../db'

/** Search copy of a text (library-ingestion.md "Arabic and normalisation"); the display copy is kept as extracted. */
export function normaliseText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[ـً-ٰٟ]/g, '') // tatweel, harakat
    .replace(/[أإآ]/g, 'ا') // alef variants
    .replace(/ى/g, 'ي') // alef maqsura -> ya
    .replace(/ة/g, 'ه') // ta marbuta -> ha
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase()
}

/**
 * An FTS5 MATCH expression for a free-text query: normalised, split on anything that is not a letter or digit, one-letter
 * tokens dropped, each token quoted and OR-ed. Quoting means a user can never inject FTS syntax. '' means "no keyword search".
 */
export function ftsQuery(q: string): string {
  return normaliseText(q)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .map((t) => `"${t}"`)
    .join(' OR ')
}

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4)

/** What gets embedded: the heading path in front of the chunk (cheap contextual retrieval). */
export const embedInput = (c: { headingPath: string; text: string }): string =>
  c.headingPath ? `${c.headingPath}\n${c.text}` : c.text

export type ChunkPage = { pageIndex: number; label: string; text: string }
export type ChunkOptions = {
  minTokens?: number
  maxTokens?: number
  overlapRatio?: number
}

type Unit = { text: string; page: number; atomic: boolean }

const HEADING = /^#{1,6}\s/
const CHARS_PER_TOKEN = 4

/**
 * A page as units that a chunk boundary may never fall inside: each line, except that a display equation ($$ ... $$),
 * a fenced code block and a run of table rows are one unit each. Blank lines are dropped (outside a fence or equation).
 */
function toUnits(p: ChunkPage): Unit[] {
  const lines = p.text.split('\n')
  const units: Unit[] = []
  const push = (text: string, atomic: boolean) =>
    units.push({ text, page: p.pageIndex, atomic })
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    const trimmed = line.trim()
    if (!trimmed) {
      i++
    } else if (trimmed.startsWith('```')) {
      let j = i + 1
      while (j < lines.length && !(lines[j] as string).trim().startsWith('```'))
        j++
      push(lines.slice(i, j + 1).join('\n'), true)
      i = j + 1
    } else if (count(line, '$$') % 2 === 1) {
      let j = i + 1
      while (j < lines.length && count(lines[j] as string, '$$') % 2 === 0) j++
      push(lines.slice(i, j + 1).join('\n'), true)
      i = j + 1
    } else if (trimmed.startsWith('|')) {
      let j = i
      while (
        j + 1 < lines.length &&
        (lines[j + 1] as string).trim().startsWith('|')
      )
        j++
      push(lines.slice(i, j + 1).join('\n'), true)
      i = j + 1
    } else {
      push(line, false)
      i++
    }
  }
  return units
}

const count = (s: string, sub: string): number => s.split(sub).length - 1

/** Splits one over-long line at sentence ends (else at word breaks), never inside $...$. */
function splitLong(text: string, maxChars: number): string[] {
  const sentenceEnds: number[] = []
  const wordBreaks: number[] = []
  let inMath = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (ch === '$' && text[i - 1] !== '\\') inMath = !inMath
    if (inMath || !/\s/.test(ch)) continue
    wordBreaks.push(i + 1)
    if (/[.!?؟]/.test(text[i - 1] ?? '')) sentenceEnds.push(i + 1)
  }
  const pieces: string[] = []
  let start = 0
  while (text.length - start > maxChars) {
    const limit = start + maxChars
    const last = (xs: number[]) =>
      xs.filter((x) => x > start && x <= limit).at(-1)
    const cut =
      last(sentenceEnds) ??
      last(wordBreaks) ??
      wordBreaks.find((x) => x > limit) ??
      text.length
    pieces.push(text.slice(start, cut).trim())
    start = cut
  }
  pieces.push(text.slice(start).trim())
  return pieces.filter(Boolean)
}

type Packed = Unit[]

function pack(units: Unit[], o: Required<ChunkOptions>): Packed[] {
  const maxChars = o.maxTokens * CHARS_PER_TOKEN
  const minChars = o.minTokens * CHARS_PER_TOKEN
  const targetChars = (minChars + maxChars) / 2
  const overlapChars = Math.ceil(o.overlapRatio * o.maxTokens) * CHARS_PER_TOKEN
  const chunks: Packed[] = []
  let cur: Unit[] = []
  let curChars = 0
  let fresh = 0 // units in `cur` that are not carried-over overlap
  const sizeWith = (u: Unit) => curChars + (cur.length ? 1 : 0) + u.text.length

  const flush = (next: Unit) => {
    chunks.push(cur)
    const tail: Unit[] = []
    let tailChars = 0
    if (o.overlapRatio > 0 && !HEADING.test(next.text)) {
      for (let k = cur.length - 1; k > 0; k--) {
        const u = cur[k] as Unit
        const add = u.text.length + (tail.length ? 1 : 0)
        if (u.atomic || tailChars + add > overlapChars) break
        tail.unshift(u)
        tailChars += add
      }
    }
    cur = tail
    curChars = tail.reduce((n, u, k) => n + u.text.length + (k ? 1 : 0), 0)
    fresh = 0
  }

  for (const u of units) {
    if (fresh === 0 && cur.length && sizeWith(u) > maxChars) {
      cur = [] // only overlap so far and the next unit does not fit beside it: drop the overlap rather than repeat it alone
      curChars = 0
    }
    if (fresh > 0) {
      const size = sizeWith(u)
      if (
        size > maxChars ||
        (curChars >= minChars && size > targetChars) ||
        (curChars >= minChars && HEADING.test(u.text))
      )
        flush(u)
    }
    curChars += (cur.length ? 1 : 0) + u.text.length
    cur.push(u)
    fresh++
  }
  if (fresh > 0) chunks.push(cur)
  return chunks
}

/**
 * Cuts the pages of a book into chunks of about 400 to 800 tokens with ~12% overlap. A chunk never crosses a section
 * (each page belongs to the deepest section that holds it; pages in none are one unsectioned run) and never splits an
 * equation, table or code fence: such a block is one unit, and one bigger than the ceiling stands alone, whole.
 * Page ranges are page indices (positions in the file); `cite_label` uses the printed labels.
 */
export function chunkPages(
  pages: ChunkPage[],
  sections: SectionRow[],
  options: ChunkOptions = {},
): ChunkIn[] {
  const o = {
    minTokens: options.minTokens ?? 400,
    maxTokens: options.maxTokens ?? 800,
    overlapRatio: options.overlapRatio ?? 0.12,
  }
  const byId = new Map(sections.map((s) => [s.id, s]))
  const pathOf = (s: SectionRow | null): string => {
    const titles: string[] = []
    for (
      let n = s;
      n;
      n = n.parentId === null ? null : (byId.get(n.parentId) ?? null)
    )
      titles.unshift(n.title)
    return titles.join(' > ')
  }
  const sectionOf = (page: number): SectionRow | null =>
    sections
      .filter(
        (s) =>
          s.pageStart !== null &&
          s.pageEnd !== null &&
          s.pageStart <= page &&
          page <= s.pageEnd,
      )
      .sort(
        (a, b) =>
          b.level - a.level ||
          (b.pageStart ?? 0) - (a.pageStart ?? 0) ||
          b.id - a.id,
      )[0] ?? null

  const labels = new Map(pages.map((p) => [p.pageIndex, p.label]))
  const runs: { section: SectionRow | null; pages: ChunkPage[] }[] = []
  for (const p of pages) {
    if (!p.text.trim()) continue
    const section = sectionOf(p.pageIndex)
    const last = runs.at(-1)
    if (last && (last.section?.id ?? null) === (section?.id ?? null))
      last.pages.push(p)
    else runs.push({ section, pages: [p] })
  }

  const out: ChunkIn[] = []
  for (const run of runs) {
    const units = run.pages.flatMap((p) =>
      toUnits(p).flatMap((u) =>
        u.atomic || u.text.length <= o.maxTokens * CHARS_PER_TOKEN
          ? [u]
          : splitLong(u.text, o.maxTokens * CHARS_PER_TOKEN).map((text) => ({
              ...u,
              text,
            })),
      ),
    )
    const headingPath = pathOf(run.section)
    for (const unitsOfChunk of pack(units, o)) {
      const text = unitsOfChunk.map((u) => u.text).join('\n')
      const pageStart = Math.min(...unitsOfChunk.map((u) => u.page))
      const pageEnd = Math.max(...unitsOfChunk.map((u) => u.page))
      const a = labels.get(pageStart) ?? String(pageStart)
      const b = labels.get(pageEnd) ?? String(pageEnd)
      out.push({
        sectionId: run.section?.id ?? null,
        ord: out.length,
        pageStart,
        pageEnd,
        citeLabel: pageStart === pageEnd ? `p. ${a}` : `pp. ${a}–${b}`,
        headingPath,
        text,
        textNorm: normaliseText(text),
        tokens: estimateTokens(text),
      })
    }
  }
  return out
}

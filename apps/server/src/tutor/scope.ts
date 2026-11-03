import type { BooksDb, Scope, SectionRow } from '../db'
import type { SourceRange } from './cites'

/** Rough token count: three characters a token holds for Latin and Arabic text alike. */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 3)

/** Book text and titles are data, never instructions: a page cannot close the tag it sits in or open one of ours. */
export function defang(text: string): string {
  return text.replace(
    /<(\/?)(page|chapter|book|outline|book_passage|board_state|student_profile|conversation_summary|conversation)\b/gi,
    '‹$1$2',
  )
}

const attr = (s: string) => defang(s).replace(/"/g, "'").replace(/\s+/g, ' ')
const pages = (s: SectionRow) =>
  s.pageStart !== null && s.pageEnd !== null
    ? `${s.pageStart}-${s.pageEnd}`
    : ''

/** The table of contents: one line per section with its id (for read_section and search scopes) and page range. */
export function outlineText(sections: SectionRow[]): string {
  const base = Math.min(...sections.map((s) => s.level))
  return sections
    .map(
      (s) =>
        `${'  '.repeat(s.level - base)}[${s.id}] ${attr(s.title)}${pages(s) ? ` (pp. ${pages(s)})` : ''}`,
    )
    .join('\n')
}

/** A page of a book as the model reads it: `n` is the file page to cite, `label` the printed one to show. */
export const pageTag = (n: number, label: string | null, text: string) =>
  `<page n="${n}"${label ? ` label="${attr(label)}"` : ''}>${defang(text)}</page>`

export type ScopePack = { pack: string | null; sources: SourceRange[] }

/**
 * What the board's scope puts in the cached prompt prefix (rag-context-engineering.md "Scope packs"). A chapter goes in
 * whole when it fits `maxTokens`, otherwise as the section summaries; a book goes in as its outline plus the top-level
 * summaries; a topic board has no pack. `sources` are the page ranges whose text is actually in the pack: the only
 * pages the model may cite from it.
 */
export function buildScopePack(
  scope: Scope,
  books: BooksDb,
  maxTokens: number,
): ScopePack {
  const none: ScopePack = { pack: null, sources: [] }
  if (!('kind' in scope) || !scope.bookId || scope.kind === 'topic') return none
  const book = books.getBook(scope.bookId)
  if (book?.status !== 'ready') return none
  const sections = books.sectionsOf(book.id)
  if (sections.length === 0) return none
  const open = `<book id="${book.id}" title="${attr(book.title)}">`
  const outline = `<outline>\n${outlineText(sections)}\n</outline>`
  const base = Math.min(...sections.map((s) => s.level))
  const summaryOf = (s: SectionRow) => (s.summary ? defang(s.summary) : '')
  const chapterTag = (s: SectionRow, body: string) =>
    `<chapter title="${attr(s.title)}"${pages(s) ? ` pages="${pages(s)}"` : ''}>${body}</chapter>`

  if (scope.kind === 'book') {
    const top = sections.filter((s) => s.level === base)
    return {
      pack: `${open}\n${outline}\n${top.map((s) => chapterTag(s, summaryOf(s))).join('\n')}\n</book>`,
      sources: [],
    }
  }

  // chapter(s): drop a section whose ancestor is also chosen
  const chosen = new Set(scope.sectionIds ?? [])
  const byId = new Map(sections.map((s) => [s.id, s]))
  const under = (s: SectionRow): boolean => {
    for (let p = s.parentId; p !== null; p = byId.get(p)?.parentId ?? null)
      if (chosen.has(p)) return true
    return false
  }
  const picks = sections.filter((s) => chosen.has(s.id) && !under(s))
  if (picks.length === 0) return none

  const whole: { s: SectionRow; tags: string[] }[] = []
  let tokens = 0
  let fits = true
  for (const s of picks) {
    const tags: string[] = []
    if (s.pageStart !== null && s.pageEnd !== null)
      for (let n = s.pageStart; n <= s.pageEnd && fits; n++) {
        const p = books.getPage(book.id, n)
        if (!p) continue
        const tag = pageTag(n, p.label, p.text)
        tokens += estimateTokens(tag)
        if (tokens > maxTokens) fits = false
        else tags.push(tag)
      }
    whole.push({ s, tags })
  }
  if (fits)
    return {
      pack: `${open}\n${outline}\n${whole.map(({ s, tags }) => chapterTag(s, `\n${tags.join('\n')}\n`)).join('\n')}\n</book>`,
      sources: picks.flatMap((s) =>
        s.pageStart !== null && s.pageEnd !== null
          ? [{ bookId: book.id, pageStart: s.pageStart, pageEnd: s.pageEnd }]
          : [],
      ),
    }

  // too long to read whole: the section and sub-section summaries, and the model reads pages on demand
  const summaries = picks.map((s) => {
    const kids = books
      .withDescendants(book.id, [s.id])
      .filter((id) => id !== s.id)
      .flatMap((id) => byId.get(id) ?? [])
      .map(
        (k) =>
          `[${k.id}] ${attr(k.title)}${pages(k) ? ` (pp. ${pages(k)})` : ''}: ${summaryOf(k)}`,
      )
    return chapterTag(
      s,
      `${summaryOf(s)}${kids.length ? `\n${kids.join('\n')}` : ''}`,
    )
  })
  return {
    pack: `${open}\n${outline}\n${summaries.join('\n')}\n</book>`,
    sources: [],
  }
}

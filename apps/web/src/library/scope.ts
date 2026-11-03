import type { Section } from './api'

/** The board scope the server stores (database.md `boards.scope`). */
export type Scope =
  | { kind: 'book'; bookId: string }
  | { kind: 'chapter'; bookId: string; sectionIds: number[] }

export type TreeNode = { section: Section; children: TreeNode[] }

/** The flat outline (document order) as a tree; a section whose parent is missing goes to the top rather than vanish. */
export function buildTree(sections: Section[]): TreeNode[] {
  const nodes = new Map<number, TreeNode>(
    sections.map((s) => [s.id, { section: s, children: [] }]),
  )
  const roots: TreeNode[] = []
  for (const s of sections) {
    const node = nodes.get(s.id) as TreeNode
    const parent = s.parentId === null ? undefined : nodes.get(s.parentId)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

export function toggle(ids: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(ids)
  if (!next.delete(id)) next.add(id)
  return next
}

/** The whole book when nothing is ticked, else the ticked sections (the server adds the ones below them). */
export function buildScope(bookId: string, ticked: ReadonlySet<number>): Scope {
  return ticked.size === 0
    ? { kind: 'book', bookId }
    : { kind: 'chapter', bookId, sectionIds: [...ticked].sort((a, b) => a - b) }
}

const MAX_TITLE = 200 // the server's limit on a board title

export function scopeTitle(
  bookTitle: string,
  ticked: ReadonlySet<number>,
  sections: Section[],
): string {
  const names = sections.filter((s) => ticked.has(s.id)).map((s) => s.title)
  const title = names.length ? `${bookTitle}: ${names.join(', ')}` : bookTitle
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title
}

/** The book scope a board came back with, or null for no scope, a topic scope or anything malformed. */
export function boardBookScope(raw: unknown): Scope | null {
  const s = raw as {
    kind?: unknown
    bookId?: unknown
    sectionIds?: unknown
  } | null
  if (!s || typeof s !== 'object' || typeof s.bookId !== 'string' || !s.bookId)
    return null
  if (s.kind === 'book') return { kind: 'book', bookId: s.bookId }
  if (
    s.kind === 'chapter' &&
    Array.isArray(s.sectionIds) &&
    s.sectionIds.every((n) => Number.isInteger(n))
  )
    return {
      kind: 'chapter',
      bookId: s.bookId,
      sectionIds: s.sectionIds as number[],
    }
  return null
}

export const tickedOf = (scope: Scope | null): Set<number> =>
  new Set(scope?.kind === 'chapter' ? scope.sectionIds : [])

const MAX_CHIP = 48
/** The scope chip's text. */
export function scopeLabel(
  scope: Scope | null,
  bookTitle: string | undefined,
  sections: Section[],
): string {
  if (!scope) return 'No book'
  const book = bookTitle ?? 'Book'
  const ticked = tickedOf(scope)
  const names = sections.filter((s) => ticked.has(s.id)).map((s) => s.title)
  const label = names.length ? `${book}: ${names.join(', ')}` : book
  return label.length > MAX_CHIP ? `${label.slice(0, MAX_CHIP - 1)}…` : label
}

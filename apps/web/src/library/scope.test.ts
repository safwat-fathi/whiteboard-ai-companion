import { describe, expect, it } from 'vitest'
import type { Section } from './api'
import { buildScope, buildTree, scopeTitle, toggle } from './scope'

const sec = (
  id: number,
  title: string,
  parentId: number | null,
  ord: number,
  pages: [number, number] = [1, 1],
): Section => ({
  id,
  parentId,
  ord,
  level: parentId === null ? 1 : 2,
  title,
  pageStart: pages[0],
  pageEnd: pages[1],
  summary: null,
  tokens: null,
})
const sections = [
  sec(1, 'Ch 1', null, 0, [1, 20]),
  sec(2, '1.1', 1, 0, [1, 10]),
  sec(3, '1.2', 1, 1, [11, 20]),
  sec(4, 'Ch 2', null, 1, [21, 30]),
]

describe('buildTree', () => {
  it('nests the flat list by parent and keeps the order', () => {
    const tree = buildTree(sections)
    expect(tree.map((n) => n.section.title)).toEqual(['Ch 1', 'Ch 2'])
    expect(tree[0]?.children.map((n) => n.section.title)).toEqual([
      '1.1',
      '1.2',
    ])
    expect(tree[1]?.children).toEqual([])
  })
  it('puts a section whose parent is missing at the top instead of losing it', () => {
    const tree = buildTree([sec(9, 'Orphan', 99, 0)])
    expect(tree.map((n) => n.section.title)).toEqual(['Orphan'])
  })
})

describe('toggle', () => {
  it('adds and removes an id without changing the original set', () => {
    const a = new Set([1])
    const b = toggle(a, 2)
    expect([...b].sort()).toEqual([1, 2])
    expect([...a]).toEqual([1])
    expect([...toggle(b, 1)]).toEqual([2])
  })
})

describe('buildScope', () => {
  it('is the whole book when nothing is ticked', () => {
    expect(buildScope('b', new Set())).toEqual({ kind: 'book', bookId: 'b' })
  })
  it('is the ticked chapters, sorted, when some are', () => {
    expect(buildScope('b', new Set([4, 2]))).toEqual({
      kind: 'chapter',
      bookId: 'b',
      sectionIds: [2, 4],
    })
  })
})

describe('scopeTitle', () => {
  it('is the book title, or the title with the ticked sections', () => {
    expect(scopeTitle('Algebra', new Set(), sections)).toBe('Algebra')
    expect(scopeTitle('Algebra', new Set([1, 4]), sections)).toBe(
      'Algebra: Ch 1, Ch 2',
    )
  })
  it('stays within the 200 characters the server allows', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      sec(i + 1, `Section number ${i + 1}`, null, i),
    )
    const t = scopeTitle('Algebra', new Set(many.map((s) => s.id)), many)
    expect(t.length).toBeLessThanOrEqual(200)
    expect(t.endsWith('…')).toBe(true)
  })
})

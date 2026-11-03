import { describe, expect, it } from 'vitest'
import type { OutlineItem } from './pdf'
import { buildSections, FIXED_SECTION_PAGES } from './structure'

const item = (
  title: string,
  page: number | null,
  children: OutlineItem[] = [],
): OutlineItem => ({ title, page, children })
const flat = (nodes: ReturnType<typeof buildSections>): string[] =>
  nodes.flatMap((n) => [
    `${n.title} ${n.pageStart}-${n.pageEnd}`,
    ...flat(n.children).map((l) => `  ${l}`),
  ])

describe('buildSections', () => {
  it('turns a nested outline into page ranges that end where the next sibling starts', () => {
    const tree = buildSections(
      [
        item('Ch 1', 5, [item('1.1', 5), item('1.2', 12), item('1.3', 20)]),
        item('Ch 2', 30, [item('2.1', 31)]),
      ],
      60,
    )
    expect(flat(tree)).toEqual([
      'Ch 1 5-29',
      '  1.1 5-11',
      '  1.2 12-19',
      '  1.3 20-29',
      'Ch 2 30-60',
      '  2.1 31-60',
    ])
  })

  it('clamps entries past the last page and sorts siblings by page', () => {
    const tree = buildSections([item('B', 90), item('A', 10), item('C', 0)], 50)
    expect(flat(tree)).toEqual(['C 1-9', 'A 10-49', 'B 50-50'])
  })

  it('lets siblings that share a page each keep that page', () => {
    const tree = buildSections([item('A', 4), item('B', 4), item('C', 9)], 20)
    expect(flat(tree)).toEqual(['A 4-4', 'B 4-8', 'C 9-20'])
  })

  it('drops an entry that points nowhere and promotes its children', () => {
    const tree = buildSections(
      [
        item('Part I', null, [item('Ch 1', 3), item('Ch 2', 10)]),
        item('End', 20),
      ],
      25,
    )
    expect(flat(tree)).toEqual(['Ch 1 3-9', 'Ch 2 10-19', 'End 20-25'])
  })

  it('keeps children inside their parent range', () => {
    const tree = buildSections(
      [item('A', 10, [item('early', 2), item('late', 40)]), item('B', 20)],
      30,
    )
    expect(flat(tree)).toEqual([
      'A 10-19',
      '  early 10-18',
      '  late 19-19',
      'B 20-30',
    ])
  })

  it('falls back to fixed 20-page sections without an outline', () => {
    const tree = buildSections([], 45)
    expect(FIXED_SECTION_PAGES).toBe(20)
    expect(flat(tree)).toEqual([
      'Pages 1–20 1-20',
      'Pages 21–40 21-40',
      'Pages 41–45 41-45',
    ])
    expect(buildSections([], 20)).toHaveLength(1)
    expect(buildSections([], 21)).toHaveLength(2)
  })

  it('ignores an outline with about one entry per page (a scan: IMG_0001, IMG_0002, ...)', () => {
    const scan = Array.from({ length: 100 }, (_, i) =>
      item(`IMG_${String(i).padStart(4, '0')}`, i + 1),
    )
    expect(buildSections(scan, 100)).toHaveLength(5)
    // a small book may legitimately have many entries for its size
    const small = Array.from({ length: 6 }, (_, i) => item(`S${i}`, i + 1))
    expect(buildSections(small, 8)).toHaveLength(6)
  })
})

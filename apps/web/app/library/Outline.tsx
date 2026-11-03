'use client'

import type { TreeNode } from '../../src/library/scope'
import { ui } from './ui'

/** The outline of a book as nested checkboxes with page links; the Book page and the board's scope picker both show it. */
export function Outline({
  node,
  ticked,
  onTick,
  onOpen,
}: {
  node: TreeNode
  ticked: ReadonlySet<number>
  onTick: (id: number) => void
  onOpen: (page: number) => void
}) {
  const s = node.section
  return (
    <li style={{ marginLeft: s.level > 1 ? 16 : 0, marginBottom: 4 }}>
      <label>
        <input
          type="checkbox"
          checked={ticked.has(s.id)}
          onChange={() => onTick(s.id)}
        />{' '}
        {s.title}
      </label>{' '}
      {s.pageStart !== null && (
        <button
          type="button"
          onClick={() => onOpen(s.pageStart as number)}
          style={{
            all: 'unset',
            cursor: 'pointer',
            color: '#1a56db',
            fontSize: 13,
          }}
        >
          pp. {s.pageStart}
          {s.pageEnd !== s.pageStart ? `–${s.pageEnd}` : ''}
        </button>
      )}
      {s.summary && (
        <details>
          <summary style={ui.muted}>Summary</summary>
          <div dir="auto" style={{ fontSize: 13 }}>
            {s.summary}
          </div>
        </details>
      )}
      {node.children.length > 0 && (
        <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
          {node.children.map((c) => (
            <Outline
              key={c.section.id}
              node={c}
              ticked={ticked}
              onTick={onTick}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

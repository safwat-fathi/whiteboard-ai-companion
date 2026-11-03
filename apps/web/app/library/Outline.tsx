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
    <li
      className={`py-1 transition-colors ${
        s.level > 1 ? 'ml-5 border-l-2 border-slate-100 pl-3' : ''
      }`}
    >
      <div className="flex items-center flex-wrap gap-2">
        <label className="inline-flex items-center gap-2 text-xs sm:text-sm font-medium text-slate-800 hover:text-slate-900 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={ticked.has(s.id)}
            onChange={() => onTick(s.id)}
            className="w-4 h-4 rounded text-blue-600 accent-blue-600 cursor-pointer"
          />
          <span>{s.title}</span>
        </label>
        {s.pageStart !== null && (
          <button
            type="button"
            onClick={() => onOpen(s.pageStart as number)}
            className="inline-flex items-center rounded-md bg-slate-100 hover:bg-blue-50 hover:text-blue-700 text-slate-600 px-2 py-0.5 text-xs font-semibold transition-colors cursor-pointer"
          >
            pp. {s.pageStart}
            {s.pageEnd !== s.pageStart ? `–${s.pageEnd}` : ''}
          </button>
        )}
      </div>
      {s.summary && (
        <details className="group mt-1 ml-6 text-xs">
          <summary
            style={ui.muted}
            className="cursor-pointer font-medium text-slate-400 hover:text-slate-700 transition-colors select-none"
          >
            Summary
          </summary>
          <div
            dir="auto"
            className="mt-1.5 rounded-xl border border-slate-200/80 bg-slate-50 p-2.5 text-xs text-slate-600 leading-relaxed font-sans"
          >
            {s.summary}
          </div>
        </details>
      )}
      {node.children.length > 0 && (
        <ul className="mt-1 space-y-1 list-none pl-0">
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

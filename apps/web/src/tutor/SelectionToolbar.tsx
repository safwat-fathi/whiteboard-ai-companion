'use client'

import {
  type AlignTo,
  alignBatch,
  type Batch,
  bounds,
  distributeBatch,
  type Element,
  groupBatch,
  newId,
  stackBatch,
  topGroup,
  ungroupBatch,
} from '@whiteboard/core'
import { useEffect, useState } from 'react'
import type { Editor } from '../editor/editor'
import { SparklesIcon } from '../ui/icons'

type Pos = { left: number; top: number }

const ALIGN: [AlignTo, string][] = [
  ['left', 'Align left'],
  ['centre', 'Align centre'],
  ['right', 'Align right'],
  ['top', 'Align top'],
  ['middle', 'Align middle'],
  ['bottom', 'Align bottom'],
]
const menuItem =
  'w-full rounded-md px-2.5 py-1 text-start text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer'

/** Above the selection's top edge, centred, kept inside the board (never under the dock or off the top). */
export function toolbarPosition(
  anchor: { x: number; top: number },
  host: { left: number; right: number; top: number },
  size = { w: 96, h: 32 },
  gap = 8,
): Pos {
  const left = Math.min(
    Math.max(anchor.x - size.w / 2, host.left + 8),
    host.right - size.w - 8,
  )
  const above = anchor.top - size.h - gap
  return { left, top: above < host.top + 8 ? anchor.top + gap : above }
}

/** The floating "Ask AI" on a selection (chat-ui.md). No keyboard shortcut is assigned (closed decision). */
export function SelectionToolbar({
  editor,
  onAsk,
}: {
  editor: Editor
  onAsk: () => void
}) {
  const [pos, setPos] = useState<Pos | null>(null)
  const [menu, setMenu] = useState(false)
  const [count, setCount] = useState(0)
  useEffect(() => {
    const place = () => {
      setCount(editor.selection.size)
      if (editor.readOnly || editor.selection.size === 0) {
        setMenu(false)
        return setPos(null)
      }
      const els = [...editor.selection].flatMap(
        (id) => editor.scene.els.get(id) ?? [],
      )
      if (els.length === 0) return setPos(null)
      const bs = els.map(bounds)
      const minX = Math.min(...bs.map((b) => b.minX))
      const maxX = Math.max(...bs.map((b) => b.maxX))
      const minY = Math.min(...bs.map((b) => b.minY))
      const top = editor.worldToClient({ x: 0, y: minY }).y
      const mid = editor.worldToClient({ x: (minX + maxX) / 2, y: minY })
      const h = editor.host.getBoundingClientRect()
      setPos(
        toolbarPosition(
          { x: mid.x, top },
          { left: h.left, right: h.right, top: h.top },
        ),
      )
    }
    place()
    const offs = [
      editor.onSelectionChange(place),
      editor.onChange(place),
      editor.onCameraChange(place),
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [editor])
  if (!pos) return null
  const picked = () =>
    [...editor.selection].flatMap((id) => editor.scene.els.get(id) ?? [])
  const run = (make: (els: Element[]) => Batch | null) => {
    const b = make(picked().filter((e) => !e.locked))
    if (b) editor.commit(b)
    setMenu(false)
  }
  const grouped = picked().some((e) => topGroup(editor.scene, e))
  return (
    <div
      role="toolbar"
      aria-label="Selection"
      className="fixed z-20 flex items-center rounded-full border border-slate-200/90 bg-white/95 p-1 shadow-lg shadow-slate-900/10 backdrop-blur-md transition-all duration-150"
      style={{
        left: pos.left,
        top: pos.top,
      }}
    >
      <button
        type="button"
        // keep the selection and focus on the board while pressing it
        onMouseDown={(e) => e.preventDefault()}
        onClick={onAsk}
        className="flex items-center gap-1.5 rounded-full bg-blue-50/90 px-3 py-1 text-xs font-semibold text-blue-700 transition-all duration-150 hover:bg-blue-600 hover:text-white active:scale-95 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1"
      >
        <SparklesIcon size={14} className="text-current" />
        <span>Ask AI</span>
      </button>
      {count > 1 && (
        <button
          type="button"
          aria-label="Arrange"
          aria-expanded={menu}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setMenu((m) => !m)}
          className="ml-1 rounded-full px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 cursor-pointer"
        >
          Arrange
        </button>
      )}
      {menu && (
        <div
          role="menu"
          aria-label="Arrange"
          className="absolute left-0 top-full mt-1 flex w-44 flex-col rounded-xl border border-slate-200 bg-white p-1 shadow-lg"
        >
          {ALIGN.map(([to, label]) => (
            <button
              key={to}
              type="button"
              role="menuitem"
              aria-label={label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run((els) => alignBatch(editor.scene, els, to))}
              className={menuItem}
            >
              {label}
            </button>
          ))}
          {(['horizontal', 'vertical'] as const).map((axis) => (
            <button
              key={axis}
              type="button"
              role="menuitem"
              aria-label={`Distribute ${axis}ly`}
              disabled={count < 3}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                run((els) => distributeBatch(editor.scene, els, axis))
              }
              className={menuItem}
            >
              {`Distribute ${axis}ly`}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            aria-label="Stack in a column"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              run((els) => stackBatch(editor.scene, els, 'column'))
            }
            className={menuItem}
          >
            Stack in a column
          </button>
          <button
            type="button"
            role="menuitem"
            aria-label="Group"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              run(() =>
                groupBatch(editor.scene, editor.selection, editor.author),
              )
            }
            className={menuItem}
          >
            Group
          </button>
          <button
            type="button"
            role="menuitem"
            aria-label="Ungroup"
            disabled={!grouped}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              run((els) => {
                const tops = new Set(
                  els.flatMap((e) => topGroup(editor.scene, e)?.id ?? []),
                )
                const ops = [...tops].flatMap(
                  (id) => ungroupBatch(editor.scene, id)?.ops ?? [],
                )
                return ops.length
                  ? { batchId: newId(), label: 'Ungroup', ops }
                  : null
              })
            }
            className={menuItem}
          >
            Ungroup
          </button>
        </div>
      )}
    </div>
  )
}

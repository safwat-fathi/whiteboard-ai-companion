'use client'

import { bounds } from '@whiteboard/core'
import { useEffect, useState } from 'react'
import type { Editor } from '../editor/editor'
import { SparklesIcon } from '../ui/icons'

type Pos = { left: number; top: number }

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
  useEffect(() => {
    const place = () => {
      if (editor.readOnly || editor.selection.size === 0) return setPos(null)
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
    </div>
  )
}

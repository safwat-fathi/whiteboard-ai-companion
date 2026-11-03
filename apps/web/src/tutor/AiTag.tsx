'use client'

import { useEffect, useRef, useState } from 'react'
import type { Editor } from '../editor/editor'

type Tag = { turnId: string; x: number; y: number }

/** Hovering something the AI drew shows "AI · <what you asked>" with a way back to that turn in the chat. */
export function AiTag({
  editor,
  labelOf,
  onShow,
}: {
  editor: Pick<
    Editor,
    'host' | 'index' | 'camera' | 'scene' | 'screenToWorldPoint'
  >
  labelOf: (turnId: string) => string | undefined
  onShow: (turnId: string) => void
}) {
  const [tag, setTag] = useState<Tag | null>(null)
  const tagRef = useRef<Tag | null>(null)
  tagRef.current = tag
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const host = editor.host
    const move = (e: PointerEvent) => {
      const p = editor.screenToWorldPoint(e.clientX, e.clientY)
      const el = editor.index.pick(p, editor.camera.zoom, editor.scene)
      if (el && el.author.kind === 'agent') {
        clearTimeout(hide.current)
        const turnId = el.author.id.replace(/^tutor:/, '')
        // If already showing a tag for this turn nearby, freeze position so it doesn't run away from the pointer
        if (tagRef.current && tagRef.current.turnId === turnId) {
          const dist = Math.hypot(
            e.clientX - tagRef.current.x,
            e.clientY - tagRef.current.y,
          )
          if (dist < 180) return
        }
        setTag({
          turnId,
          x: e.clientX,
          y: e.clientY,
        })
      } else {
        clearTimeout(hide.current)
        hide.current = setTimeout(() => setTag(null), 250)
      }
    }
    host.addEventListener('pointermove', move)
    return () => {
      host.removeEventListener('pointermove', move)
      clearTimeout(hide.current)
    }
  }, [editor])
  if (!tag) return null
  const label = labelOf(tag.turnId)
  return (
    <fieldset
      aria-label="Made by the AI"
      onPointerEnter={() => clearTimeout(hide.current)}
      onPointerLeave={() => setTag(null)}
      // The offset (12) must exceed the invisible hit margin (-inset-2 = 8): otherwise the tag spawns under the
      // pointer and swallows the wheel and the clicks meant for the board (m5-jump: Follow stayed on after a wheel).
      className="fixed z-20 flex items-center gap-2 rounded-xl border border-blue-500/80 bg-blue-600 px-2.5 py-1 text-xs text-white shadow-md shadow-blue-900/20 backdrop-blur-md transition-opacity duration-150 before:absolute before:-inset-2 before:content-['']"
      style={{
        left: tag.x + 12,
        top: tag.y + 12,
      }}
    >
      <span dir="auto" className="font-medium">
        AI{label ? ` · ${label}` : ''}
      </span>
      <button
        type="button"
        onClick={() => onShow(tag.turnId)}
        className="rounded-lg bg-white/95 px-2 py-0.5 text-xs font-semibold text-blue-700 shadow-xs transition-colors hover:bg-white active:scale-95 cursor-pointer"
      >
        Show in chat
      </button>
    </fieldset>
  )
}

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
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    const host = editor.host
    const move = (e: PointerEvent) => {
      const p = editor.screenToWorldPoint(e.clientX, e.clientY)
      const el = editor.index.pick(p, editor.camera.zoom, editor.scene)
      if (el && el.author.kind === 'agent') {
        clearTimeout(hide.current)
        setTag({
          turnId: el.author.id.replace(/^tutor:/, ''),
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
      style={{
        position: 'fixed',
        left: tag.x + 12,
        top: tag.y + 12,
        zIndex: 12,
        background: '#1a56db',
        color: '#fff',
        borderRadius: 8,
        padding: '3px 8px',
        font: '12px system-ui, sans-serif',
        display: 'flex',
        gap: 8,
        alignItems: 'center',
      }}
    >
      <span dir="auto">AI{label ? ` · ${label}` : ''}</span>
      <button
        type="button"
        onClick={() => onShow(tag.turnId)}
        style={{
          font: 'inherit',
          background: '#fff',
          color: '#1a56db',
          border: 'none',
          borderRadius: 6,
          padding: '1px 6px',
          cursor: 'pointer',
        }}
      >
        Show in chat
      </button>
    </fieldset>
  )
}

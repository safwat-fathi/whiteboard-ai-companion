'use client'

import { type Rect, ZOOM_MAX } from '@whiteboard/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '../editor/editor'
import type { ServerBatch } from '../editor/sync'
import {
  CameraHistory,
  cameraRect,
  edgeIndicator,
  isOutside,
  type LocateItem,
  locateTarget,
  shouldFollow,
} from './locate'

type JumpEditor = Pick<
  Editor,
  | 'scene'
  | 'camera'
  | 'viewport'
  | 'host'
  | 'flyTo'
  | 'pulse'
  | 'onCameraChange'
  | 'worldToClient'
>
type Indicator = {
  x: number
  y: number
  angle: number
  n: number
  host: { left: number; top: number }
}

const reduced = () =>
  typeof matchMedia === 'function' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Jump to AI work (jump-to-ai.md): Locate (fly to where some AI work is now, pulse it, remember where we were), Follow AI
 * (the camera eases to each new AI batch; any wheel or press on the canvas turns it off), and the arrow on the edge of the
 * board when AI work lands off screen. The camera never moves unasked: with Follow off only `locate` moves it.
 */
export function useJump(
  editor: JumpEditor | null,
  o: {
    follow: boolean
    onFollowOff: () => void
    notify: (text: string) => void
    now?: () => number
  },
) {
  const hist = useRef(new CameraHistory())
  const latest = useRef<LocateItem[] | null>(null)
  const lastFollow = useRef(-Infinity)
  const followRef = useRef(o.follow)
  followRef.current = o.follow
  const now = o.now ?? Date.now
  const [canBack, setCanBack] = useState(false)
  const [ghost, setGhost] = useState<Rect | null>(null)
  const [latestRect, setLatestRect] = useState<Rect | null>(null)
  const [unseen, setUnseen] = useState(0)
  const [indicator, setIndicator] = useState<Indicator | null>(null)
  const ghostTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )

  const locate = useCallback(
    async (items: LocateItem[], opts: { keepZoom?: boolean } = {}) => {
      if (!editor) return false
      const t = locateTarget(editor.scene, items)
      if (!t) return false
      hist.current.push(editor.camera)
      setCanBack(true)
      clearTimeout(ghostTimer.current)
      setGhost(t.ghost ? t.rect : null)
      if (t.ghost) ghostTimer.current = setTimeout(() => setGhost(null), 4000)
      setUnseen(0)
      await editor.flyTo(t.rect, {
        padding: 64,
        maxZoom: opts.keepZoom ? editor.camera.zoom : 2,
      })
      if (!t.ghost && !reduced()) editor.pulse(t.ids)
      return true
    },
    [editor],
  )

  const back = useCallback(async () => {
    const cam = hist.current.pop()
    setCanBack(hist.current.size > 0)
    setGhost(null)
    if (!editor || !cam) return
    await editor.flyTo(
      {
        minX: cam.x,
        minY: cam.y,
        maxX: cam.x + editor.viewport.width / cam.zoom,
        maxY: cam.y + editor.viewport.height / cam.zoom,
      },
      { padding: 0, maxZoom: ZOOM_MAX },
    )
  }, [editor])

  /** Every batch the server applied; the AI's own ones drive Follow and the arrow. */
  const onAgentBatch = useCallback(
    (sb: ServerBatch) => {
      if (sb.author?.kind !== 'agent') return
      const ids = [
        ...new Set(
          sb.batch.ops.map((op) => (op.op === 'add' ? op.el.id : op.id)),
        ),
      ]
      const items = [{ ids, bounds: sb.bounds ?? null }]
      latest.current = items
      if (sb.bounds)
        setLatestRect({
          minX: sb.bounds.x,
          minY: sb.bounds.y,
          maxX: sb.bounds.x + sb.bounds.w,
          maxY: sb.bounds.y + sb.bounds.h,
        })
      if (followRef.current) {
        const t = now()
        if (shouldFollow(t, lastFollow.current)) {
          lastFollow.current = t
          void locate(items, { keepZoom: true })
        }
      } else setUnseen((n) => n + 1)
    },
    [locate, now],
  )

  /** A turn ended: the arrow and the "new" count go away. */
  const turnEnded = useCallback(() => {
    latest.current = null
    setLatestRect(null)
    setUnseen(0)
  }, [])

  const locateLatest = useCallback(
    () => (latest.current ? locate(latest.current) : Promise.resolve(false)),
    [locate],
  )

  // Follow is for watching: touching the canvas means "I'll steer".
  const { follow, onFollowOff, notify } = o
  useEffect(() => {
    if (!editor || !follow) return
    const off = () => {
      onFollowOff()
      notify('Follow AI off (you moved the canvas)')
    }
    const host = editor.host
    host.addEventListener('wheel', off, { capture: true, passive: true })
    host.addEventListener('pointerdown', off, { capture: true })
    return () => {
      host.removeEventListener('wheel', off, { capture: true })
      host.removeEventListener('pointerdown', off, { capture: true })
    }
  }, [editor, follow, onFollowOff, notify])

  // the edge arrow: only while Follow is off, AI work landed, and none of it is on screen
  useEffect(() => {
    if (!editor) return
    const calc = () => {
      const items = latest.current
      if (follow || !items || unseen === 0) return setIndicator(null)
      const t = locateTarget(editor.scene, items)
      if (!t) return setIndicator(null)
      if (!isOutside(t.rect, cameraRect(editor.camera, editor.viewport))) {
        setUnseen(0) // it came into view
        return setIndicator(null)
      }
      const h = editor.host.getBoundingClientRect()
      const c = editor.worldToClient({
        x: (t.rect.minX + t.rect.maxX) / 2,
        y: (t.rect.minY + t.rect.maxY) / 2,
      })
      const size = { w: editor.viewport.width, h: editor.viewport.height }
      setIndicator({
        ...edgeIndicator(
          { dx: c.x - (h.left + size.w / 2), dy: c.y - (h.top + size.h / 2) },
          size,
          16,
        ),
        n: unseen,
        host: { left: h.left, top: h.top },
      })
    }
    calc()
    return editor.onCameraChange(calc)
  }, [editor, follow, unseen])

  useEffect(() => () => clearTimeout(ghostTimer.current), [])

  return {
    locate,
    locateLatest,
    back,
    canBack,
    ghost,
    indicator,
    latestRect,
    onAgentBatch,
    turnEnded,
  }
}

const chip: React.CSSProperties = {
  position: 'fixed',
  zIndex: 11,
  font: '13px system-ui, sans-serif',
  background: '#fff',
  border: '1px solid #1a56db',
  color: '#1a56db',
  borderRadius: 14,
  padding: '2px 10px',
  cursor: 'pointer',
}

export function BackChip({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      style={{ ...chip, left: 12, top: 56 }}
    >
      ↩ Back
    </button>
  )
}

/** The arrow on the edge of the board: "AI · 2 new". Click to jump. */
export function EdgeIndicator({
  at,
  onJump,
}: {
  at: Indicator
  onJump: () => void
}) {
  return (
    <button
      type="button"
      onClick={onJump}
      aria-label={`The AI is working off screen (${at.n} new). Jump there`}
      style={{
        ...chip,
        left: at.host.left + at.x - 40,
        top: at.host.top + at.y - 14,
        display: 'flex',
        gap: 6,
        alignItems: 'center',
      }}
    >
      <span
        aria-hidden="true"
        style={{ display: 'inline-block', transform: `rotate(${at.angle}rad)` }}
      >
        ➤
      </span>
      AI · {at.n} new
    </button>
  )
}

/** A dashed frame where removed AI work used to be. */
export function GhostFrame({
  editor,
  rect,
}: {
  editor: JumpEditor
  rect: Rect
}) {
  const [, tick] = useState(0)
  useEffect(() => editor.onCameraChange(() => tick((n) => n + 1)), [editor])
  const a = editor.worldToClient({ x: rect.minX, y: rect.minY })
  const b = editor.worldToClient({ x: rect.maxX, y: rect.maxY })
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        zIndex: 11,
        pointerEvents: 'none',
        left: a.x,
        top: a.y,
        width: b.x - a.x,
        height: b.y - a.y,
        border: '2px dashed #888',
        borderRadius: 4,
        color: '#666',
        font: '12px system-ui, sans-serif',
      }}
    >
      <span style={{ background: '#fff', padding: '0 4px' }}>removed</span>
    </div>
  )
}

/** The AI's "cursor": a badge at its latest batch while it works, with what it is doing. */
export function AiPresence({
  editor,
  rect,
  label,
}: {
  editor: JumpEditor
  rect: Rect
  label: string
}) {
  const [, tick] = useState(0)
  useEffect(() => editor.onCameraChange(() => tick((n) => n + 1)), [editor])
  const p = editor.worldToClient({ x: rect.maxX, y: rect.minY })
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        zIndex: 11,
        pointerEvents: 'none',
        left: p.x + 6,
        top: p.y - 22,
        background: '#1a56db',
        color: '#fff',
        borderRadius: 10,
        padding: '1px 8px',
        font: '12px system-ui, sans-serif',
      }}
    >
      AI · {label}
    </div>
  )
}

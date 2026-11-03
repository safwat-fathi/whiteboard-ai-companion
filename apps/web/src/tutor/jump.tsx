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

export function BackChip({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="fixed left-3 top-14 z-10 flex items-center gap-1.5 rounded-full border border-blue-500/80 bg-white/95 px-3 py-1 text-xs font-semibold text-blue-600 shadow-md backdrop-blur-md transition-all duration-150 hover:bg-blue-600 hover:text-white active:scale-95 cursor-pointer"
    >
      <span>↩ Back</span>
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
      className="fixed z-10 flex items-center gap-1.5 rounded-full border border-blue-500/80 bg-white/95 px-3 py-1 text-xs font-semibold text-blue-600 shadow-lg backdrop-blur-md transition-all duration-150 hover:bg-blue-600 hover:text-white active:scale-95 cursor-pointer animate-pulse"
      style={{
        left: at.host.left + at.x - 40,
        top: at.host.top + at.y - 14,
      }}
    >
      <span
        aria-hidden="true"
        className="inline-block text-blue-600 text-xs"
        style={{ transform: `rotate(${at.angle}rad)` }}
      >
        ➤
      </span>
      <span>AI · {at.n} new</span>
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
      className="fixed z-10 pointer-events-none rounded-lg border-2 border-dashed border-slate-400 font-sans text-xs text-slate-500"
      style={{
        left: a.x,
        top: a.y,
        width: b.x - a.x,
        height: b.y - a.y,
      }}
    >
      <span className="bg-white/90 px-1.5 py-0.5 text-[11px] font-medium rounded">
        removed
      </span>
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
      className="fixed z-10 pointer-events-none flex items-center gap-1 rounded-full border border-blue-500/80 bg-blue-600 px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-md animate-ai-glow"
      style={{
        left: p.x + 6,
        top: p.y - 22,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-white animate-ping" />
      <span>AI · {label}</span>
    </div>
  )
}

'use client'

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from 'react'

// The tutor dock beside the board (chat-ui.md "Layout"): resizable 320-560 px, collapsible, a bottom sheet on narrow screens.

export const DOCK_MIN = 320
export const DOCK_MAX = 560
export const DOCK_DEFAULT = 380
export const STRIP_W = 40 // collapsed: just the open button
export const SHEET_H = 360 // narrow screens: the sheet's height
export const SHEET_STRIP_H = 44
export const NARROW_QUERY = '(max-width: 720px)'
const KEY = 'whiteboard:dock'

export const clampDock = (w: number) =>
  Math.min(DOCK_MAX, Math.max(DOCK_MIN, Math.round(w)))

export const TABS = [
  { id: 'chat', label: 'Chat' },
  { id: 'activity', label: 'Activity' },
  { id: 'source', label: 'Source' },
] as const
export type DockTab = (typeof TABS)[number]['id']

type Saved = { width: number; collapsed: boolean }
function readSaved(): Saved {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>
    return {
      width: typeof j.width === 'number' ? clampDock(j.width) : DOCK_DEFAULT,
      collapsed: j.collapsed === true,
    }
  } catch {
    return { width: DOCK_DEFAULT, collapsed: false }
  }
}
function writeSaved(s: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {} // private window or blocked storage: the dock just forgets
}

/** Dock state and the room it takes from the board (`inset`, in px, for the editor's host element). */
export function useDockLayout(enabled: boolean) {
  const [width, setWidthState] = useState(DOCK_DEFAULT)
  const [collapsed, setCollapsedState] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const [tab, setTab] = useState<DockTab>('chat')

  useEffect(() => {
    const s = readSaved()
    setWidthState(s.width)
    setCollapsedState(s.collapsed)
    const mq = window.matchMedia?.(NARROW_QUERY)
    if (!mq) return
    setNarrow(mq.matches)
    const on = (e: { matches: boolean }) => setNarrow(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const setWidth = useCallback(
    (w: number) => {
      const next = clampDock(w)
      setWidthState(next)
      writeSaved({ width: next, collapsed })
    },
    [collapsed],
  )
  const setCollapsed = useCallback(
    (c: boolean) => {
      setCollapsedState(c)
      writeSaved({ width, collapsed: c })
    },
    [width],
  )

  const inset = !enabled
    ? { right: 0, bottom: 0 }
    : narrow
      ? { right: 0, bottom: collapsed ? SHEET_STRIP_H : SHEET_H }
      : { right: collapsed ? STRIP_W : width, bottom: 0 }
  return {
    enabled,
    inset,
    width,
    setWidth,
    collapsed,
    setCollapsed,
    narrow,
    tab,
    setTab,
  }
}
export type DockLayout = ReturnType<typeof useDockLayout>

const box: CSSProperties = {
  position: 'fixed',
  background: '#fff',
  color: '#1e1e1e',
  zIndex: 20,
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 0 12px rgba(0,0,0,0.15)',
}
const btn: CSSProperties = {
  border: '1px solid #ccc',
  background: '#fff',
  borderRadius: 6,
  padding: '4px 10px',
  cursor: 'pointer',
  font: 'inherit',
}

export function Dock({
  layout,
  panes,
}: {
  layout: DockLayout
  panes: Record<DockTab, ReactNode>
}) {
  const { width, setWidth, collapsed, setCollapsed, narrow, tab, setTab } =
    layout

  if (collapsed)
    return (
      <aside
        aria-label="Tutor"
        style={{
          ...box,
          ...(narrow
            ? { left: 0, right: 0, bottom: 0, height: SHEET_STRIP_H }
            : { top: 0, right: 0, bottom: 0, width: STRIP_W }),
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <button
          type="button"
          style={btn}
          aria-label="Open the tutor"
          onClick={() => setCollapsed(false)}
        >
          {narrow ? '▲ Tutor' : '‹'}
        </button>
      </aside>
    )

  const onTabKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab)
    const to =
      e.key === 'ArrowRight'
        ? TABS[(i + 1) % TABS.length]
        : e.key === 'ArrowLeft'
          ? TABS[(i + TABS.length - 1) % TABS.length]
          : e.key === 'Home'
            ? TABS[0]
            : e.key === 'End'
              ? TABS[TABS.length - 1]
              : undefined
    if (!to) return
    e.preventDefault()
    setTab(to.id)
    document.getElementById(`dock-tab-${to.id}`)?.focus()
  }
  const drag = (e: PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return
    setWidth(window.innerWidth - e.clientX)
  }

  return (
    <aside
      aria-label="Tutor"
      style={{
        ...box,
        ...(narrow
          ? { left: 0, right: 0, bottom: 0, height: SHEET_H }
          : { top: 0, right: 0, bottom: 0, width }),
      }}
    >
      {!narrow && (
        // biome-ignore lint/a11y/useSemanticElements: the WAI-ARIA window splitter is a focusable, draggable separator; <hr> cannot be either
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the tutor"
          aria-valuemin={DOCK_MIN}
          aria-valuemax={DOCK_MAX}
          aria-valuenow={width}
          tabIndex={0}
          style={{
            position: 'absolute',
            left: -3,
            top: 0,
            bottom: 0,
            width: 6,
            cursor: 'col-resize',
            touchAction: 'none',
          }}
          onPointerDown={(e) =>
            e.currentTarget.setPointerCapture?.(e.pointerId)
          }
          onPointerMove={drag}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setWidth(width + 16)
            else if (e.key === 'ArrowRight') setWidth(width - 16)
            else return
            e.preventDefault()
          }}
        />
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '6px 8px',
          borderBottom: '1px solid #ddd',
        }}
      >
        <div
          role="tablist"
          aria-label="Tutor panels"
          style={{ display: 'flex', gap: 4, flex: 1 }}
          onKeyDown={onTabKey}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`dock-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`dock-pane-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              style={{
                ...btn,
                ...(tab === t.id
                  ? {
                      background: '#1a56db',
                      color: '#fff',
                      borderColor: '#1a56db',
                    }
                  : {}),
              }}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          style={btn}
          aria-label="Collapse the tutor"
          onClick={() => setCollapsed(true)}
        >
          {narrow ? '▼' : '›'}
        </button>
      </div>
      {TABS.map((t) => (
        <div
          key={t.id}
          id={`dock-pane-${t.id}`}
          role="tabpanel"
          aria-labelledby={`dock-tab-${t.id}`}
          hidden={tab !== t.id}
          style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
        >
          {panes[t.id]}
        </div>
      ))}
    </aside>
  )
}

/** The pill at the top-left of the board: way back to the boards, the title, and slots for scope, Follow AI and spend. */
export function TopBar({
  title,
  children,
}: {
  title: string
  children?: ReactNode
}) {
  return (
    <header
      style={{
        position: 'fixed',
        top: 12,
        left: 12,
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: '#fff',
        border: '1px solid #ccc',
        borderRadius: 8,
        padding: '4px 10px',
        font: '14px system-ui, sans-serif',
        maxWidth: 'calc(100vw - 24px)',
      }}
    >
      <a href="/library" style={{ color: '#1a56db' }}>
        ‹ Library
      </a>
      <strong
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {title}
      </strong>
      {children}
    </header>
  )
}

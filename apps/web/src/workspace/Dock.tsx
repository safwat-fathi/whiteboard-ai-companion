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
import {
  ActivityIcon,
  ChatIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SourceIcon,
} from '../ui/icons'

// The tutor dock beside the board (chat-ui.md "Layout"): resizable 320-560 px, collapsible, a bottom sheet on narrow screens.

export const DOCK_MIN = 320
export const DOCK_MAX = 560
export const DOCK_DEFAULT = 380
export const STRIP_W = 44 // collapsed: just the open button
export const SHEET_H = 360 // narrow screens: the sheet's height
export const SHEET_STRIP_H = 44
export const NARROW_QUERY = '(max-width: 720px)'
const KEY = 'whiteboard:dock'

export const clampDock = (w: number) =>
  Math.min(DOCK_MAX, Math.max(DOCK_MIN, Math.round(w)))

export const TABS = [
  { id: 'chat', label: 'Chat', icon: ChatIcon },
  { id: 'activity', label: 'Activity', icon: ActivityIcon },
  { id: 'source', label: 'Source', icon: SourceIcon },
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
  zIndex: 20,
  display: 'flex',
  flexDirection: 'column',
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

  // Collapsing only hides the panes: unmounting ChatTab would abort a running turn.
  return (
    <>
      {collapsed && (
        <aside
          aria-label="Tutor"
          className="fixed z-20 flex flex-col items-center justify-center border-l border-slate-200/90 bg-white/95 shadow-lg backdrop-blur-md transition-all duration-150"
          style={{
            ...box,
            ...(narrow
              ? { left: 0, right: 0, bottom: 0, height: SHEET_STRIP_H }
              : { top: 0, right: 0, bottom: 0, width: STRIP_W }),
          }}
        >
          <button
            type="button"
            className="group flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm transition-all duration-150 hover:border-blue-500 hover:bg-blue-50 hover:text-blue-600 active:scale-95 cursor-pointer"
            aria-label="Open the tutor"
            onClick={() => setCollapsed(false)}
          >
            {narrow ? (
              <span className="text-xs font-semibold">▲ Tutor</span>
            ) : (
              <ChevronLeftIcon
                size={18}
                className="transition-transform group-hover:-translate-x-0.5"
              />
            )}
          </button>
        </aside>
      )}
      <aside
        aria-label="Tutor"
        className="fixed z-20 flex flex-col border-l border-slate-200 bg-white text-slate-800 shadow-2xl transition-all duration-150"
        style={{
          ...box,
          ...(collapsed ? { display: 'none' } : {}),
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
            className="group absolute -left-1.5 top-0 bottom-0 w-3 cursor-col-resize touch-none z-30 flex items-center justify-center"
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
          >
            <div className="h-10 w-1 rounded-full bg-slate-300 opacity-0 transition-opacity group-hover:opacity-100 group-active:opacity-100 group-hover:bg-blue-500" />
          </div>
        )}
        <div className="flex items-center gap-2 border-b border-slate-200/80 bg-slate-50/70 px-3 py-2">
          <div
            role="tablist"
            aria-label="Tutor panels"
            className="flex flex-1 items-center gap-1 rounded-xl bg-slate-200/60 p-0.5"
            onKeyDown={onTabKey}
          >
            {TABS.map((t) => {
              const isSelected = tab === t.id
              const Icon = t.icon
              return (
                <button
                  key={t.id}
                  id={`dock-tab-${t.id}`}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  aria-controls={`dock-pane-${t.id}`}
                  tabIndex={isSelected ? 0 : -1}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition-all duration-150 cursor-pointer ${
                    isSelected
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
                  }`}
                  onClick={() => setTab(t.id)}
                >
                  <Icon
                    size={13}
                    className={isSelected ? 'text-blue-600' : 'text-slate-400'}
                  />
                  <span>{t.label}</span>
                </button>
              )
            })}
          </div>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-transparent text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-900 cursor-pointer"
            aria-label="Collapse the tutor"
            onClick={() => setCollapsed(true)}
          >
            {narrow ? (
              <span className="text-xs">▼</span>
            ) : (
              <ChevronRightIcon size={16} />
            )}
          </button>
        </div>
        {TABS.map((t) => (
          <div
            key={t.id}
            id={`dock-pane-${t.id}`}
            role="tabpanel"
            aria-labelledby={`dock-tab-${t.id}`}
            hidden={tab !== t.id}
            className="flex-1 min-h-0 overflow-auto bg-white"
          >
            {panes[t.id]}
          </div>
        ))}
      </aside>
    </>
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
    <header className="fixed top-3 left-3 z-10 flex max-w-[calc(100vw-24px)] items-center gap-2.5 rounded-2xl border border-slate-200/90 bg-white/95 px-3 py-1.5 shadow-lg shadow-slate-900/5 backdrop-blur-md transition-all duration-150 font-sans text-xs sm:text-sm text-slate-700">
      <a
        href="/library"
        className="flex items-center gap-1 font-semibold text-blue-600 transition-colors hover:text-blue-700"
      >
        <span className="text-base leading-none">‹</span> Library
      </a>
      <div className="h-3.5 w-px bg-slate-200" />
      <strong className="max-w-[180px] truncate font-semibold text-slate-900">
        {title}
      </strong>
      {children}
    </header>
  )
}

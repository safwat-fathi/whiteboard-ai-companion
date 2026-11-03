import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'

/** Modern design tokens and shared layout primitives for Library and Dialogs. */
export const ui = {
  alert: {
    background: '#fffbeb',
    border: '1px solid #fde68a',
    borderRadius: 12,
    padding: '8px 14px',
    color: '#92400e',
    fontSize: 13,
    fontWeight: 500,
  },
  muted: { color: '#64748b', fontSize: 13 },
  drop: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    border: '2px dashed #cbd5e1',
    borderRadius: 16,
    padding: '36px 20px',
    textAlign: 'center',
    cursor: 'pointer',
    margin: '16px 0 24px',
    background: '#f8fafc',
    transition: 'all 0.15s ease',
  },
  dropOver: {
    background: '#eff6ff',
    borderColor: '#3b82f6',
    boxShadow: '0 0 0 4px rgba(59, 130, 246, 0.1)',
  },
  hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  list: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'grid',
    gap: 12,
  },
  card: {
    background: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: 16,
    padding: '16px 18px',
    display: 'grid',
    gap: 6,
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04)',
    transition: 'all 0.15s ease',
  },
  actions: {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15, 23, 42, 0.45)',
    backdropFilter: 'blur(8px)',
    display: 'grid',
    placeItems: 'center',
    padding: 16,
    overflowY: 'auto',
    zIndex: 50,
  },
  dialog: {
    background: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: 20,
    padding: '24px 28px',
    width: 'min(92vw, 720px)',
    maxHeight: '86vh',
    overflow: 'auto',
    margin: 'auto',
    boxShadow: '0 25px 50px -12px rgba(15, 23, 42, 0.25)',
  },
  fieldset: {
    margin: '14px 0',
    borderRadius: 12,
    border: '1px solid #e2e8f0',
    padding: '12px 16px',
    background: '#f8fafc',
  },
  preview: {
    display: 'grid',
    gridTemplateColumns: '160px 1fr 1fr',
    gap: 12,
    marginTop: 12,
  },
  pre: {
    whiteSpace: 'pre-wrap',
    margin: 0,
    fontSize: 12,
    maxHeight: 240,
    overflow: 'auto',
    background: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    padding: 8,
    fontFamily: 'monospace',
  },
} satisfies Record<string, CSSProperties>

export function Shell({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: ReactNode
  children: ReactNode
}) {
  return (
    <main className="min-h-screen bg-slate-50/70 text-slate-900 font-sans">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <header className="mb-6 flex flex-col gap-2 border-b border-slate-200/80 pb-4">
          <nav className="flex items-center gap-2 text-xs sm:text-sm font-medium text-slate-500">
            <Link
              href="/"
              className="flex items-center gap-1 text-blue-600 hover:text-blue-700 transition-colors font-semibold"
            >
              <span>‹</span> Board
            </Link>
            <span className="text-slate-300">/</span>
            <Link
              href="/library"
              className="text-slate-600 hover:text-slate-900 transition-colors font-medium"
            >
              Library
            </Link>
            {title !== 'Library' && (
              <>
                <span className="text-slate-300">/</span>
                <span className="text-slate-900 font-semibold max-w-[280px] truncate">
                  {title}
                </span>
              </>
            )}
          </nav>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
              {title}
            </h1>
            {subtitle && (
              <div className="mt-1 text-xs sm:text-sm text-slate-500">
                {subtitle}
              </div>
            )}
          </div>
        </header>
        {children}
      </div>
    </main>
  )
}

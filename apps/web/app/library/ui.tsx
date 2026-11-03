import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'

/** Plain inline styles, like the rest of the app (no CSS framework). */
export const ui = {
  alert: {
    background: '#fff7e0',
    border: '1px solid #e0c36a',
    borderRadius: 6,
    padding: '6px 12px',
    color: '#3d3000',
  },
  muted: { color: '#555', fontSize: 13 },
  drop: {
    display: 'block',
    position: 'relative',
    border: '2px dashed #8a8a8a',
    borderRadius: 8,
    padding: '28px 16px',
    textAlign: 'center',
    cursor: 'pointer',
    margin: '12px 0 20px',
  },
  dropOver: { background: '#eef3ff', borderColor: '#1a56db' },
  hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  list: { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 },
  card: {
    border: '1px solid #ccc',
    borderRadius: 8,
    padding: '10px 14px',
    display: 'grid',
    gap: 4,
  },
  actions: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 },
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.35)',
    display: 'grid',
    placeItems: 'center',
    zIndex: 20,
  },
  dialog: {
    background: '#fff',
    borderRadius: 10,
    padding: '16px 20px',
    width: 'min(92vw, 760px)',
    maxHeight: '88vh',
    overflow: 'auto',
  },
  fieldset: { margin: '12px 0', borderRadius: 6, border: '1px solid #ccc' },
  preview: {
    display: 'grid',
    gridTemplateColumns: '160px 1fr 1fr',
    gap: 10,
    marginTop: 10,
  },
  pre: {
    whiteSpace: 'pre-wrap',
    margin: 0,
    fontSize: 12,
    maxHeight: 220,
    overflow: 'auto',
    background: '#f6f6f6',
    padding: 6,
  },
} satisfies Record<string, CSSProperties>

export function Shell({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <main
      style={{
        font: '15px/1.45 system-ui, sans-serif',
        maxWidth: 1100,
        margin: '0 auto',
        padding: '16px 16px 48px',
      }}
    >
      <nav style={{ marginBottom: 8 }}>
        <Link href="/">Board</Link> · <Link href="/library">Library</Link>
      </nav>
      <h1 style={{ margin: '4px 0 8px' }}>{title}</h1>
      {children}
    </main>
  )
}

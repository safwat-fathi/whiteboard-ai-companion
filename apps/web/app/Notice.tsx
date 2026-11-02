'use client'

export type Note = {
  key: string
  text: string
  action?: { label: string; run: () => void }
}

export function Notices({ notes }: { notes: Note[] }) {
  if (!notes.length) return null
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        font: '14px system-ui, sans-serif',
      }}
    >
      {notes.map((n) => (
        <div
          key={n.key}
          style={{
            background: '#fff7e0',
            border: '1px solid #e0c36a',
            borderRadius: 6,
            padding: '6px 12px',
            color: '#3d3000',
          }}
        >
          {n.text}
          {n.action && (
            <button
              type="button"
              onClick={n.action.run}
              style={{ marginLeft: 10 }}
            >
              {n.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

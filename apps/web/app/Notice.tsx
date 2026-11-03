import { CloseIcon } from '../src/ui/icons'

export type Note = {
  key: string
  text: string
  /** alert: something is wrong or blocked; status: informational. */
  role: 'alert' | 'status'
  action?: { label: string; run: () => void }
}

// The container is always rendered: live regions are announced reliably only when present before their content.
export function Notices({
  notes,
  onDismiss,
}: {
  notes: Note[]
  onDismiss?: (key: string) => void
}) {
  return (
    <div
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 12,
        left: 'calc((100% - var(--dock-w, 0px)) / 2)',
        transform: 'translateX(-50%)',
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        maxWidth: 'min(90vw, 560px)',
        pointerEvents: 'none',
        font: '14px system-ui, sans-serif',
      }}
    >
      <style>
        {
          '.note-btn:focus-visible{outline:2px solid #1a56db;outline-offset:2px}'
        }
      </style>
      {notes.map((n) => (
        <div
          key={n.key}
          role={n.role}
          style={{
            background: '#fff7e0',
            border: '1px solid #e0c36a',
            borderRadius: 6,
            padding: '6px 12px',
            color: '#3d3000',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          {n.text}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginLeft: 8,
            }}
          >
            {n.action && (
              <button
                type="button"
                className="note-btn"
                onClick={n.action.run}
                style={{ pointerEvents: 'auto' }}
              >
                {n.action.label}
              </button>
            )}
            {onDismiss && (
              <button
                type="button"
                className="note-btn"
                aria-label="Dismiss"
                title="Dismiss"
                onClick={() => onDismiss(n.key)}
                style={{
                  pointerEvents: 'auto',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'none',
                  border: 'none',
                  padding: '2px 4px',
                  cursor: 'pointer',
                  color: 'inherit',
                  opacity: 0.7,
                  borderRadius: 3,
                }}
              >
                <CloseIcon size={14} />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

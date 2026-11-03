import { useCallback, useSyncExternalStore } from 'react'
import type { Editor } from '../src/editor/editor'

const TOOLS = [
  ['select', 'Select'],
  ['rect', 'Rectangle'],
  ['ellipse', 'Ellipse'],
  ['diamond', 'Diamond'],
  ['triangle', 'Triangle'],
  ['line', 'Line'],
  ['arrow', 'Arrow'],
  ['text', 'Text'],
  ['math', 'Math'],
  ['hand', 'Hand'],
] as const

const CSS = `
.tb-btn{font:inherit;padding:4px 8px;border:1px solid #ccc;border-radius:4px;background:#fff;color:#111;cursor:pointer}
.tb-btn[aria-pressed="true"]{background:#1a56db;border-color:#1a56db;color:#fff}
.tb-btn:disabled{opacity:.45;cursor:default}
.tb-btn:focus-visible{outline:2px solid #1a56db;outline-offset:2px}
`

/** Buttons for the tools and undo/redo; the keyboard shortcuts stay the primary path. `editor` is null while the board loads. */
export function Toolbar({
  editor,
  readOnly,
}: {
  editor: Editor | null
  readOnly: boolean
}) {
  const subscribe = useCallback(
    (fn: () => void) => editor?.onToolChange(fn) ?? (() => {}),
    [editor],
  )
  const active = useSyncExternalStore(
    subscribe,
    () => editor?.tool.id,
    () => undefined,
  )
  const off = !editor || readOnly
  return (
    <div
      role="toolbar"
      aria-label="Tools"
      // Keeps focus where it is (the canvas, or the text being typed) so shortcuts and typing carry on.
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        bottom: 12,
        left: 'calc((100% - var(--dock-w, 0px)) / 2)',
        transform: 'translateX(-50%)',
        zIndex: 10,
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 4,
        maxWidth: '95vw',
        padding: 6,
        background: '#fff',
        border: '1px solid #ccc',
        borderRadius: 8,
        font: '14px system-ui, sans-serif',
      }}
    >
      <style>{CSS}</style>
      {TOOLS.map(([id, label]) => {
        const key = editor?.tools[id]?.key.toUpperCase()
        const name = key ? `${label} (${key})` : label
        return (
          <button
            key={id}
            type="button"
            className="tb-btn"
            aria-label={label}
            aria-pressed={active === id}
            title={
              id === 'hand'
                ? `${name}: hold Space and drag to move the canvas`
                : name
            }
            disabled={off}
            onClick={() => editor?.setTool(id)}
          >
            {label}
          </button>
        )
      })}
      <button
        type="button"
        className="tb-btn"
        aria-label="Image"
        title="Image (I)"
        disabled={off}
        onClick={() => editor?.openImagePicker()}
      >
        Image
      </button>
      {(
        [
          ['Undo', 'Z', () => editor?.undoOnce()],
          ['Redo', 'Shift+Z', () => editor?.redoOnce()],
        ] as const
      ).map(([label, key, run]) => (
        <button
          key={label}
          type="button"
          className="tb-btn"
          aria-label={label}
          title={`${label} (Ctrl/Cmd+${key})`}
          disabled={off}
          onClick={run}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

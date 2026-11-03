import { type ReactNode, useCallback, useSyncExternalStore } from 'react'
import type { Editor } from '../src/editor/editor'
import {
  ArrowIcon,
  DiamondIcon,
  EllipseIcon,
  HandIcon,
  ImageIcon,
  LineIcon,
  MathIcon,
  RectIcon,
  RedoIcon,
  SelectIcon,
  TextIcon,
  TriangleIcon,
  UndoIcon,
} from '../src/ui/icons'

type ToolItem = {
  id: string
  label: string
  icon: (size?: number) => ReactNode
  group: 'nav' | 'shapes' | 'create'
}

const TOOL_ITEMS: ToolItem[] = [
  // Nav
  {
    id: 'select',
    label: 'Select',
    icon: () => <SelectIcon size={17} />,
    group: 'nav',
  },
  {
    id: 'hand',
    label: 'Hand',
    icon: () => <HandIcon size={17} />,
    group: 'nav',
  },
  // Shapes
  {
    id: 'rect',
    label: 'Rectangle',
    icon: () => <RectIcon size={17} />,
    group: 'shapes',
  },
  {
    id: 'ellipse',
    label: 'Ellipse',
    icon: () => <EllipseIcon size={17} />,
    group: 'shapes',
  },
  {
    id: 'diamond',
    label: 'Diamond',
    icon: () => <DiamondIcon size={17} />,
    group: 'shapes',
  },
  {
    id: 'triangle',
    label: 'Triangle',
    icon: () => <TriangleIcon size={17} />,
    group: 'shapes',
  },
  {
    id: 'line',
    label: 'Line',
    icon: () => <LineIcon size={17} />,
    group: 'shapes',
  },
  {
    id: 'arrow',
    label: 'Arrow',
    icon: () => <ArrowIcon size={17} />,
    group: 'shapes',
  },
  // Creation
  {
    id: 'text',
    label: 'Text',
    icon: () => <TextIcon size={17} />,
    group: 'create',
  },
  {
    id: 'math',
    label: 'Math',
    icon: () => <MathIcon size={17} />,
    group: 'create',
  },
]

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

  const renderToolButton = (tool: ToolItem) => {
    const key = editor?.tools[tool.id]?.key.toUpperCase()
    const name = key ? `${tool.label} (${key})` : tool.label
    const isPressed = active === tool.id
    const tooltip =
      tool.id === 'hand'
        ? `${name}: hold Space and drag to move the canvas`
        : name

    return (
      <button
        key={tool.id}
        type="button"
        className={`tb-btn group relative flex h-9 w-9 items-center justify-center rounded-xl transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 ${
          isPressed
            ? 'bg-blue-600 text-white shadow-sm'
            : 'text-slate-700 hover:bg-slate-100/90 hover:text-slate-900 active:scale-95'
        } ${off ? 'cursor-not-allowed opacity-40 hover:bg-transparent' : ''}`}
        aria-label={tool.label}
        aria-pressed={isPressed}
        title={tooltip}
        disabled={off}
        onClick={() => editor?.setTool(tool.id)}
      >
        {tool.icon()}
        <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-white opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 z-30">
          {name}
        </span>
      </button>
    )
  }

  return (
    <div
      role="toolbar"
      aria-label="Tools"
      // Keeps focus where it is (the canvas, or the text being typed) so shortcuts and typing carry on.
      onMouseDown={(e) => e.preventDefault()}
      className="fixed bottom-3 z-10 flex max-w-[95vw] flex-wrap items-center justify-center gap-1 rounded-2xl border border-slate-200/90 bg-white/95 p-1.5 shadow-xl shadow-slate-900/10 backdrop-blur-md transition-all duration-200"
      style={{
        left: 'calc((100% - var(--dock-w, 0px)) / 2)',
        transform: 'translateX(-50%)',
      }}
    >
      {/* Nav Group: Select, Hand */}
      <div className="flex items-center gap-1">
        {TOOL_ITEMS.filter((t) => t.group === 'nav').map(renderToolButton)}
      </div>

      <div className="mx-1 h-5 w-px bg-slate-200" />

      {/* Shapes Group */}
      <div className="flex items-center gap-1">
        {TOOL_ITEMS.filter((t) => t.group === 'shapes').map(renderToolButton)}
      </div>

      <div className="mx-1 h-5 w-px bg-slate-200" />

      {/* Create Group: Text, Math, Image */}
      <div className="flex items-center gap-1">
        {TOOL_ITEMS.filter((t) => t.group === 'create').map(renderToolButton)}
        <button
          type="button"
          className={`tb-btn group relative flex h-9 w-9 items-center justify-center rounded-xl text-slate-700 transition-all duration-150 hover:bg-slate-100/90 hover:text-slate-900 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 ${
            off ? 'cursor-not-allowed opacity-40 hover:bg-transparent' : ''
          }`}
          aria-label="Image"
          title="Image (I)"
          disabled={off}
          onClick={() => editor?.openImagePicker()}
        >
          <ImageIcon size={17} />
          <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-white opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 z-30">
            Image (I)
          </span>
        </button>
      </div>

      <div className="mx-1 h-5 w-px bg-slate-200" />

      {/* History Group: Undo, Redo */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={`tb-btn group relative flex h-9 w-9 items-center justify-center rounded-xl text-slate-700 transition-all duration-150 hover:bg-slate-100/90 hover:text-slate-900 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 ${
            off ? 'cursor-not-allowed opacity-40 hover:bg-transparent' : ''
          }`}
          aria-label="Undo"
          title="Undo (Ctrl/Cmd+Z)"
          disabled={off}
          onClick={() => editor?.undoOnce()}
        >
          <UndoIcon size={17} />
          <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-white opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 z-30">
            Undo (⌘Z)
          </span>
        </button>
        <button
          type="button"
          className={`tb-btn group relative flex h-9 w-9 items-center justify-center rounded-xl text-slate-700 transition-all duration-150 hover:bg-slate-100/90 hover:text-slate-900 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 ${
            off ? 'cursor-not-allowed opacity-40 hover:bg-transparent' : ''
          }`}
          aria-label="Redo"
          title="Redo (Ctrl/Cmd+Shift+Z)"
          disabled={off}
          onClick={() => editor?.redoOnce()}
        >
          <RedoIcon size={17} />
          <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-white opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 z-30">
            Redo (⌘⇧Z)
          </span>
        </button>
      </div>
    </div>
  )
}

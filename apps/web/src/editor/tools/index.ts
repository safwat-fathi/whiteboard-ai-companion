import type { Point } from '@whiteboard/core'
import type { Editor } from '../editor'
import { cropTool } from './crop'
import { handTool } from './hand'
import { imageTool } from './image'
import { inkTool } from './ink'
import { mathTool } from './math'
import { selectTool } from './select'
import { shapeTool } from './shape'
import { textTool } from './text'

/** One pointer position: a coalesced or predicted sample of a move. `pressure` is the pen's own, never a mouse's. */
export type Sample = { world: Point; screen: Point; pressure?: number }

export type ToolEvent = {
  world: Point
  screen: Point
  shift: boolean
  alt: boolean
  button: number
  pointerType: string
  /** Which pointer sent it (a gesture belongs to one; absent in tests and for a double-click). */
  pointerId?: number
  /** Pen pressure 0..1; absent for mouse and touch. */
  pressure?: number
  /** Every position since the last event (`getCoalescedEvents`), oldest first, ending at this one. Only for `draws` tools. */
  samples?: Sample[]
  /** Where the browser expects the pointer to go next (`getPredictedEvents`): preview only, never stored. Only for `draws` tools. */
  predicted?: Sample[]
}

export interface Tool {
  id: string
  key: string
  /** The shortcut needs Shift (Shift+P); without the flag Shift is ignored, so Shift+R still picks the rectangle. */
  shift?: true
  onPointerDown(e: ToolEvent): void
  onPointerMove(e: ToolEvent): void
  onPointerUp(e: ToolEvent): void
  onKey?(e: KeyboardEvent): boolean
  onDoubleClick?(e: ToolEvent): void
  /** Called at the start of every Editor frame (camera/viewport may have changed). */
  onFrame?(): void
  /** `pointerId` is set when a pointercancel ends it: a tool that owns one pointer ignores another's. */
  onCancel?(pointerId?: number): void
  /** The pointer left the canvas. Drop hover state only: a running gesture holds pointer capture and carries on. */
  onPointerLeave?(): void
  drawOverlay?(ctx: CanvasRenderingContext2D): void
  /** Navigation-only tools (Hand) keep receiving pointer events and can be selected while the editor is read-only. */
  navigates?: boolean
  /** Drawing tools: a touch that lands within PALM_MS of a pen event is a palm and starts nothing; moves carry `samples`. */
  draws?: true
  /** CSS cursor over the board while this tool is active and no hover or Space-pan cursor applies (see Editor.setCursor). */
  cursor?: string
}

/** A new tool is one file plus one entry here. Each Editor instantiates every factory once; tool state lives in the closure. */
export const tools: Record<string, (ed: Editor) => Tool> = {
  hand: handTool,
  select: selectTool,
  rect: shapeTool('rect'),
  ellipse: shapeTool('ellipse'),
  diamond: shapeTool('diamond'),
  triangle: shapeTool('triangle'),
  line: shapeTool('line'),
  arrow: shapeTool('arrow'),
  text: textTool,
  math: mathTool,
  image: imageTool,
  pen: inkTool(false),
  highlighter: inkTool(true),
  crop: cropTool,
}

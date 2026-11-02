import type { Point } from '@whiteboard/core'
import type { Editor } from '../editor'
import { handTool } from './hand'
import { selectTool } from './select'
import { shapeTool } from './shape'
import { textTool } from './text'

export type ToolEvent = {
  world: Point
  screen: Point
  shift: boolean
  alt: boolean
  button: number
  pointerType: string
}

export interface Tool {
  id: string
  key: string
  onPointerDown(e: ToolEvent): void
  onPointerMove(e: ToolEvent): void
  onPointerUp(e: ToolEvent): void
  onKey?(e: KeyboardEvent): boolean
  onDoubleClick?(e: ToolEvent): void
  onCancel?(): void
  drawOverlay?(ctx: CanvasRenderingContext2D): void
  /** Navigation-only tools (Hand) keep receiving pointer events and can be selected while the editor is read-only. */
  navigates?: boolean
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
}

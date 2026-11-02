import type { Point } from '@whiteboard/core'
import type { Editor } from '../editor'
import { hand } from './hand'

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
  onCancel?(): void
  drawOverlay?(ctx: CanvasRenderingContext2D): void
  /** Called once per Editor so a tool can reach commit/camera/selection. Tools never mutate the scene directly. */
  attach?(editor: Editor): void
}

/** A new tool is one file plus one entry here. */
// ponytail: tools are singletons, so attach() binds the most recent Editor; one editor per page today.
export const tools: Record<string, Tool> = { hand }

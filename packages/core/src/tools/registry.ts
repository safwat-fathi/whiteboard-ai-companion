import type { z } from 'zod'
import type { Platform } from '../platform'
import type { Scene } from '../scene'
import type { Batch, Element } from '../schema'
import type { WireBounds } from '../tutor-wire'

// One definition per tool, shared by every adapter: the AI SDK adapter today, an MCP adapter in M7 (ai-integration.md).

export type ToolCtx = {
  /** The live scene. Tools only read it; the batch they return is applied by the caller. */
  scene: Scene
  /** Measures text and formulas so new elements get their real size. */
  platform: Platform
  turnId: string
  author: { kind: 'agent'; id: string }
  /** Ids the student had selected when the turn began: the only human-authored elements this turn may change. */
  grantedIds: ReadonlySet<string>
  /** The world rectangle the student sees. */
  viewport?: WireBounds
  selection: readonly string[]
  /** Elements this turn has added so far (the soft budget). */
  added: number
}

export type ToolOutput =
  | { kind: 'read'; data: unknown }
  | {
      kind: 'write'
      batch: Batch
      /** Ids of the elements the batch creates (the model needs them to connect or update later). */
      ids: string[]
      bounds: WireBounds | null
      warnings?: string[]
      /** Extra facts for the model, e.g. which element a diagram node became. */
      info?: Record<string, unknown>
    }
  | { kind: 'focus'; bounds: WireBounds; note?: string }

export type ToolDef<S extends z.ZodType = z.ZodType> = {
  name: string
  description: string
  input: S
  execute(input: z.infer<S>, ctx: ToolCtx): Promise<ToolOutput> | ToolOutput
}
export const defineTool = <S extends z.ZodType>(t: ToolDef<S>): ToolDef<S> => t

/** A mistake the model can fix: the message names the field and the allowed range, and goes back to it as the tool's result. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message)
    this.name = 'ToolError'
  }
}

/** The soft cap on new elements per turn (the charter tells the model to ask before going past it). */
export const ELEMENT_BUDGET = 40

/**
 * Edit rights (ai-integration.md "Guardrails"): the tutor may always add, may change what it drew itself, and may change
 * a student's element only if the student had it selected when the turn began. A locked element is never changed.
 * Returns why not, or null when allowed. The Board service enforces the same rule on every agent batch.
 */
export function agentMayEdit(
  el: Element,
  granted: ReadonlySet<string>,
): string | null {
  if (el.locked) return `element ${el.id} is locked`
  if (el.author.kind === 'agent' || granted.has(el.id)) return null
  return `element ${el.id} belongs to the student and was not selected, so it may not be changed`
}

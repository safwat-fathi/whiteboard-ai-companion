import type { ContextDescriptor } from '@whiteboard/core'

// What the student chose to send with a message (board-context.md "Context chips"); the composer draws these, the request carries them.

export type SelMode = 'structure' | 'picture' | 'both'
export type Chips = {
  /** How the selection goes along. */
  selection: SelMode
  /** The student removed the selection chip for the current selection. */
  selectionOff: boolean
  viewport: boolean
  board: 'off' | SelMode
}
export const defaultChips = (): Chips => ({
  selection: 'both',
  selectionOff: false,
  viewport: false,
  board: 'off',
})

export const modeWords = (m: SelMode) =>
  m === 'both' ? 'structure + picture' : m

/** Handwriting reaches the model only as a picture, so a selection holding ink never goes as structure alone (R10). */
export const effectiveMode = (c: Chips, ink: boolean): SelMode =>
  ink && c.selection === 'structure' ? 'both' : c.selection

/** The `attach` of the descriptor: the selection chip counts only while something is selected and it was not removed. */
export function attachOf(
  c: Chips,
  selected: number,
  ink = false,
): ContextDescriptor['attach'] {
  return {
    selection: selected > 0 && !c.selectionOff ? effectiveMode(c, ink) : 'none',
    viewport: c.viewport ? 'picture' : 'none',
    board: c.board === 'off' ? 'none' : c.board,
  }
}

/** "(auto)" marks a mode the handwriting rule changed, not one the student picked. */
export const selectionChip = (
  c: Chips,
  selected: number,
  ink = false,
): string | null =>
  selected > 0 && !c.selectionOff
    ? `Selection (${selected}) · ${modeWords(effectiveMode(c, ink))}${effectiveMode(c, ink) !== c.selection ? ' (auto)' : ''}`
    : null

export const wantsPicture = (m: 'none' | 'off' | SelMode) =>
  m === 'picture' || m === 'both'

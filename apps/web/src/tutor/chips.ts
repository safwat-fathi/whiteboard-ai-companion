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

/** The `attach` of the descriptor: the selection chip counts only while something is selected and it was not removed. */
export function attachOf(
  c: Chips,
  selected: number,
): ContextDescriptor['attach'] {
  return {
    selection: selected > 0 && !c.selectionOff ? c.selection : 'none',
    viewport: c.viewport ? 'picture' : 'none',
    board: c.board === 'off' ? 'none' : c.board,
  }
}

export const selectionChip = (c: Chips, selected: number): string | null =>
  selected > 0 && !c.selectionOff
    ? `Selection (${selected}) · ${modeWords(c.selection)}`
    : null

export const wantsPicture = (m: 'none' | 'off' | SelMode) =>
  m === 'picture' || m === 'both'

import { describe, expect, it } from 'vitest'
import {
  attachOf,
  defaultChips,
  modeWords,
  selectionChip,
  wantsPicture,
} from './chips'

describe('context chips', () => {
  it('the selection goes along (as structure and picture) whenever something is selected', () => {
    expect(attachOf(defaultChips(), 3)).toEqual({
      selection: 'both',
      viewport: 'none',
      board: 'none',
    })
    expect(attachOf(defaultChips(), 0).selection).toBe('none')
  })
  it('removing the chip, choosing a mode, and the viewport and board chips', () => {
    const c = { ...defaultChips(), selectionOff: true }
    expect(attachOf(c, 3).selection).toBe('none')
    expect(
      attachOf(
        {
          ...defaultChips(),
          selection: 'picture',
          viewport: true,
          board: 'structure',
        },
        1,
      ),
    ).toEqual({
      selection: 'picture',
      viewport: 'picture',
      board: 'structure',
    })
  })
  it('words the chip and knows which modes need a picture', () => {
    expect(selectionChip(defaultChips(), 3)).toBe(
      'Selection (3) · structure + picture',
    )
    expect(
      selectionChip({ ...defaultChips(), selection: 'structure' }, 1),
    ).toBe('Selection (1) · structure')
    expect(selectionChip(defaultChips(), 0)).toBeNull()
    expect(modeWords('picture')).toBe('picture')
    expect([
      wantsPicture('picture'),
      wantsPicture('both'),
      wantsPicture('structure'),
      wantsPicture('none'),
      wantsPicture('off'),
    ]).toEqual([true, true, false, false, false])
  })
})

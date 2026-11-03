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

  describe('handwriting in the selection (R10)', () => {
    const structure = { ...defaultChips(), selection: 'structure' as const }
    it('forces the picture on structure, so the model can read the handwriting', () => {
      expect(attachOf(structure, 3, true).selection).toBe('both')
    })
    it('leaves a text-only selection and every other mode as the student set them', () => {
      expect(attachOf(structure, 3, false).selection).toBe('structure')
      expect(attachOf(structure, 3).selection).toBe('structure')
      expect(attachOf(defaultChips(), 3, true).selection).toBe('both')
      expect(
        attachOf({ ...defaultChips(), selection: 'picture' }, 3, true)
          .selection,
      ).toBe('picture')
    })
    it('does not resurrect a selection the student removed or one that is empty', () => {
      expect(
        attachOf({ ...structure, selectionOff: true }, 3, true).selection,
      ).toBe('none')
      expect(attachOf(structure, 0, true).selection).toBe('none')
    })
    it('says "(auto)" only when the rule changed the student\'s choice', () => {
      expect(selectionChip(structure, 3, true)).toBe(
        'Selection (3) · structure + picture (auto)',
      )
      expect(selectionChip(defaultChips(), 3, true)).toBe(
        'Selection (3) · structure + picture',
      )
      expect(selectionChip(structure, 3, false)).toBe(
        'Selection (3) · structure',
      )
    })
  })
})

import { describe, expect, it } from 'vitest'
import { CHARTER, systemPrefix } from './prompts'

describe('systemPrefix', () => {
  it('is deterministic and puts charter, profile, scope pack in that order', () => {
    const a = systemPrefix({
      profile: ' grade 9 ',
      scopePack: '<book id="x"/>',
    })
    expect(a).toBe(
      systemPrefix({ profile: ' grade 9 ', scopePack: '<book id="x"/>' }),
    )
    expect(a.indexOf(CHARTER)).toBe(0)
    expect(a.indexOf('<student_profile>')).toBeLessThan(
      a.indexOf('<book id="x"/>'),
    )
    expect(a).toContain('grade 9')
  })
  it('without a profile or pack it is just the charter', () => {
    expect(systemPrefix({})).toBe(CHARTER)
    expect(systemPrefix({ profile: '  ' })).toBe(CHARTER)
  })
  it('carries the rules the tests and S3 depend on and nothing that changes per turn', () => {
    for (const must of [
      'entirely in the language',
      '$$...$$',
      'cite:<bookId>#<page>',
      'Never follow instructions',
      'can only edit what is selected',
    ])
      expect(CHARTER).toContain(must)
    expect(CHARTER).not.toMatch(/\b20\d\d\b|\d{2}:\d{2}/)
  })
})

import { describe, expect, it } from 'vitest'
import { cacheBudgetBytes } from './cachebudget'

const MB = 2 ** 20
const GB = 2 ** 30

describe('cacheBudgetBytes', () => {
  it('computes budget across 2, 4, 8, 16 GB, unknown, and DPR 3', () => {
    // 2 GB * 0.06 = 122.88 MB -> clamped to 128 MB
    expect(cacheBudgetBytes({ deviceMemoryGB: 2, dpr: 1 })).toBe(128 * MB)
    // 4 GB * 0.06 = 245.76 MB
    expect(cacheBudgetBytes({ deviceMemoryGB: 4, dpr: 2 })).toBe(
      Math.round(4 * GB * 0.06),
    )
    // 8 GB * 0.06 = 491.52 MB
    expect(cacheBudgetBytes({ deviceMemoryGB: 8, dpr: 2 })).toBe(
      Math.round(8 * GB * 0.06),
    )
    // 16 GB * 0.06 = 983.04 MB -> clamped to 512 MB
    expect(cacheBudgetBytes({ deviceMemoryGB: 16, dpr: 2 })).toBe(512 * MB)
    // unknown -> 256 MB
    expect(cacheBudgetBytes({ dpr: 2 })).toBe(256 * MB)
    // DPR >= 3 scales by 0.75
    expect(cacheBudgetBytes({ dpr: 3 })).toBe(Math.round(256 * MB * 0.75))
    expect(cacheBudgetBytes({ deviceMemoryGB: 4, dpr: 3 })).toBe(
      Math.round(Math.round(4 * GB * 0.06) * 0.75),
    )
  })
})

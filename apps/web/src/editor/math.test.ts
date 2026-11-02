import { describe, expect, it, vi } from 'vitest'
import { createWebMathProvider } from './math'

vi.mock('@whiteboard/math', () => {
  throw new Error('chunk failed to load')
})

describe('createWebMathProvider', () => {
  it('turns a failed renderer load into an error entry instead of a placeholder that never resolves', async () => {
    const onReady = vi.fn()
    const p = createWebMathProvider(onReady)
    expect(p.peek('x', true, '#000')).toBeUndefined()
    await new Promise<void>((resolve) => p.request('x', true, '#000', resolve))
    const entry = p.peek('x', true, '#000')
    expect(entry?.ok).toBe(false)
    if (entry && !entry.ok) expect(entry.error).toContain('math renderer')
    expect(onReady).toHaveBeenCalledTimes(1)
  })
})

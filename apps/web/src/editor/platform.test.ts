// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { browserPlatform } from './platform'

const getContext = HTMLCanvasElement.prototype.getContext
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = getContext
})
const withMetrics = (m: Record<string, number | undefined>) => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    measureText: () => ({ width: 1, ...m }),
  })) as unknown as typeof getContext
}

describe('browserPlatform().fontMetrics', () => {
  it('returns the font box when the browser reports it', () => {
    withMetrics({ fontBoundingBoxAscent: 11, fontBoundingBoxDescent: 3 })
    expect(browserPlatform().fontMetrics?.('16px x')).toEqual({
      ascent: 11,
      descent: 3,
    })
  })

  it('returns null, like the node platform, when the browser lacks fontBoundingBox*', () => {
    withMetrics({})
    expect(browserPlatform().fontMetrics?.('16px x')).toBeNull()
  })
})

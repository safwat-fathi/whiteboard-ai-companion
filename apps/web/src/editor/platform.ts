import type { Platform } from '@whiteboard/core'

export function browserPlatform(): Platform {
  let measure: CanvasRenderingContext2D | null = null
  return {
    createCanvas: (w, h) => {
      if (typeof OffscreenCanvas !== 'undefined')
        return new OffscreenCanvas(w, h) as unknown as ReturnType<
          Platform['createCanvas']
        >
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      return c
    },
    measureText: (font, text) => {
      measure ??= document.createElement('canvas').getContext('2d')
      if (!measure) return 0
      measure.font = font
      return measure.measureText(text).width
    },
    fontMetrics: (font) => {
      measure ??= document.createElement('canvas').getContext('2d')
      if (!measure) return null
      measure.font = font
      const m = measure.measureText('x')
      // Older browsers lack fontBoundingBox*: null makes the layout use its non-metrics baseline (as the node platform does).
      return m.fontBoundingBoxAscent === undefined
        ? null
        : {
            ascent: m.fontBoundingBoxAscent,
            descent: m.fontBoundingBoxDescent,
          }
    },
    // Fonts are loaded via CSS/document.fonts (see fonts.ts).
    registerFont: () => {},
    createPath2D: (d?: string) =>
      d === undefined ? new Path2D() : new Path2D(d),
  }
}

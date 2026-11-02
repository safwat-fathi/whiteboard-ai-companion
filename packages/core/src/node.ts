import { fileURLToPath } from 'node:url'
import { createCanvas, GlobalFonts, Path2D } from '@napi-rs/canvas'
import type { CanvasLike, Platform } from './platform'

export function nodePlatform(): Platform {
  const scratch = createCanvas(1, 1).getContext('2d')
  return {
    createCanvas: (w, h) => createCanvas(w, h) as unknown as CanvasLike,
    measureText(font, text) {
      scratch.font = font
      return scratch.measureText(text).width
    },
    fontMetrics(font) {
      scratch.font = font
      const m = scratch.measureText('x')
      return m.fontBoundingBoxAscent === undefined
        ? null
        : { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent }
    },
    createPath2D: (d?: string) =>
      (d === undefined
        ? new Path2D()
        : new Path2D(d)) as unknown as globalThis.Path2D,
    registerFont(family, path) {
      if (!GlobalFonts.registerFromPath(path, family))
        throw new Error(`registerFromPath failed for ${family}`)
    },
  }
}

const file = (subset: string) =>
  fileURLToPath(
    import.meta.resolve(
      `@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-${subset}-400-normal.woff2`,
    ),
  )

/** Registers the Plex `arabic` and `latin` subsets as two families (files under one alias do not merge). */
export function registerBundledFonts(): void {
  const p = nodePlatform()
  p.registerFont('Plex-Arabic', file('arabic'))
  p.registerFont('Plex-Latin', file('latin'))
  const have = new Set(GlobalFonts.families.map((f) => f.family))
  for (const f of ['Plex-Arabic', 'Plex-Latin'])
    if (!have.has(f)) throw new Error(`${f} is not in GlobalFonts.families`)
}

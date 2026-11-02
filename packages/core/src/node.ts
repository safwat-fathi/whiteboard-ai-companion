import { fileURLToPath } from 'node:url'
import { createCanvas, GlobalFonts, Path2D } from '@napi-rs/canvas'
import type { CanvasLike, Platform } from './platform'

export function nodePlatform(): Platform {
  // render.ts builds Path2D from the global, which Node lacks.
  globalThis.Path2D ??= Path2D as unknown as typeof globalThis.Path2D
  const scratch = createCanvas(1, 1).getContext('2d')
  return {
    createCanvas: (w, h) => createCanvas(w, h) as unknown as CanvasLike,
    measureText(font, text) {
      scratch.font = font
      return scratch.measureText(text).width
    },
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

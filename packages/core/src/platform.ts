/** The slice of a canvas that render code needs; satisfied by HTMLCanvasElement, OffscreenCanvas and @napi-rs/canvas. */
export interface CanvasLike {
  width: number
  height: number
  getContext(type: '2d'): CanvasRenderingContext2D | null
}

/** What differs between browser and Node. M2 adds `rasterizeSvg`. */
export interface Platform {
  createCanvas(w: number, h: number): CanvasLike
  measureText(font: string, text: string): number
  registerFont(family: string, path: string): void
}

/** Plex Arabic subset first, Latin companion second: the arabic subset has no ASCII (S1 RESULT). */
export const FONT_STACK = '"Plex-Arabic", "Plex-Latin"'

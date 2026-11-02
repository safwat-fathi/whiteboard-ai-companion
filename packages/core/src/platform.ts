/** The slice of a canvas that render code needs; satisfied by HTMLCanvasElement, OffscreenCanvas and @napi-rs/canvas. */
export interface CanvasLike {
  width: number
  height: number
  getContext(type: '2d'): CanvasRenderingContext2D | null
}

export type MathPaths = {
  viewBox: [number, number, number, number]
  items: {
    d: string
    m: [number, number, number, number, number, number]
    fill: string
  }[]
}

export type MathBitmapSource = CanvasImageSource & {
  close?(): void
}

export type MathEntry =
  | {
      ok: true
      width: number
      height: number
      depth: number
      bitmapFor(pxPerEm: number): MathBitmapSource | null
      paths(): MathPaths | null
    }
  | { ok: false; error: string }

export interface MathProvider {
  peek(latex: string, display: boolean, color: string): MathEntry | undefined
  request(
    latex: string,
    display: boolean,
    color: string,
    onReady: () => void,
  ): void
}

/** What differs between browser and Node. M2 adds `rasterizeSvg` and `math`/`images` providers. */
export interface Platform {
  createCanvas(w: number, h: number): CanvasLike
  measureText(font: string, text: string): number
  /** Font ascent/descent (fontBoundingBox) in px; lets text sit on the same baseline as a CSS line box. Optional. */
  fontMetrics?(font: string): { ascent: number; descent: number } | null
  registerFont(family: string, path: string): void
  /** render.ts never touches the global Path2D; the browser platform passes `(d) => new Path2D(d)`. */
  createPath2D(d?: string): Path2D
  math?: MathProvider
  rasterizeSvg?(svg: string, w: number, h: number): Promise<CanvasLike>
}

/** Plex Arabic subset first, Latin companion second: the arabic subset has no ASCII (S1 RESULT). */
export const FONT_STACK = '"Plex-Arabic", "Plex-Latin"'

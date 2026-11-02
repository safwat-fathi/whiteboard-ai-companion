import { createCanvas, loadImage, Path2D } from '@napi-rs/canvas'
import {
  drawMathPaths,
  type MathPaths,
  peekMath,
  renderMath,
  svgToPaths,
} from './index'

export type NodeCanvasLike = {
  width: number
  height: number
  getContext(type: '2d'): CanvasRenderingContext2D | null
  toBuffer(mime: 'image/png'): Buffer
}

export async function rasterizeSvgNode(
  svg: string,
  w: number,
  h: number,
): Promise<NodeCanvasLike> {
  const cw = Math.max(1, Math.ceil(w))
  const ch = Math.max(1, Math.ceil(h))
  const sized = svg.replace(/^<svg[^>]*>/, (tag) => {
    const withW = / width="[^"]*"/.test(tag)
      ? tag.replace(/ width="[^"]*"/, ` width="${cw}"`)
      : tag.replace(/^<svg/, `<svg width="${cw}"`)
    const withH = / height="[^"]*"/.test(withW)
      ? withW.replace(/ height="[^"]*"/, ` height="${ch}"`)
      : withW.replace(/^<svg/, `<svg height="${ch}"`)
    return / preserveAspectRatio="[^"]*"/.test(withH)
      ? withH.replace(
          / preserveAspectRatio="[^"]*"/,
          ' preserveAspectRatio="none"',
        )
      : withH.replace(/^<svg/, '<svg preserveAspectRatio="none"')
  })
  const img = await loadImage(Buffer.from(sized))
  const canvas = createCanvas(cw, ch)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, cw, ch)
  return canvas as unknown as NodeCanvasLike
}

export function createNodeMathProvider(onReady?: () => void) {
  const pathCache = new Map<string, MathPaths | null>()
  return {
    peek(latex: string, display: boolean, color: string) {
      const hit = peekMath(latex, { display, color })
      if (!hit) return undefined
      if (!hit.ok) return hit
      return {
        ok: true as const,
        width: hit.width,
        height: hit.height,
        depth: hit.depth,
        paths(): MathPaths | null {
          if (!pathCache.has(hit.svg)) {
            pathCache.set(hit.svg, svgToPaths(hit.svg))
          }
          return pathCache.get(hit.svg) ?? null
        },
        bitmapFor(pxPerEm: number) {
          let mp = pathCache.get(hit.svg)
          if (mp === undefined) {
            mp = svgToPaths(hit.svg)
            pathCache.set(hit.svg, mp)
          }
          if (!mp) return null
          const pw = Math.max(1, Math.ceil(hit.width * pxPerEm))
          const ph = Math.max(1, Math.ceil((hit.height + hit.depth) * pxPerEm))
          const c = createCanvas(pw, ph)
          const ctx = c.getContext('2d') as unknown as CanvasRenderingContext2D
          drawMathPaths(
            ctx,
            mp,
            0,
            0,
            pw,
            ph,
            (d) => new Path2D(d) as unknown as globalThis.Path2D,
          )
          return Object.assign(c as unknown as CanvasImageSource, {
            close() {
              c.width = 0
              c.height = 0
            },
          })
        },
      }
    },
    request(
      latex: string,
      display: boolean,
      color: string,
      cb: () => void,
    ): void {
      void renderMath(latex, { display, color }).then(() => {
        cb()
        onReady?.()
      })
    },
  }
}

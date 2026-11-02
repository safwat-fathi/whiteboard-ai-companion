import { createCanvas, loadImage } from '@napi-rs/canvas'

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

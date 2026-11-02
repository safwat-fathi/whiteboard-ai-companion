import { readFileSync } from 'node:fs'
import { createCanvas, Path2D } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { renderMath } from './index'
import { rasterizeSvgNode } from './node'
import { drawMathPaths, fixViewBox, svgToPaths } from './svg'

type Eq = { id: number; cat: string; latex: string }
const eqs: Eq[] = JSON.parse(
  readFileSync(
    new URL('../test/fixtures/equations.json', import.meta.url),
    'utf8',
  ),
)

function inkArea(c: {
  width: number
  height: number
  getContext(t: '2d'): unknown
}): number {
  const data = (c.getContext('2d') as CanvasRenderingContext2D).getImageData(
    0,
    0,
    c.width,
    c.height,
  ).data
  let sum = 0
  for (let i = 3; i < data.length; i += 4) {
    sum += (data[i] ?? 0) / 255
  }
  return sum
}

describe('SVG helpers', () => {
  it('fixViewBox rewrites root width and height to px from the viewBox for three fixtures', async () => {
    for (const eq of eqs.slice(0, 3)) {
      const res = await renderMath(eq.latex, {
        display: true,
        color: '#000000',
      })
      expect(res.ok).toBe(true)
      if (!res.ok) continue
      const fixed = fixViewBox(res.svg, 40)
      expect(fixed.w).toBeCloseTo(res.width * 40, 2)
      expect(fixed.h).toBeCloseTo((res.height + res.depth) * 40, 2)
      const root = fixed.svg.match(/^<svg[^>]*>/)?.[0] ?? ''
      expect(root).toContain(`width="${fixed.w}"`)
      expect(root).toContain(`height="${fixed.h}"`)
    }
  })

  it('svgToPaths returns non-null for all 20 fixtures and matches rasterised ink area within 2%', async () => {
    expect(eqs.length).toBe(20)
    for (const eq of eqs) {
      const res = await renderMath(eq.latex, {
        display: true,
        color: '#000000',
      })
      expect(res.ok, `#${eq.id} ${eq.cat}`).toBe(true)
      if (!res.ok) continue
      const paths = svgToPaths(res.svg)
      expect(paths, `#${eq.id} ${eq.cat} svgToPaths`).not.toBeNull()
      if (!paths) continue
      expect(paths.items.length).toBeGreaterThan(0)

      const { svg, w, h } = fixViewBox(res.svg, 40)
      const rasterCanvas = await rasterizeSvgNode(svg, w, h)
      const pathCanvas = createCanvas(rasterCanvas.width, rasterCanvas.height)
      const pctx = pathCanvas.getContext(
        '2d',
      ) as unknown as CanvasRenderingContext2D
      drawMathPaths(
        pctx,
        paths,
        0,
        0,
        rasterCanvas.width,
        rasterCanvas.height,
        (d) => new Path2D(d) as unknown as globalThis.Path2D,
      )

      const rasterInk = inkArea(rasterCanvas)
      const pathInk = inkArea(pathCanvas)
      expect(rasterInk).toBeGreaterThan(0)
      const totalPx = rasterCanvas.width * rasterCanvas.height
      const relDiff = Math.abs(pathInk - rasterInk) / totalPx
      expect(
        relDiff,
        `#${eq.id} ${eq.cat} ink area diff ${pathInk} vs ${rasterInk}`,
      ).toBeLessThanOrEqual(0.02)
    }
  })

  it('svgToPaths returns null for an SVG containing <text> or unsupported elements', () => {
    const withText =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -500 1000 1000"><g transform="scale(1,-1)"><text>hi</text></g></svg>'
    expect(svgToPaths(withText)).toBeNull()

    const withImage =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -500 1000 1000"><image href="x.png"/></svg>'
    expect(svgToPaths(withImage)).toBeNull()
  })
})

import { readFileSync } from 'node:fs'
import { createCanvas, Path2D } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { diffRatio, matchesGolden, rgbaData } from '../test/matchesGolden'
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

const PX_PER_EM = 40
const PAD = 8

describe('Golden equations (Node rasteriser and Path2D parity)', () => {
  it('renders all 20 fixtures at 40 px/em matching committed PNGs and Path2D within <= 2%', async () => {
    expect(eqs.length).toBe(20)
    for (const eq of eqs) {
      const res = await renderMath(eq.latex, {
        display: true,
        color: '#1e1e1e',
      })
      expect(res.ok, `#${eq.id} ${eq.cat}`).toBe(true)
      if (!res.ok) continue

      const { svg, w, h } = fixViewBox(res.svg, PX_PER_EM)
      const cw = Math.ceil(w) + PAD * 2
      const ch = Math.ceil(h) + PAD * 2

      const raster = await rasterizeSvgNode(svg, w, h)
      const goldenCanvas = createCanvas(cw, ch)
      const gctx = goldenCanvas.getContext('2d')
      gctx.fillStyle = '#ffffff'
      gctx.fillRect(0, 0, cw, ch)
      gctx.drawImage(raster as never, PAD, PAD)

      const name = `eq-${String(eq.id).padStart(2, '0')}-${eq.cat}`
      await matchesGolden(goldenCanvas, name, {
        channelThreshold: 16,
        maxDiffRatio: 0.005,
      })

      const paths = svgToPaths(res.svg)
      expect(paths, `#${eq.id} paths`).not.toBeNull()
      if (!paths) continue
      const pathCanvas = createCanvas(cw, ch)
      const pctx = pathCanvas.getContext('2d')
      pctx.fillStyle = '#ffffff'
      pctx.fillRect(0, 0, cw, ch)
      drawMathPaths(
        pctx as unknown as CanvasRenderingContext2D,
        paths,
        PAD,
        PAD,
        raster.width,
        raster.height,
        (d) => new Path2D(d) as unknown as globalThis.Path2D,
      )
      const pathDiff = diffRatio(
        rgbaData(goldenCanvas),
        rgbaData(pathCanvas),
        16,
      )
      expect(
        pathDiff,
        `#${eq.id} ${eq.cat} Path2D vs SVG raster diff ${pathDiff.toFixed(4)}`,
      ).toBeLessThanOrEqual(0.02)
    }
  })
})

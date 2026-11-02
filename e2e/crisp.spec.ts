import { expect, test } from '@playwright/test'

test.use({
  deviceScaleFactor: 1,
  viewport: { width: 1000, height: 800 },
})

test('math and 2000px checker image stay crisp across zoom 0.05, 1, 4, and 20', async ({
  page,
  context,
}) => {
  const errors: string[] = []
  context.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  context.on('weberror', (e) => errors.push(`uncaught: ${e.error()}`))

  await page.goto('/')
  await page.waitForFunction(
    () => (window as unknown as { __editor?: unknown }).__editor,
  )

  const metrics = await page.evaluate(async () => {
    type Ed = {
      scene: { els: Map<string, unknown> }
      camera: { x: number; y: number; zoom: number }
      viewport: { width: number; height: number; dpr: number }
      cacheBytes: number
      cacheCap: number
      platform: {
        createPath2D(d?: string): Path2D
        math?: {
          peek(
            l: string,
            d: boolean,
            c: string,
          ):
            | {
                ok: true
                width: number
                height: number
                depth: number
                paths(): {
                  viewBox: [number, number, number, number]
                  items: {
                    d: string
                    m: [number, number, number, number, number, number]
                    fill: string
                  }[]
                } | null
              }
            | { ok: false; error: string }
            | undefined
          request(l: string, d: boolean, c: string, cb: () => void): void
        }
        images?: {
          peek(id: string): unknown
          request(id: string, cb: () => void): void
        }
      }
      addImages(
        files: File[],
        at?: { x: number; y: number },
      ): Promise<{ added: string[]; failed: unknown[] }>
      setScene(
        els: unknown[],
        cam?: { x: number; y: number; zoom: number },
      ): void
      invalidate(): void
    }

    const ed = (window as unknown as { __editor: Ed }).__editor
    const math = ed.platform.math
    if (!math) throw new Error('missing math provider')

    const formulas = [
      '\\frac{a+b}{c+d}',
      '\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}',
      '\\ce{2H2 + O2 -> 2H2O}',
    ]
    for (const f of formulas) {
      await new Promise<void>((r) => math.request(f, true, '#000000', r))
    }

    const nextFrames = () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      )

    // 1. Place the three equations (with size=60 so at zoom=20 their pixel width > 4096 and exercises the Path2D rung)
    const mathEls = formulas.map((latex, i) => {
      const entry = math.peek(latex, true, '#000000')
      if (!entry?.ok) throw new Error(`math failed: ${latex}`)
      const size = 60
      return {
        id: `m${i + 1}`,
        type: 'math',
        x: i * 400,
        y: 0,
        w: entry.width * size,
        h: (entry.height + entry.depth) * size,
        rotation: 0,
        z: `a${i}`,
        style: {
          stroke: '#000000',
          fill: null,
          strokeWidth: 2,
          opacity: 1,
          dash: 'solid',
        },
        locked: false,
        author: { kind: 'human', id: 'local' },
        v: 0,
        data: { latex, display: true, size },
      }
    })
    ed.setScene(mathEls, { x: 0, y: 0, zoom: 1 })

    // 2. Generate a 2,000 x 2,000 synthetic checker PNG (squares of 200x200 px)
    const imgC = document.createElement('canvas')
    imgC.width = 2000
    imgC.height = 2000
    const ictx = imgC.getContext('2d') as CanvasRenderingContext2D
    const cell = 200
    for (let y = 0; y < 2000; y += cell) {
      for (let x = 0; x < 2000; x += cell) {
        ictx.fillStyle =
          ((x / cell + y / cell) & 1) === 0 ? '#000000' : '#ffffff'
        ictx.fillRect(x, y, cell, cell)
      }
    }
    const blob = await new Promise<Blob>((resolve, reject) =>
      imgC.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
        'image/png',
      ),
    )
    const file = new File([blob], 'checker-2000.png', { type: 'image/png' })
    const { added } = await ed.addImages([file], { x: 250, y: 500 })
    const imgId = added[0]
    if (!imgId) throw new Error('image not added')

    // Align the image to exact integer world box 500x500 at (0, 300) so checker edges land on exact integer coords
    const imgEl = ed.scene.els.get(imgId) as {
      id: string
      data: { blobId: string; naturalW: number; naturalH: number }
    }
    await new Promise<void>((r) =>
      ed.platform.images?.request(imgEl.data.blobId, r),
    )
    ed.setScene(
      [
        ...mathEls,
        {
          ...imgEl,
          x: 0,
          y: 300,
          w: 500,
          h: 500,
        },
      ],
      { x: 0, y: 0, zoom: 1 },
    )

    // Sweep zooms 0.05, 1, 4, 20
    const cacheChecks: { zoom: number; bytes: number; cap: number }[] = []
    for (const zoom of [0.05, 1, 4, 20]) {
      ed.camera = { x: 0, y: 0, zoom }
      ed.invalidate()
      await nextFrames()
      cacheChecks.push({ zoom, bytes: ed.cacheBytes, cap: ed.cacheCap })
    }

    const sceneCanvas = document.querySelectorAll(
      'canvas',
    )[0] as HTMLCanvasElement
    const sctx = sceneCanvas.getContext('2d') as CanvasRenderingContext2D

    // Helper: mean edge gradient magnitude across non-zero transitions, horizontal and vertical (a fraction bar has
    // no vertical edges inside a small crop, only horizontal ones)
    const edgeSharpness = (data: Uint8ClampedArray, w: number, h: number) => {
      let sum = 0
      let count = 0
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          for (const prev of [x > 0 ? i - 4 : -1, y > 0 ? i - w * 4 : -1]) {
            if (prev < 0) continue
            const g = Math.abs((data[i] ?? 0) - (data[prev] ?? 0))
            if (g > 4) {
              sum += g
              count++
            }
          }
        }
      }
      return count > 0 ? sum / count : 0
    }

    // 3. Measure math edge sharpness at zoom 20 vs direct SVG Path2D reference
    // Crop 20 x 20 world units around the equation's centre: its top-left corner is blank (the tall `b` is on the right),
    // and a blank crop has no edges to measure.
    const m0 = mathEls[0]
    if (!m0) throw new Error('missing m0')
    const cx = m0.w / 2 - 10
    const cy = m0.h / 2 - 10
    ed.camera = { x: m0.x + cx, y: m0.y + cy, zoom: 20 }
    ed.invalidate()
    await nextFrames()

    const cropW = 400
    const cropH = 400
    const actualMathData = sctx.getImageData(0, 0, cropW, cropH).data

    const refCanvas = document.createElement('canvas')
    refCanvas.width = cropW
    refCanvas.height = cropH
    const rctx = refCanvas.getContext('2d') as CanvasRenderingContext2D
    rctx.fillStyle = '#ffffff'
    rctx.fillRect(0, 0, cropW, cropH)
    const entry0 = math.peek(m0.data.latex, true, '#000000')
    if (!entry0?.ok) throw new Error('entry0 not ok')
    const mp = entry0.paths()
    if (!mp) throw new Error('missing mp')
    const [vx, vy, vw, vh] = mp.viewBox
    rctx.save()
    rctx.translate(-cx * 20, -cy * 20)
    rctx.scale((m0.w * 20) / vw, (m0.h * 20) / vh)
    rctx.translate(-vx, -vy)
    for (const item of mp.items) {
      rctx.save()
      const [a, b, c, d, e, f] = item.m
      rctx.transform(a, b, c, d, e, f)
      rctx.fillStyle = '#000000'
      rctx.fill(new Path2D(item.d))
      rctx.restore()
    }
    rctx.restore()
    const refMathData = rctx.getImageData(0, 0, cropW, cropH).data

    const actualMathSharpness = edgeSharpness(actualMathData, cropW, cropH)
    const refMathSharpness = edgeSharpness(refMathData, cropW, cropH)
    const mathSharpnessRatio =
      refMathSharpness > 0 ? actualMathSharpness / refMathSharpness : 0

    // 4. Measure checker image blur width at zoom 1 (500x500 on screen -> each 200px source cell is 50px on screen)
    ed.camera = { x: 0, y: 300, zoom: 1 }
    ed.invalidate()
    await nextFrames()
    // Scan a horizontal row across the vertical checker boundary at x = 50 (y = 25)
    const rowData1 = sctx.getImageData(40, 25, 20, 1).data
    let blurPxZoom1 = 0
    for (let x = 0; x < 20; x++) {
      const lum = rowData1[x * 4] ?? 0
      if (lum > 16 && lum < 239) blurPxZoom1++
    }

    // Also at zoom 0.5 (250x250 on screen -> each cell is 25px on screen, boundary at x = 25)
    ed.camera = { x: 0, y: 300, zoom: 0.5 }
    ed.invalidate()
    await nextFrames()
    const rowDataHalf = sctx.getImageData(15, 12, 20, 1).data
    let blurPxZoomHalf = 0
    for (let x = 0; x < 20; x++) {
      const lum = rowDataHalf[x * 4] ?? 0
      if (lum > 16 && lum < 239) blurPxZoomHalf++
    }

    // And at zoom 20 across the vertical checker boundary at world x = 50, y = 310
    ed.camera = { x: 45, y: 300, zoom: 20 }
    ed.invalidate()
    await nextFrames()
    const imgZoom20Data = sctx.getImageData(0, 0, 200, 100).data
    const imgZoom20Sharpness = edgeSharpness(imgZoom20Data, 200, 100)

    const refImgCanvas = document.createElement('canvas')
    refImgCanvas.width = 200
    refImgCanvas.height = 100
    const rictx = refImgCanvas.getContext('2d') as CanvasRenderingContext2D
    rictx.fillStyle = '#ffffff'
    rictx.fillRect(0, 0, 200, 100)
    rictx.setTransform(20, 0, 0, 20, -45 * 20, 0)
    rictx.drawImage(imgC, 0, 0, 2000, 2000, 0, 0, 500, 500)
    const refImgZoom20Sharpness = edgeSharpness(
      rictx.getImageData(0, 0, 200, 100).data,
      200,
      100,
    )
    const imgZoom20Ratio =
      refImgZoom20Sharpness > 0 ? imgZoom20Sharpness / refImgZoom20Sharpness : 0

    return {
      cacheChecks,
      actualMathSharpness,
      refMathSharpness,
      mathSharpnessRatio,
      blurPxZoom1,
      blurPxZoomHalf,
      imgZoom20Sharpness,
      refImgZoom20Sharpness,
      imgZoom20Ratio,
    }
  })

  expect(errors).toEqual([])
  for (const c of metrics.cacheChecks) {
    expect(c.bytes, `zoom ${c.zoom} cache <= cap`).toBeLessThanOrEqual(c.cap)
  }
  expect(metrics.refMathSharpness, 'crop must contain edges').toBeGreaterThan(0)
  expect(
    metrics.mathSharpnessRatio,
    JSON.stringify(metrics),
  ).toBeGreaterThanOrEqual(0.9)
  expect(metrics.blurPxZoom1).toBeLessThanOrEqual(1)
  expect(metrics.blurPxZoomHalf).toBeLessThanOrEqual(1)
  expect(metrics.imgZoom20Ratio).toBeGreaterThanOrEqual(0.95)
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { comparePngBufferToGolden, getGoldenDimensions } from './helpers/diff'

type Eq = { id: number; cat: string; latex: string }
const fixturesPath = resolve(
  process.cwd(),
  'packages/math/test/fixtures/equations.json',
)
const eqs: Eq[] = JSON.parse(readFileSync(fixturesPath, 'utf8'))

test.use({
  deviceScaleFactor: 1,
  viewport: { width: 1200, height: 800 },
})

test('20 golden equations match between browser Editor and committed Node goldens within <= 1.5%', async ({
  page,
}) => {
  await page.goto('/')
  await page.waitForFunction(
    () => (window as unknown as { __editor?: unknown }).__editor,
  )

  const PX_PER_EM = 40
  const PAD = 8

  for (const eq of eqs) {
    const name = `eq-${String(eq.id).padStart(2, '0')}-${eq.cat}`
    const { width: gw, height: gh } = await getGoldenDimensions(name)

    await page.evaluate(
      async ({ latex, pxPerEm, pad }) => {
        const ed = (
          window as unknown as {
            __editor: {
              platform: {
                math?: {
                  peek(
                    l: string,
                    d: boolean,
                    c: string,
                  ):
                    | { ok: true; width: number; height: number; depth: number }
                    | { ok: false; error: string }
                    | undefined
                  request(
                    l: string,
                    d: boolean,
                    c: string,
                    cb: () => void,
                  ): void
                }
              }
              setScene(
                els: unknown[],
                cam: { x: number; y: number; zoom: number },
              ): void
              invalidate(): void
            }
          }
        ).__editor
        const math = ed.platform.math
        if (!math) throw new Error('missing math provider')
        await new Promise<void>((resolve) => {
          math.request(latex, true, '#1e1e1e', resolve)
        })
        const entry = math.peek(latex, true, '#1e1e1e')
        if (!entry?.ok) throw new Error('math entry failed')
        const w = entry.width * pxPerEm
        const h = (entry.height + entry.depth) * pxPerEm
        ed.setScene(
          [
            {
              id: 'm1',
              type: 'math',
              x: pad,
              y: pad,
              w,
              h,
              rotation: 0,
              z: 'a0',
              style: {
                stroke: '#1e1e1e',
                fill: null,
                strokeWidth: 2,
                opacity: 1,
                dash: 'solid',
              },
              locked: false,
              author: { kind: 'human', id: 'local' },
              v: 0,
              data: { latex, display: true, size: pxPerEm },
            },
          ],
          { x: 0, y: 0, zoom: 1 },
        )
        ed.invalidate()
        await new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        )
      },
      { latex: eq.latex, pxPerEm: PX_PER_EM, pad: PAD },
    )

    const png = await page.screenshot({
      clip: { x: 0, y: 0, width: gw, height: gh },
    })
    const res = await comparePngBufferToGolden(png, name, {
      channelThreshold: 24,
      maxDiffRatio: 0.015,
    })
    expect(res.ratio, name).toBeLessThanOrEqual(0.015)
  }
})

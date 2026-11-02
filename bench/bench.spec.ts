import { writeFileSync } from 'node:fs'
import { test } from '@playwright/test'

type Frame = {
  phase: string
  meanFps: number
  p95FrameMs: number
  drawMsMean: number
  minDrawn: number
  maxCulled: number
}
type Result = {
  error?: string
  env: { devicePixelRatio: number; idleRafFps: number }
  frames: Frame[]
  coldFrameMs: number[]
  cacheMB: number
  firstInk: {
    p95Ms: number
    waitP95Ms: number
    workP95Ms: number
    sceneRepaints: number
  }
  open20k: { ms: number; drawn: number; culled: number; cacheMB: number }
}

const RUNS = Number(process.env.RUNS) || 5
const median = (a: number[]) =>
  [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] as number
const frame = (r: Result, phase: string) =>
  r.frames.find((f) => f.phase === phase) as Frame

for (const n of [5000, 20000]) {
  test(`bench n=${n}`, async ({ context, browser }, testInfo) => {
    const runs: Result[] = []
    for (let i = 0; i < RUNS; i++) {
      const page = await context.newPage()
      await page.bringToFront()
      await page.goto(`/bench?n=${n}&dpr=${testInfo.project.name}`)
      await page.bringToFront()
      await page.waitForFunction(
        () => (window as unknown as { __benchResult?: unknown }).__benchResult,
        null,
        { timeout: 180_000 },
      )
      const r = (await page.evaluate(
        () => (window as unknown as { __benchResult: unknown }).__benchResult,
      )) as Result
      await page.close()
      if (r.error) throw new Error(r.error)
      runs.push(r)
    }
    writeFileSync(
      testInfo.outputPath(`runs-${testInfo.project.name}-n${n}.json`),
      JSON.stringify(runs, null, 1),
    )
    const med = (f: (r: Result) => number) => median(runs.map(f))
    const range = (f: (r: Result) => number) => {
      const v = runs.map(f)
      return `${Math.min(...v)} to ${Math.max(...v)}`
    }
    const rows: [string, (r: Result) => number][] = [
      ['pan meanFps', (r) => frame(r, 'pan').meanFps],
      ['pan p95FrameMs', (r) => frame(r, 'pan').p95FrameMs],
      ['pan drawMsMean', (r) => frame(r, 'pan').drawMsMean],
      ['pan minDrawn', (r) => frame(r, 'pan').minDrawn],
      ['zoom meanFps', (r) => frame(r, 'zoom').meanFps],
      ['zoom p95FrameMs', (r) => frame(r, 'zoom').p95FrameMs],
      ['zoom drawMsMean', (r) => frame(r, 'zoom').drawMsMean],
      ['zoom minDrawn', (r) => frame(r, 'zoom').minDrawn],
      ['firstInkP95Ms', (r) => r.firstInk.p95Ms],
      ['firstInk waitP95Ms', (r) => r.firstInk.waitP95Ms],
      ['firstInk workP95Ms', (r) => r.firstInk.workP95Ms],
      ['firstInk sceneRepaints', (r) => r.firstInk.sceneRepaints],
      ['open20kMs', (r) => r.open20k.ms],
      ['open20k drawn', (r) => r.open20k.drawn],
      ['cacheMB after phases', (r) => r.cacheMB],
      ['cacheMB after open20k', (r) => r.open20k.cacheMB],
      ['coldFrameMs zoom 1', (r) => r.coldFrameMs[0] as number],
      ['coldFrameMs zoom 1.4', (r) => r.coldFrameMs[2] as number],
      ['devicePixelRatio', (r) => r.env.devicePixelRatio],
      ['idleRafFps', (r) => r.env.idleRafFps],
    ]
    const lines = rows.map(
      ([name, f]) => `  ${name}: median ${med(f)} (runs ${range(f)})`,
    )
    console.log(
      `\n${testInfo.project.name} n=${n} chrome ${browser.version()} (${runs.length} runs)\n${lines.join('\n')}`,
    )
  })
}

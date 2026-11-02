import { writeFileSync } from 'node:fs'
import { type BrowserContext, test } from '@playwright/test'

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
  cacheCapMB: number
  // Only the M1 `n=` scenes measure first ink and opening a 20,000-element board.
  firstInk?: {
    p95Ms: number
    waitP95Ms: number
    workP95Ms: number
    sceneRepaints: number
  }
  open20k?: { ms: number; drawn: number; culled: number; cacheMB: number }
}

const RUNS = Number(process.env.RUNS) || 5
const median = (a: number[]) =>
  [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] as number
const frame = (r: Result, phase: string) =>
  r.frames.find((f) => f.phase === phase) as Frame

/** Loads `/bench?<query>` in a fresh page RUNS times and returns each run's `window.__benchResult`. */
async function collect(
  context: BrowserContext,
  query: string,
  dpr: string,
): Promise<Result[]> {
  const runs: Result[] = []
  for (let i = 0; i < RUNS; i++) {
    const page = await context.newPage()
    await page.bringToFront()
    await page.goto(`/bench?${query}&dpr=${dpr}`)
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
  return runs
}

const report = (
  title: string,
  runs: Result[],
  rows: [string, (r: Result) => number][],
) => {
  const med = (f: (r: Result) => number) => median(runs.map(f))
  const range = (f: (r: Result) => number) => {
    const v = runs.map(f)
    return `${Math.min(...v)} to ${Math.max(...v)}`
  }
  const lines = rows.map(
    ([name, f]) => `  ${name}: median ${med(f)} (runs ${range(f)})`,
  )
  console.log(`\n${title} (${runs.length} runs)\n${lines.join('\n')}`)
}

const common: [string, (r: Result) => number][] = [
  ['pan meanFps', (r) => frame(r, 'pan').meanFps],
  ['pan p95FrameMs', (r) => frame(r, 'pan').p95FrameMs],
  ['pan drawMsMean', (r) => frame(r, 'pan').drawMsMean],
  ['pan minDrawn', (r) => frame(r, 'pan').minDrawn],
  ['zoom meanFps', (r) => frame(r, 'zoom').meanFps],
  ['zoom p95FrameMs', (r) => frame(r, 'zoom').p95FrameMs],
  ['zoom drawMsMean', (r) => frame(r, 'zoom').drawMsMean],
  ['zoom minDrawn', (r) => frame(r, 'zoom').minDrawn],
  ['cacheMB after phases', (r) => r.cacheMB],
  ['cacheCapMB', (r) => r.cacheCapMB],
  ['coldFrameMs zoom 1', (r) => r.coldFrameMs[0] as number],
  ['coldFrameMs zoom 1.4', (r) => r.coldFrameMs[2] as number],
  ['devicePixelRatio', (r) => r.env.devicePixelRatio],
  ['idleRafFps', (r) => r.env.idleRafFps],
]

// M1 scenes: the 5,000 mix (also the M2 re-measure under the device-sized cache cap and the first-ink / open-20k "not worse
// than M1" check) and the 20,000 mix.
for (const n of [5000, 20000]) {
  test(`bench n=${n}`, async ({ context, browser }, testInfo) => {
    const runs = await collect(context, `n=${n}`, testInfo.project.name)
    writeFileSync(
      testInfo.outputPath(`runs-${testInfo.project.name}-n${n}.json`),
      JSON.stringify(runs, null, 1),
    )
    const ink =
      (f: (r: Result['firstInk'] & object) => number) => (r: Result) =>
        f(r.firstInk as NonNullable<Result['firstInk']>)
    const open =
      (f: (r: NonNullable<Result['open20k']>) => number) => (r: Result) =>
        f(r.open20k as NonNullable<Result['open20k']>)
    report(
      `${testInfo.project.name} n=${n} chrome ${browser.version()}`,
      runs,
      [
        ...common,
        ['firstInkP95Ms', ink((i) => i.p95Ms)],
        ['firstInk waitP95Ms', ink((i) => i.waitP95Ms)],
        ['firstInk workP95Ms', ink((i) => i.workP95Ms)],
        ['firstInk sceneRepaints', ink((i) => i.sceneRepaints)],
        ['open20kMs', open((o) => o.ms)],
        ['open20k drawn', open((o) => o.drawn)],
        ['cacheMB after open20k', open((o) => o.cacheMB)],
      ],
    )
  })
}

// M2 scenes (Task 11): 200 equations vs 200 texts (Q10's baseline), 50 large images, and the 5,000 mix with 10% math + images.
for (const scene of ['text200', 'math200', 'images50', 'mixed5000']) {
  test(`bench scene=${scene}`, async ({ context, browser }, testInfo) => {
    const runs = await collect(context, `scene=${scene}`, testInfo.project.name)
    writeFileSync(
      testInfo.outputPath(`runs-${testInfo.project.name}-${scene}.json`),
      JSON.stringify(runs, null, 1),
    )
    report(
      `${testInfo.project.name} scene=${scene} chrome ${browser.version()}`,
      runs,
      common,
    )
  })
}

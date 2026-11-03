import { describe, expect, it } from 'vitest'
import { bounds } from '../geometry'
import { nodePlatform } from '../node'
import { applyBatch, createScene } from '../scene'
import type { Element } from '../schema'
import { mk } from '../test-utils'
import { addChart } from './chart'
import { describeElement } from './describe'
import { coreTools } from './index'
import { ELEMENT_BUDGET, type ToolCtx } from './registry'

const ctx = (els: Element[] = [], over: Partial<ToolCtx> = {}): ToolCtx => ({
  scene: createScene(els),
  platform: nodePlatform(),
  turnId: 't1',
  author: { kind: 'agent', id: 'tutor:t1' },
  grantedIds: new Set(),
  selection: [],
  added: 0,
  ...over,
})
const sales = {
  kind: 'bar',
  title: 'Sales by quarter',
  categories: ['Q1', 'Q2', 'Q3'],
  series: [{ name: 'North', values: [3, 5, 2] }],
}
const run = async (input: unknown, c = ctx()) => {
  const out = await addChart.execute(addChart.input.parse(input), c)
  if (out.kind !== 'write') throw new Error('not a write')
  applyBatch(c.scene, out.batch) // also validates every element and op
  return { out, c }
}
const fails = (input: unknown, field: string, message: RegExp) =>
  expect(
    Promise.resolve().then(() =>
      addChart.execute(addChart.input.parse(input), ctx()),
    ),
  ).rejects.toMatchObject({ name: 'ToolError', field, message })

describe('add_chart', () => {
  it('adds one chart of the default size, by the agent, that the scene accepts', async () => {
    const { out, c } = await run(sales)
    expect(out.ids).toHaveLength(1)
    const el = c.scene.els.get(out.ids[0] as string) as Element
    expect(el).toMatchObject({
      type: 'chart',
      w: 480,
      h: 320,
      rotation: 0,
      locked: false,
      author: { kind: 'agent', id: 'tutor:t1' },
      data: sales,
    })
    expect(out.batch.ops).toHaveLength(1)
    expect(out.bounds).toEqual({ x: el.x, y: el.y, w: 480, h: 320 })
  })

  it('takes a size and an exact position', async () => {
    const { c, out } = await run({
      ...sales,
      w: 300,
      h: 200,
      placement: { x: 100, y: 50 },
    })
    expect(c.scene.els.get(out.ids[0] as string)).toMatchObject({
      x: 100,
      y: 50,
      w: 300,
      h: 200,
    })
  })

  it('auto placement keeps clear of what is on the board', async () => {
    const existing = [
      mk('a', { x: 0, y: 0, w: 500, h: 300 }),
      mk('b', { x: 520, y: 0, w: 200, h: 300 }),
    ]
    const { c, out } = await run(
      sales,
      ctx(existing, { viewport: { x: 0, y: 0, w: 1400, h: 900 } }),
    )
    const chart = bounds(c.scene.els.get(out.ids[0] as string) as Element)
    for (const o of existing.map(bounds))
      expect(
        chart.minX < o.maxX &&
          chart.maxX > o.minX &&
          chart.minY < o.maxY &&
          chart.maxY > o.minY,
      ).toBe(false)
  })

  it('takes all six kinds, a scatter with xs and no categories', async () => {
    for (const kind of ['line', 'area'])
      await run({ ...sales, kind, stacked: kind === 'area' })
    for (const kind of ['pie', 'donut']) await run({ ...sales, kind })
    const { c, out } = await run({
      kind: 'scatter',
      series: [{ name: 'obs', values: [1, 2, 4], xs: [10, 20, 30] }],
      xLabel: 'Hours',
      yLabel: 'Score',
    })
    expect(c.scene.els.get(out.ids[0] as string)).toMatchObject({
      data: { kind: 'scatter', categories: [] },
    })
  })

  it('says which field is wrong, with the schema message, for every kind of bad input', async () => {
    await fails(
      { ...sales, series: [{ name: 'North', values: [3, 5] }] },
      'series',
      /must have one value per category/,
    )
    await fails(
      { ...sales, title: 'المبيعات' },
      'title',
      /chart labels support Latin letters and digits only/,
    )
    await fails(
      { ...sales, categories: ['Q1', 'ثانيا', 'Q3'] },
      'categories.1',
      /Latin letters and digits only/,
    )
    await fails(
      {
        ...sales,
        series: Array.from({ length: 9 }, (_, i) => ({
          name: `s${i}`,
          values: [1, 2, 3],
        })),
      },
      'series',
      /at most 8 series/,
    )
    await fails(
      {
        ...sales,
        kind: 'pie',
        series: [
          { name: 'a', values: [1, 2, 3] },
          { name: 'b', values: [1, 2, 3] },
        ],
      },
      'series',
      /exactly one series/,
    )
    await fails(
      { kind: 'scatter', series: [{ name: 's', values: [1, 2] }] },
      'series',
      /needs xs/,
    )
    await fails(
      { kind: 'bar', series: [{ name: 's', values: [1] }] },
      'categories',
      /required/,
    )
    await fails(
      { ...sales, series: [{ name: 's', values: [1e16, 2, 3] }] },
      'series.0.values.0',
      /between -1e15 and 1e15/,
    )
  })

  it('counts as one element against the turn budget and warns past it', async () => {
    const fine = await run(sales, ctx([], { added: ELEMENT_BUDGET - 1 }))
    expect(fine.out.kind === 'write' && fine.out.warnings).toEqual([])
    const over = await run(sales, ctx([], { added: ELEMENT_BUDGET }))
    expect(over.out.kind === 'write' && over.out.warnings?.[0]).toMatch(
      /soft limit of 40/,
    )
  })

  it('is described to the model by kind and title, and is in the core registry', async () => {
    const { c, out } = await run(sales)
    expect(
      describeElement(c.scene.els.get(out.ids[0] as string) as Element).detail,
    ).toBe('bar chart "Sales by quarter"')
    expect(coreTools.map((t) => t.name)).toContain('add_chart')
  })
})

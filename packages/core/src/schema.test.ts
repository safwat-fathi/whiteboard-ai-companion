import { describe, expect, it } from 'vitest'
import { zBetween } from './scene'
import { ElementSchema, newId, OpSchema } from './schema'

const base = {
  id: 'a1',
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  rotation: 0,
  z: 'a0',
  style: {
    stroke: '#000',
    fill: null,
    strokeWidth: 2,
    opacity: 1,
    dash: 'solid',
  },
  locked: false,
  author: { kind: 'human', id: 'u1' },
  v: 1,
}
const rect = { ...base, type: 'shape', data: { kind: 'rect' } }
const text = {
  ...base,
  type: 'text',
  data: { text: 'مرحبا بالعالم', size: 16, align: 'right', dir: 'rtl' },
}
const math = {
  ...base,
  type: 'math',
  data: { latex: '\\frac{a}{b}', display: true, size: 28 },
}
const validBlobId = 'a'.repeat(64)
const image = {
  ...base,
  type: 'image',
  data: {
    blobId: validBlobId,
    naturalW: 800,
    naturalH: 600,
    crop: { x: 10, y: 20, w: 400, h: 300 },
    alt: 'diagram',
  },
}

const freehand = {
  ...base,
  type: 'freehand',
  data: {
    points: [
      [0, 0],
      [5, 5],
      [10, 2],
    ],
    pressure: [0.2, 0.5, 0.9],
    smoothing: 0.5,
    highlighter: false,
  },
}

describe('ElementSchema', () => {
  it('parses a rect, Arabic text, math, and image (preserving M1 board snapshots)', () => {
    expect(ElementSchema.parse(rect).type).toBe('shape')
    expect(ElementSchema.parse(text).type).toBe('text')
    expect(ElementSchema.parse(math).type).toBe('math')
    expect(ElementSchema.parse(image).type).toBe('image')
    expect(
      ElementSchema.parse({
        ...math,
        data: { ...math.data, latex: 'x'.repeat(4000) },
      }).type,
    ).toBe('math')
  })
  it('accepts an image source from a book page and rejects a malformed one', () => {
    const source = { bookPage: { bookId: 'b'.repeat(64), page: 42 } }
    const withSource = { ...image, data: { ...image.data, source } }
    expect(ElementSchema.parse(withSource)).toMatchObject({ data: { source } })
    for (const bad of [
      { bookPage: { bookId: 'not a valid id!', page: 1 } },
      { bookPage: { bookId: 'b'.repeat(64), page: 0 } },
      { bookPage: { bookId: 'b'.repeat(64), page: 1.5 } },
    ])
      expect(() =>
        ElementSchema.parse({ ...image, data: { ...image.data, source: bad } }),
      ).toThrow()
  })
  it('rejects bad values', () => {
    expect(ElementSchema.safeParse({ ...rect, w: -1 }).success).toBe(false)
    expect(
      ElementSchema.safeParse({ ...rect, rotation: Number.NaN }).success,
    ).toBe(false)
    expect(ElementSchema.safeParse({ ...rect, type: 'blob' }).success).toBe(
      false,
    )
    expect(
      ElementSchema.safeParse({
        ...text,
        data: { ...text.data, text: 'x'.repeat(100001) },
      }).success,
    ).toBe(false)
    expect(
      ElementSchema.safeParse({
        ...math,
        data: { ...math.data, latex: 'x'.repeat(4001) },
      }).success,
    ).toBe(false)
    expect(
      ElementSchema.safeParse({
        ...math,
        data: { ...math.data, size: 7 },
      }).success,
    ).toBe(false)
    expect(
      ElementSchema.safeParse({
        ...image,
        data: { ...image.data, blobId: 'not-64-hex' },
      }).success,
    ).toBe(false)
    expect(
      ElementSchema.safeParse({
        ...image,
        data: { ...image.data, naturalW: 0 },
      }).success,
    ).toBe(false)
    expect(
      ElementSchema.safeParse({
        ...image,
        data: { ...image.data, crop: { x: 500, y: 0, w: 400, h: 100 } },
      }).success,
    ).toBe(false)
    expect(
      ElementSchema.safeParse({
        ...image,
        data: { ...image.data, crop: { x: 0, y: 0, w: 0, h: 100 } },
      }).success,
    ).toBe(false)
  })
  it('parses a freehand stroke, a one-point tap and the 10,000-point cap', () => {
    expect(ElementSchema.parse(freehand).type).toBe('freehand')
    const tap = {
      ...freehand,
      data: { ...freehand.data, points: [[3, 3]], pressure: undefined },
    }
    expect(ElementSchema.parse(tap)).toMatchObject({
      data: { points: [[3, 3]] },
    })
    const many = Array.from({ length: 10_000 }, (_, i) => [i, i % 7])
    expect(
      ElementSchema.safeParse({
        ...freehand,
        data: { ...freehand.data, points: many, pressure: many.map(() => 0.5) },
      }).success,
    ).toBe(true)
  })
  it('rejects a freehand with NaN, mismatched pressure, too many points or bad ranges', () => {
    const bad = (data: object) =>
      ElementSchema.safeParse({
        ...freehand,
        data: { ...freehand.data, ...data },
      })
    expect(
      bad({
        points: [
          [0, 0],
          [Number.NaN, 1],
          [2, 2],
        ],
      }).success,
    ).toBe(false)
    expect(bad({ points: [] }).success).toBe(false)
    expect(bad({ pressure: [0.5, 0.5] }).success).toBe(false)
    expect(bad({ pressure: [0.2, 0.5, 1.5] }).success).toBe(false)
    expect(bad({ pressure: [0.2, 0.5, Number.NaN] }).success).toBe(false)
    expect(bad({ smoothing: 1.1 }).success).toBe(false)
    expect(bad({ highlighter: 'yes' }).success).toBe(false)
    const over = Array.from({ length: 10_001 }, () => [0, 0])
    const r = bad({ points: over, pressure: undefined })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]?.message).toBe('must have at most 10000 points')
    expect(bad({ pressure: [0.5] }).error?.issues[0]).toMatchObject({
      path: ['data', 'pressure'],
      message: 'must have one value per point',
    })
  })
  it('strips unknown fields on math and image too', () => {
    expect(ElementSchema.parse({ ...rect, junk: 1 })).not.toHaveProperty('junk')
    expect(
      ElementSchema.parse({
        ...math,
        data: { ...math.data, extra: 123 },
      }).data,
    ).not.toHaveProperty('extra')
    expect(
      ElementSchema.parse({
        ...image,
        data: { ...image.data, extra: 123 },
      }).data,
    ).not.toHaveProperty('extra')
  })
  it('newId returns distinct ids', () => {
    expect(newId()).not.toBe(newId())
  })

  describe('chart', () => {
    const chart = {
      ...base,
      w: 480,
      h: 320,
      type: 'chart',
      data: {
        kind: 'bar',
        title: 'Sales by quarter',
        categories: ['Q1', 'Q2', 'Q3'],
        series: [{ name: 'North', values: [3, 5, 2] }],
      },
    }
    const parse = (data: object) =>
      ElementSchema.safeParse({
        ...chart,
        data: { ...chart.data, ...data },
      })
    const message = (data: object) => parse(data).error?.issues[0]?.message

    it('parses all six kinds', () => {
      for (const kind of ['bar', 'line', 'area'])
        expect(parse({ kind }).success).toBe(true)
      for (const kind of ['pie', 'donut'])
        expect(parse({ kind }).success).toBe(true) // one series
      expect(
        parse({
          kind: 'scatter',
          categories: [],
          series: [{ name: 'obs', values: [1, 2, 4], xs: [10, 20, 30] }],
        }).success,
      ).toBe(true)
    })
    it('takes the edges that must still draw: one category, no data, negatives, zeros, 1e12', () => {
      expect(
        parse({ categories: ['A'], series: [{ name: 's', values: [1e12] }] })
          .success,
      ).toBe(true)
      expect(parse({ categories: [], series: [] }).success).toBe(true)
      expect(
        parse({
          categories: ['A', 'B'],
          series: [{ name: 's', values: [-4, 0] }],
        }).success,
      ).toBe(true)
      expect(
        parse({ stacked: true, xLabel: 'Quarter', yLabel: 'Units' }).success,
      ).toBe(true)
    })
    it('rejects a series that does not match the categories, naming the field', () => {
      const r = parse({ series: [{ name: 's', values: [1, 2] }] })
      expect(r.success).toBe(false)
      expect(r.error?.issues[0]).toMatchObject({
        path: ['data', 'series'],
        message: 'must have one value per category',
      })
    })
    it('rejects a pie or donut with two series and a scatter without matching xs', () => {
      const two = [
        { name: 'a', values: [1, 2, 3] },
        { name: 'b', values: [1, 2, 3] },
      ]
      expect(message({ kind: 'pie', series: two })).toBe(
        'a pie or donut chart takes exactly one series',
      )
      expect(message({ kind: 'donut', series: two })).toBe(
        'a pie or donut chart takes exactly one series',
      )
      expect(
        message({
          kind: 'scatter',
          categories: [],
          series: [{ name: 's', values: [1, 2] }],
        }),
      ).toBe('a scatter series needs xs, one per value')
      expect(
        message({
          kind: 'scatter',
          categories: [],
          series: [{ name: 's', values: [1, 2], xs: [1] }],
        }),
      ).toBe('a scatter series needs xs, one per value')
    })
    it('caps categories, series, values and label lengths', () => {
      const cats = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`)
      expect(
        parse({
          categories: cats(50),
          series: [{ name: 's', values: Array(50).fill(1) }],
        }).success,
      ).toBe(true)
      expect(
        message({
          categories: cats(51),
          series: [{ name: 's', values: Array(51).fill(1) }],
        }),
      ).toBe('must have at most 50 categories')
      const nine = Array.from({ length: 9 }, (_, i) => ({
        name: `s${i}`,
        values: [1, 2, 3],
      }))
      expect(message({ series: nine })).toBe('must have at most 8 series')
      expect(
        message({
          kind: 'scatter',
          categories: [],
          series: [
            {
              name: 's',
              values: Array(201).fill(1),
              xs: Array(201).fill(1),
            },
          ],
        }),
      ).toBe('must have at most 200 values')
      expect(parse({ categories: ['x'.repeat(40), 'B', 'C'] }).success).toBe(
        true,
      )
      expect(message({ categories: ['x'.repeat(41), 'B', 'C'] })).toBe(
        'must be at most 40 characters',
      )
      expect(message({ title: 'x'.repeat(121) })).toBe(
        'must be at most 120 characters',
      )
      expect(message({ xLabel: 'x'.repeat(41) })).toBe(
        'must be at most 40 characters',
      )
      expect(
        message({
          series: [{ name: 'x'.repeat(41), values: [1, 2, 3] }],
        }),
      ).toBe('must be at most 40 characters')
    })
    it('rejects NaN and a non-Latin label with the stated message, in every place a label goes', () => {
      expect(
        parse({ series: [{ name: 's', values: [1, Number.NaN, 3] }] }).success,
      ).toBe(false)
      const latin = 'chart labels support Latin letters and digits only'
      expect(message({ title: 'المبيعات' })).toBe(latin)
      expect(message({ categories: ['أ', 'B', 'C'] })).toBe(latin)
      expect(message({ series: [{ name: 'شمال', values: [1, 2, 3] }] })).toBe(
        latin,
      )
      expect(message({ yLabel: '数量' })).toBe(latin)
      // accented Latin, currency, arrows and math operators stay
      expect(parse({ title: 'Café sales €5 → 10 ≤ 20, 100%' }).success).toBe(
        true,
      )
    })
    it('keeps values within a quadrillion, where float steps still mean something', () => {
      const one = (values: number[], xs?: number[]) =>
        parse({
          kind: xs ? 'scatter' : 'bar',
          categories: xs ? [] : values.map((_, i) => `c${i}`),
          series: [{ name: 's', values, ...(xs && { xs }) }],
        })
      expect(one([1e15, -1e15]).success).toBe(true)
      const big = one([1e15 + 2])
      expect(big.success).toBe(false)
      expect(big.error?.issues[0]?.message).toBe(
        'must be between -1e15 and 1e15',
      )
      expect(one([-1e15 - 2]).success).toBe(false)
      expect(one([1], [1e16]).success).toBe(false)
      expect(one([Number.MAX_VALUE]).success).toBe(false)
    })
    it('takes only hex palette colours, up to eight', () => {
      expect(parse({ palette: ['#e69f00', '#56b4e9'] }).success).toBe(true)
      expect(parse({ palette: ['red'] }).success).toBe(false)
      expect(parse({ palette: Array(9).fill('#000000') }).success).toBe(false)
    })
  })
})

describe('z order key', () => {
  it('rejects keys fractional-indexing cannot extend, accepts its own', () => {
    expect(ElementSchema.safeParse({ ...rect, z: '~' }).success).toBe(false)
    expect(
      OpSchema.safeParse({ op: 'reorder', id: 'a1', z: '~' }).success,
    ).toBe(false)
    const a = zBetween(null, null)
    for (const z of [
      a,
      zBetween(a, null),
      zBetween(null, a),
      zBetween(a, zBetween(a, null)),
    ])
      expect(ElementSchema.safeParse({ ...rect, z }).success).toBe(true)
  })
})

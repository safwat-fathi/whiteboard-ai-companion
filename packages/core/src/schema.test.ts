import { describe, expect, it } from 'vitest'
import { ElementSchema, newId } from './schema'

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
})

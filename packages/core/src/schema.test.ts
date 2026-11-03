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
      { bookPage: { bookId: 'nope', page: 1 } },
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

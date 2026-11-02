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

describe('ElementSchema', () => {
  it('parses a rect and Arabic text', () => {
    expect(ElementSchema.parse(rect).type).toBe('shape')
    expect(ElementSchema.parse(text).type).toBe('text')
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
  })
  it('strips unknown fields', () => {
    expect(ElementSchema.parse({ ...rect, junk: 1 })).not.toHaveProperty('junk')
  })
  it('newId returns distinct ids', () => {
    expect(newId()).not.toBe(newId())
  })
})

import { describe, expect, it } from 'vitest'
import { OpError, validateBatch } from './ops'

const style = {
  stroke: '#000',
  fill: null,
  strokeWidth: 2,
  opacity: 1,
  dash: 'solid',
}
const el = {
  id: 'a1',
  type: 'shape',
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  rotation: 0,
  z: 'a0',
  style,
  locked: false,
  author: { kind: 'human', id: 'u1' },
  v: 1,
  data: { kind: 'rect' },
}
const batch = (ops: unknown[]) => ({ batchId: 'b1', label: 't', ops })
const add = (patch: object) => batch([{ op: 'add', el: { ...el, ...patch } }])
const fieldOf = (b: unknown) => {
  try {
    validateBatch(b)
  } catch (e) {
    expect(e).toBeInstanceOf(OpError)
    return (e as OpError).field
  }
  throw new Error('did not throw')
}

describe('validateBatch', () => {
  it('accepts valid batches', () => {
    expect(validateBatch(add({})).ops).toHaveLength(1)
    expect(
      validateBatch(
        batch([
          {
            op: 'patch',
            id: 'a1',
            set: { 'style.fill': '#f00', 'data.kind': 'ellipse', x: 5 },
          },
        ]),
      ),
    ).toBeTruthy()
    expect(
      validateBatch(
        batch([
          { op: 'remove', id: 'a1' },
          { op: 'reorder', id: 'a1', z: 'a1' },
        ]),
      ),
    ).toBeTruthy()
  })
  it('names the offending field', () => {
    expect(fieldOf(add({ w: -1 }))).toBe('w')
    expect(fieldOf(add({ rotation: Number.NaN }))).toBe('rotation')
    expect(fieldOf(add({ style: { ...style, opacity: 2 } }))).toBe(
      'style.opacity',
    )
    expect(
      fieldOf(
        add({
          type: 'text',
          data: { text: 'a', size: 0, align: 'left', dir: 'auto' },
        }),
      ),
    ).toBe('data.size')
    expect(fieldOf(add({ type: 'blob' }))).toBe('type')
  })
  it('says the range', () => {
    expect(() =>
      validateBatch(add({ style: { ...style, opacity: 2 } })),
    ).toThrow('style.opacity must be 0..1')
  })
  it('rejects empty ops', () => {
    expect(fieldOf(batch([]))).toBe('ops')
  })
  it('validates patch paths and values', () => {
    for (const k of [
      'nope',
      'style.nope',
      'type',
      'id',
      'v',
      'author',
      'author.id',
      'data.nope',
      'x.y',
    ])
      expect(fieldOf(batch([{ op: 'patch', id: 'a1', set: { [k]: 1 } }]))).toBe(
        k,
      )
    expect(
      fieldOf(batch([{ op: 'patch', id: 'a1', set: { 'style.opacity': 3 } }])),
    ).toBe('style.opacity')
  })
})

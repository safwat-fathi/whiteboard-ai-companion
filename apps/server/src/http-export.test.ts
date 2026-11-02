import { describe, expect, it } from 'vitest'
import { boot } from './http-test-utils'

const OWNER = { kind: 'human', id: 'owner' } as const
const rectBatch = {
  batchId: 'b1',
  label: 'Add',
  ops: [
    {
      op: 'add',
      el: {
        id: 'r1',
        type: 'shape',
        x: 10,
        y: 20,
        w: 100,
        h: 50,
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
        author: OWNER,
        v: 0,
        data: { kind: 'rect' },
      },
    },
  ],
}
/** Width and height from a PNG's IHDR chunk (big-endian at bytes 16 and 20). */
const size = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)]
const isPng = (b: Buffer) =>
  b
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

describe('GET /api/boards/:id/export.png', () => {
  it('renders a rect of the board at the requested width', async () => {
    const { call, boards } = await boot()
    const b = boards.createBoard('B')
    boards.submit(b.id, rectBatch, OWNER)
    const r = await call(
      'GET',
      `/api/boards/${b.id}/export.png?x=0&y=0&w=200&h=100&width=400`,
    )
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('image/png')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(isPng(r.raw)).toBe(true)
    expect(size(r.raw)).toEqual([400, 200])
  })

  it('defaults to the content bounds plus padding at width 1024', async () => {
    const { call, boards } = await boot()
    const b = boards.createBoard('B')
    boards.submit(b.id, rectBatch, OWNER) // 100 x 50 at (10, 20): 24 world units of padding each side => 148 x 98
    const r = await call('GET', `/api/boards/${b.id}/export.png`)
    expect(r.status).toBe(200)
    expect(size(r.raw)).toEqual([1024, Math.round((1024 * 98) / 148)])
  })

  it('renders an empty board as a blank page', async () => {
    const { call, boards } = await boot()
    const b = boards.createBoard('B')
    const r = await call('GET', `/api/boards/${b.id}/export.png?width=400`)
    expect(r.status).toBe(200)
    expect(size(r.raw)).toEqual([400, 300])
  })

  it.each([
    ['width over 4096', 'width=4097'],
    ['width under 16', 'width=15'],
    ['a non-numeric width', 'width=abc'],
    ['an empty width', 'width='],
    ['an empty x (Number("") would be a valid 0)', 'x=&y=0&w=10&h=10'],
    ['a negative w', 'x=0&y=0&w=-1&h=10'],
    ['a zero h', 'x=0&y=0&w=10&h=0'],
    ['a NaN x', 'x=NaN&y=0&w=10&h=10'],
    ['an Infinity y', 'x=0&y=Infinity&w=10&h=10'],
    ['only some of x, y, w, h', 'x=0&y=0'],
    ['an extreme aspect', 'x=0&y=0&w=1&h=1000000&width=1024'],
  ])('refuses %s with validation_failed', async (_n, query) => {
    const { call, boards } = await boot()
    const b = boards.createBoard('B')
    const r = await call('GET', `/api/boards/${b.id}/export.png?${query}`)
    expect(r.status).toBe(400)
    expect(r.json.error.code).toBe('validation_failed')
  })

  it('404s an unknown board and refuses a rebinding Host', async () => {
    const { call, boards } = await boot()
    expect((await call('GET', '/api/boards/nope/export.png')).status).toBe(404)
    const b = boards.createBoard('B')
    expect(
      (
        await call('GET', `/api/boards/${b.id}/export.png`, {
          headers: { Host: 'evil.test:4000' },
        })
      ).status,
    ).toBe(403)
  })
})

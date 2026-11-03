// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { type BoardBridge, prepareContext } from './board-context'
import { defaultChips } from './chips'

beforeAll(() => {
  // jsdom has no object URLs
  URL.createObjectURL = vi.fn(() => 'blob:local')
})

const png = () =>
  new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
function bridge(selection: string[]) {
  const log: string[] = []
  const b: BoardBridge = {
    selection: () => selection,
    subscribe: () => () => {},
    viewport: () => ({ x: 0, y: 0, w: 800, h: 600, zoom: 0.8 }),
    picture: async (of) => {
      log.push(`picture:${of}`)
      return { png: png(), rect: { x: 1, y: 2, w: 3, h: 4 } }
    },
    settle: async () => {
      log.push('settle')
    },
  }
  return { b, log }
}
const upload = (log: string[]) => async () => {
  log.push('upload')
  return `blob-${log.filter((l) => l === 'upload').length}`
}

describe('prepareContext', () => {
  it('waits for the board to settle first, then renders and uploads the selection picture', async () => {
    const { b, log } = bridge(['a', 'b'])
    const p = await prepareContext(b, upload(log), defaultChips(), 'check')
    expect(log).toEqual(['settle', 'picture:selection', 'upload'])
    expect(p.context).toMatchObject({
      mode: 'check',
      selection: ['a', 'b'],
      attach: { selection: 'both', viewport: 'none', board: 'none' },
      pictures: [
        { blobId: 'blob-1', of: 'selection', rect: { x: 1, y: 2, w: 3, h: 4 } },
      ],
      viewport: { w: 800, zoom: 0.8 },
    })
    expect(p.thumbs).toEqual([{ of: 'selection', url: 'blob:local' }])
  })

  it('structure only sends no picture; the viewport and board chips each add one', async () => {
    const { b, log } = bridge(['a'])
    let p = await prepareContext(
      b,
      upload(log),
      { ...defaultChips(), selection: 'structure' },
      'ask',
    )
    expect(p.context.pictures).toEqual([])
    log.length = 0
    p = await prepareContext(
      b,
      upload(log),
      {
        selection: 'both',
        selectionOff: false,
        viewport: true,
        board: 'picture',
      },
      'ask',
    )
    expect(log.filter((l) => l.startsWith('picture:'))).toEqual([
      'picture:selection',
      'picture:viewport',
      'picture:board',
    ])
    expect(p.context.pictures?.map((x) => x.of)).toEqual([
      'selection',
      'viewport',
      'board',
    ])
  })

  it('a removed selection chip means no grant and no picture of it, even with things selected', async () => {
    const { b, log } = bridge(['a', 'b'])
    const p = await prepareContext(
      b,
      upload(log),
      { ...defaultChips(), selectionOff: true },
      'ask',
    )
    expect(p.context.selection).toEqual([])
    expect(p.context.attach?.selection).toBe('none')
    expect(log).toEqual(['settle'])
  })

  it('nothing selected, nothing attached: a plain question with the viewport', async () => {
    const { b, log } = bridge([])
    const p = await prepareContext(b, upload(log), defaultChips(), 'ask')
    expect(p.context).toMatchObject({
      selection: [],
      attach: { selection: 'none' },
      pictures: [],
    })
    expect(log).toEqual(['settle'])
  })

  it('skips a picture of nothing (an empty board)', async () => {
    const { b, log } = bridge(['a'])
    b.picture = async () => null
    const p = await prepareContext(b, upload(log), defaultChips(), 'ask')
    expect(p.context.pictures).toEqual([])
    expect(log).toEqual(['settle'])
  })
})

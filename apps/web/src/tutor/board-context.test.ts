// @vitest-environment jsdom
import { DEFAULT_STYLE, type Element } from '@whiteboard/core'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { Editor } from '../editor/editor'
import { mk, mkText, put, setup } from '../editor/test-utils'
import {
  type BoardBridge,
  createEditorBridge,
  prepareContext,
} from './board-context'
import { defaultChips } from './chips'

beforeAll(() => {
  // jsdom has no object URLs
  URL.createObjectURL = vi.fn(() => 'blob:local')
})

const png = () =>
  new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
function bridge(selection: string[], ink = false) {
  const log: string[] = []
  const b: BoardBridge = {
    selection: () => selection,
    selectionHasInk: () => ink,
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

  it('handwriting in the selection forces exactly one picture on a structure-only chip; a text-only selection sends none', async () => {
    const structure = { ...defaultChips(), selection: 'structure' as const }
    const ink = bridge(['s1', 's2', 'r'], true)
    const p = await prepareContext(ink.b, upload(ink.log), structure, 'ask')
    expect(ink.log).toEqual(['settle', 'picture:selection', 'upload'])
    expect(p.context).toMatchObject({
      selection: ['s1', 's2', 'r'],
      attach: { selection: 'both', viewport: 'none', board: 'none' },
    })
    expect(p.context.pictures).toHaveLength(1)

    const text = bridge(['t'], false)
    const q = await prepareContext(text.b, upload(text.log), structure, 'ask')
    expect(text.log).toEqual(['settle'])
    expect(q.context.pictures).toEqual([])
    expect(q.context.attach?.selection).toBe('structure')
  })

  it('handwriting does not attach a picture by itself: no selection chip, no picture; the viewport stays opt-in', async () => {
    const off = bridge(['s1'], true)
    const p = await prepareContext(
      off.b,
      upload(off.log),
      { ...defaultChips(), selectionOff: true },
      'ask',
    )
    expect(p.context.pictures).toEqual([])
    expect(p.context.attach).toEqual({
      selection: 'none',
      viewport: 'none',
      board: 'none',
    })
  })
})

describe('createEditorBridge.selectionHasInk', () => {
  let ed: Editor
  let done: () => void
  beforeEach(() => {
    ;({ ed, done } = setup())
  })
  afterEach(() => done())
  const stroke = (id: string): Element => ({
    id,
    type: 'freehand',
    x: 0,
    y: 0,
    w: 20,
    h: 10,
    rotation: 0,
    z: 'a1',
    style: { ...DEFAULT_STYLE, strokeWidth: 3 },
    locked: false,
    author: { kind: 'human', id: 'local' },
    v: 0,
    data: {
      points: [
        [0, 0],
        [20, 10],
      ],
      smoothing: 0.5,
      highlighter: false,
    },
  })

  it('is true only while a freehand element is selected', () => {
    put(ed, mk('r', 0, 0), mkText('t', 200, 0), stroke('s'))
    const bridge = createEditorBridge(ed, async () => {})
    expect(bridge.selectionHasInk()).toBe(false)
    ed.selection.add('r')
    ed.selection.add('t')
    expect(bridge.selectionHasInk()).toBe(false)
    ed.selection.add('s')
    expect(bridge.selectionHasInk()).toBe(true)
    ed.selection.delete('s')
    expect(bridge.selectionHasInk()).toBe(false)
  })
})

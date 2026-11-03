// @vitest-environment jsdom
import { DEFAULT_STYLE, type Element } from '@whiteboard/core'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useJump } from './jump'

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const box = (id: string, x: number, y: number, w = 100, h = 50): Element =>
  ({
    id,
    type: 'shape',
    x,
    y,
    w,
    h,
    rotation: 0,
    z: `a${id}`,
    style: { ...DEFAULT_STYLE },
    locked: false,
    author: { kind: 'agent', id: 'tutor:t1' },
    v: 0,
    data: { kind: 'rect' },
  }) as Element

function fakeEditor(els: Element[]) {
  const host = document.createElement('div')
  host.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
    }) as DOMRect
  const camListeners = new Set<() => void>()
  const ed = {
    scene: { els: new Map(els.map((e) => [e.id, e])) },
    camera: { x: 0, y: 0, zoom: 1 },
    viewport: { width: 800, height: 600, dpr: 1 },
    host,
    flyTo: vi.fn(async () => 'done' as const),
    pulse: vi.fn(),
    worldToClient: (p: { x: number; y: number }) => ({
      x: p.x - ed.camera.x,
      y: p.y - ed.camera.y,
    }),
    onCameraChange: (fn: () => void) => {
      camListeners.add(fn)
      return () => camListeners.delete(fn)
    },
  }
  return {
    ed,
    moveCamera: (x: number) =>
      act(async () => {
        ed.camera = { ...ed.camera, x }
        for (const fn of camListeners) fn()
      }),
  }
}

type Jump = ReturnType<typeof useJump>
let unmount: (() => Promise<void>) | undefined
afterEach(async () => {
  await unmount?.()
  unmount = undefined
})
type Probed = {
  jump?: Jump
  followOff: number
  notices: string[]
  follow: boolean
}
// the component under test reads its inputs from here, so it can live at module level
const probe: { ed: unknown; out: Probed; now?: () => number } = {
  ed: null,
  out: { followOff: 0, notices: [], follow: false },
}
function Probe() {
  const { out } = probe
  out.jump = useJump(probe.ed as never, {
    follow: out.follow,
    onFollowOff: () => {
      out.followOff++
      out.follow = false
    },
    notify: (t) => out.notices.push(t),
    now: probe.now,
  })
  return null
}
async function mount(
  ed: ReturnType<typeof fakeEditor>['ed'],
  o: { follow?: boolean; now?: () => number } = {},
) {
  probe.ed = ed
  probe.now = o.now
  probe.out = { followOff: 0, notices: [], follow: o.follow ?? false }
  const el = document.createElement('div')
  const root = createRoot(el)
  await act(async () => root.render(createElement(Probe)))
  unmount = async () => act(async () => root.unmount())
  return probe.out
}
const agentBatch = (id: string, bounds = { x: 5000, y: 0, w: 100, h: 50 }) => ({
  seq: 1,
  batch: {
    batchId: `b-${id}`,
    label: 'Add',
    ops: [{ op: 'add' as const, el: box(id, bounds.x, bounds.y) }],
  },
  author: { kind: 'agent' as const, id: 'tutor:t1' },
  turnId: 't1',
  bounds,
})

describe('locate', () => {
  it('flies to the elements where they are now, pulses them, and remembers where it came from', async () => {
    const { ed } = fakeEditor([box('a', 2000, 1000)])
    const j = await mount(ed)
    await act(
      async () =>
        void (await j.jump?.locate([
          { ids: ['a'], bounds: { x: 0, y: 0, w: 1, h: 1 } },
        ])),
    )
    expect(ed.flyTo).toHaveBeenCalledWith(
      { minX: 2000, minY: 1000, maxX: 2100, maxY: 1050 },
      { padding: 64, maxZoom: 2 },
    )
    expect(ed.pulse).toHaveBeenCalledWith(['a'])
    expect(j.jump?.canBack).toBe(true)
    expect(j.jump?.ghost).toBeNull()
  })

  it('with nothing left it shows a ghost frame where the work was, and does not pulse', async () => {
    const { ed } = fakeEditor([])
    const j = await mount(ed)
    await act(
      async () =>
        void (await j.jump?.locate([
          { ids: ['gone'], bounds: { x: 100, y: 200, w: 50, h: 40 } },
        ])),
    )
    expect(j.jump?.ghost).toEqual({
      minX: 100,
      minY: 200,
      maxX: 150,
      maxY: 240,
    })
    expect(ed.pulse).not.toHaveBeenCalled()
    expect(ed.flyTo).toHaveBeenCalled()
  })

  it('does nothing for a place it cannot find, and Back returns to the camera before the jump', async () => {
    const { ed } = fakeEditor([box('a', 2000, 1000)])
    const j = await mount(ed)
    let found = true
    await act(async () => {
      found = (await j.jump?.locate([{ ids: ['zz'], bounds: null }])) ?? true
    })
    expect(found).toBe(false)
    expect(ed.flyTo).not.toHaveBeenCalled()
    ed.camera = { x: 30, y: 40, zoom: 0.5 }
    await act(
      async () => void (await j.jump?.locate([{ ids: ['a'], bounds: null }])),
    )
    await act(async () => void (await j.jump?.back()))
    expect(ed.flyTo).toHaveBeenLastCalledWith(
      { minX: 30, minY: 40, maxX: 30 + 1600, maxY: 40 + 1200 },
      { padding: 0, maxZoom: 20 },
    )
    expect(j.jump?.canBack).toBe(false)
  })

  it('reduced motion: no pulse', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { ed } = fakeEditor([box('a', 0, 0)])
    const j = await mount(ed)
    await act(
      async () => void (await j.jump?.locate([{ ids: ['a'], bounds: null }])),
    )
    expect(ed.pulse).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('Follow AI', () => {
  it('never moves the camera when it is off, whatever the AI draws', async () => {
    const { ed } = fakeEditor([box('far', 5000, 0)])
    const j = await mount(ed, { follow: false })
    await act(async () => j.jump?.onAgentBatch(agentBatch('far')))
    expect(ed.flyTo).not.toHaveBeenCalled()
  })

  it('eases to each new AI batch, keeping the zoom, but at most every 600 ms', async () => {
    const { ed } = fakeEditor([box('n1', 5000, 0), box('n2', 6000, 0)])
    ed.camera = { x: 0, y: 0, zoom: 0.8 }
    let t = 10_000
    const j = await mount(ed, { follow: true, now: () => t })
    await act(async () => j.jump?.onAgentBatch(agentBatch('n1')))
    expect(ed.flyTo).toHaveBeenCalledWith(
      { minX: 5000, minY: 0, maxX: 5100, maxY: 50 },
      { padding: 64, maxZoom: 0.8 },
    )
    t += 300
    await act(async () =>
      j.jump?.onAgentBatch(agentBatch('n2', { x: 6000, y: 0, w: 100, h: 50 })),
    )
    expect(ed.flyTo).toHaveBeenCalledTimes(1)
    t += 400
    await act(async () =>
      j.jump?.onAgentBatch(agentBatch('n2', { x: 6000, y: 0, w: 100, h: 50 })),
    )
    expect(ed.flyTo).toHaveBeenCalledTimes(2)
  })

  it("ignores the student's own batches", async () => {
    const { ed } = fakeEditor([])
    const j = await mount(ed, { follow: true })
    await act(async () =>
      j.jump?.onAgentBatch({
        ...agentBatch('x'),
        author: { kind: 'human', id: 'owner' },
      }),
    )
    expect(ed.flyTo).not.toHaveBeenCalled()
  })

  it('turns itself off, with a notice, when the student scrolls or presses on the canvas', async () => {
    const { ed } = fakeEditor([])
    const j = await mount(ed, { follow: true })
    await act(async () => void ed.host.dispatchEvent(new Event('wheel')))
    expect(j.followOff).toBe(1)
    expect(j.notices).toEqual(['Follow AI off (you moved the canvas)'])
  })

  it('a press on the canvas also turns it off', async () => {
    const { ed } = fakeEditor([])
    const j = await mount(ed, { follow: true })
    await act(async () => void ed.host.dispatchEvent(new Event('pointerdown')))
    expect(j.followOff).toBe(1)
  })
})

describe('the arrow for off-screen work', () => {
  it('appears while Follow is off and AI work landed out of sight, counts the batches, and goes when the turn ends', async () => {
    const { ed } = fakeEditor([box('far', 5000, 0), box('far2', 5200, 0)])
    const j = await mount(ed, { follow: false })
    expect(j.jump?.indicator).toBeNull()
    await act(async () => j.jump?.onAgentBatch(agentBatch('far')))
    await act(async () =>
      j.jump?.onAgentBatch(
        agentBatch('far2', { x: 5200, y: 0, w: 100, h: 50 }),
      ),
    )
    expect(j.jump?.indicator).toMatchObject({ n: 2, angle: expect.any(Number) })
    expect(j.jump?.indicator?.x).toBeGreaterThan(700) // on the right edge, 16 px in
    await act(async () => j.jump?.turnEnded())
    expect(j.jump?.indicator).toBeNull()
  })

  it('disappears when the work comes into view, and not for work that is on screen to begin with', async () => {
    const { ed, moveCamera } = fakeEditor([
      box('far', 5000, 0),
      box('near', 100, 100),
    ])
    const j = await mount(ed, { follow: false })
    await act(async () =>
      j.jump?.onAgentBatch(
        agentBatch('near', { x: 100, y: 100, w: 100, h: 50 }),
      ),
    )
    expect(j.jump?.indicator).toBeNull()
    await act(async () => j.jump?.onAgentBatch(agentBatch('far')))
    expect(j.jump?.indicator).not.toBeNull()
    await moveCamera(4800)
    expect(j.jump?.indicator).toBeNull()
  })

  it('Jump to AI locates the latest batch', async () => {
    const { ed } = fakeEditor([box('far', 5000, 0)])
    const j = await mount(ed, { follow: false })
    await act(async () => j.jump?.onAgentBatch(agentBatch('far')))
    await act(async () => void (await j.jump?.locateLatest()))
    expect(ed.flyTo).toHaveBeenCalledWith(
      { minX: 5000, minY: 0, maxX: 5100, maxY: 50 },
      { padding: 64, maxZoom: 2 },
    )
  })
})

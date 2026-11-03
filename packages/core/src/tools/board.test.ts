import { describe, expect, it } from 'vitest'
import { bounds } from '../geometry'
import { nodePlatform, registerBundledFonts } from '../node'
import type { MathEntry, Platform } from '../platform'
import { applyBatch, createScene } from '../scene'
import { DEFAULT_STYLE, type Element } from '../schema'
import { stroke } from '../test-utils'
import { boardTools } from './board'
import {
  ELEMENT_BUDGET,
  type ToolCtx,
  ToolError,
  type ToolOutput,
} from './registry'

registerBundledFonts()
const tool = (name: string) => {
  const t = boardTools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

// A formula provider with fixed metrics; `\bad` fails the way MathJax would.
const math: NonNullable<Platform['math']> = {
  peek: (latex): MathEntry =>
    latex.includes('\\bad')
      ? { ok: false, error: 'Undefined control sequence \\bad' }
      : {
          ok: true,
          width: 4,
          height: 1,
          depth: 0.5,
          bitmapFor: () => null,
          paths: () => null,
        },
  request: (_l, _d, _c, ready) => ready(),
}
const platform: Platform = { ...nodePlatform(), math }

const human = (id: string, over: Partial<Element> = {}): Element =>
  ({
    id,
    type: 'shape',
    x: 0,
    y: 0,
    w: 100,
    h: 60,
    rotation: 0,
    z: `a${id}`,
    style: { ...DEFAULT_STYLE, fill: '#ffffff' },
    locked: false,
    author: { kind: 'human', id: 'owner' },
    v: 0,
    data: { kind: 'rect' },
    ...over,
  }) as Element

function ctxOf(els: Element[] = [], over: Partial<ToolCtx> = {}): ToolCtx {
  return {
    scene: createScene(els),
    platform,
    turnId: 't1',
    author: { kind: 'agent', id: 'tutor:t1' },
    grantedIds: new Set(),
    selection: [],
    added: 0,
    ...over,
  }
}
/** Runs a tool; for a write, applies its batch to the scene (which also validates it) and returns what the model would see. */
async function run(name: string, input: unknown, ctx: ToolCtx) {
  const t = tool(name)
  const out: ToolOutput = await t.execute(t.input.parse(input), ctx)
  if (out.kind === 'write') applyBatch(ctx.scene, out.batch)
  return out
}
/** Runs a tool by name; its throws become rejections, like the adapter sees them. */
const call = async (name: string, input: unknown, ctx: ToolCtx) =>
  tool(name).execute(tool(name).input.parse(input), ctx)
const written = async (name: string, input: unknown, ctx: ToolCtx) => {
  const out = await run(name, input, ctx)
  if (out.kind !== 'write') throw new Error('not a write')
  return out
}
const el = (ctx: ToolCtx, id: string) => ctx.scene.els.get(id) as Element
const overlaps = (a: Element, b: Element) => {
  const [p, q] = [bounds(a), bounds(b)]
  return (
    p.minX < q.maxX && p.maxX > q.minX && p.minY < q.maxY && p.maxY > q.minY
  )
}

describe('add_text', () => {
  it('adds a text element authored by the turn, sized to its layout, at the requested spot', async () => {
    const ctx = ctxOf()
    const out = await written(
      'add_text',
      { text: 'Photosynthesis', placement: { x: 100, y: 50 } },
      ctx,
    )
    const e = el(ctx, out.ids[0] as string)
    expect(e).toMatchObject({
      type: 'text',
      x: 100,
      y: 50,
      author: { kind: 'agent', id: 'tutor:t1' },
      data: { align: 'left', size: 24 },
    })
    expect(e.w).toBeGreaterThan(50)
    expect(e.h).toBeCloseTo(24 * 1.4, 5)
    expect(out.bounds).toMatchObject({ x: 100, y: 50 })
    expect(out.batch.label).toBe('Add text')
  })
  it('right-aligns Arabic and wraps at maxWidth', async () => {
    const ctx = ctxOf()
    const ar = await written('add_text', { text: 'مرحبا بالعالم' }, ctx)
    expect(el(ctx, ar.ids[0] as string)).toMatchObject({
      data: { align: 'right' },
    })
    const long = await written(
      'add_text',
      { text: 'word '.repeat(40), maxWidth: 200 },
      ctx,
    )
    expect(el(ctx, long.ids[0] as string).h).toBeGreaterThan(24 * 1.4 * 3)
    expect(el(ctx, long.ids[0] as string).w).toBeLessThanOrEqual(200)
  })
  it('refuses bad input naming the field and range', () => {
    const t = tool('add_text')
    expect(() => t.input.parse({ text: '' })).toThrow()
    expect(() => t.input.parse({ text: 'x', size: 4 })).toThrow()
  })
})

describe('add_math', () => {
  it('sizes the formula from its metrics', async () => {
    const ctx = ctxOf()
    const out = await written(
      'add_math',
      { latex: 'x^2', size: 20, placement: { x: 0, y: 0 } },
      ctx,
    )
    expect(el(ctx, out.ids[0] as string)).toMatchObject({
      type: 'math',
      w: 80,
      h: 30,
      data: { display: true, size: 20 },
    })
  })
  it('a formula that does not compile comes back with the MathJax message', async () => {
    const t = tool('add_math')
    await expect(
      t.execute(t.input.parse({ latex: '\\bad{x}' }), ctxOf()),
    ).rejects.toThrow(/Undefined control sequence/)
    await expect(
      t.execute(t.input.parse({ latex: '\\bad{x}' }), ctxOf()),
    ).rejects.toBeInstanceOf(ToolError)
  })
})

describe('add_shape and connect', () => {
  it('adds a labelled, filled shape', async () => {
    const ctx = ctxOf()
    const out = await written(
      'add_shape',
      {
        kind: 'ellipse',
        label: 'Sun',
        fill: '#ffd400',
        w: 120,
        h: 120,
        placement: { x: 0, y: 0 },
      },
      ctx,
    )
    expect(el(ctx, out.ids[0] as string)).toMatchObject({
      w: 120,
      h: 120,
      style: { fill: '#ffd400' },
      data: { kind: 'ellipse', label: 'Sun' },
    })
    expect(() =>
      tool('add_shape').input.parse({
        kind: 'rect',
        fill: 'url(javascript:1)',
      }),
    ).toThrow()
  })
  it('connects two shapes with an arrow bound at the facing sides, ending on their edges', async () => {
    const ctx = ctxOf([
      human('a', { x: 0, y: 0 }),
      human('b', { x: 300, y: 10 }),
    ])
    const out = await written('connect', { from: 'a', to: 'b' }, ctx)
    const arrow = el(ctx, out.ids[0] as string)
    expect(arrow).toMatchObject({
      type: 'shape',
      data: {
        kind: 'arrow',
        arrowheads: { end: true },
        start: { id: 'a', fx: 1, fy: 0.5 },
        end: { id: 'b', fx: 0, fy: 0.5 },
      },
    })
    const pts = (arrow as Extract<Element, { type: 'shape' }>).data.points as [
      number,
      number,
    ][]
    const tip = (i: number) => {
      const [px, py] = pts[i] as [number, number]
      return [arrow.x + px, arrow.y + py]
    }
    expect(tip(0)).toEqual([100, 30])
    expect(tip(1)).toEqual([300, 40])
  })
  it('names what is wrong when it cannot connect', async () => {
    const ctx = ctxOf([human('a'), human('b', { x: 200 })])
    const _t = tool('connect')
    await expect(call('connect', { from: 'a', to: 'zz' }, ctx)).rejects.toThrow(
      /to: no element zz/,
    )
    await expect(call('connect', { from: 'a', to: 'a' }, ctx)).rejects.toThrow(
      /different/,
    )
    const arrow = await written('connect', { from: 'a', to: 'b' }, ctx)
    await expect(
      call('connect', { from: arrow.ids[0], to: 'b' }, ctx),
    ).rejects.toThrow(/not other lines/)
  })
})

describe('placement', () => {
  it('relative placement sits beside its anchor with the gap, centred on the other axis', async () => {
    const ctx = ctxOf([human('a', { x: 0, y: 0, w: 100, h: 60 })])
    const out = await written(
      'add_shape',
      {
        kind: 'rect',
        w: 80,
        h: 40,
        placement: { relativeTo: 'a', side: 'right', gap: 30 },
      },
      ctx,
    )
    expect(el(ctx, out.ids[0] as string)).toMatchObject({ x: 130, y: 10 })
    const below = await written(
      'add_shape',
      {
        kind: 'rect',
        w: 100,
        h: 40,
        placement: { relativeTo: 'a', side: 'below' },
      },
      ctx,
    )
    expect(el(ctx, below.ids[0] as string)).toMatchObject({ x: 0, y: 84 })
  })
  it('slides along its side when the spot is taken, and rejects an unknown anchor', async () => {
    const ctx = ctxOf([
      human('a'),
      human('blocker', { x: 124, y: 0, w: 200, h: 60 }),
    ])
    const out = await written(
      'add_shape',
      {
        kind: 'rect',
        w: 80,
        h: 40,
        placement: { relativeTo: 'a', side: 'right' },
      },
      ctx,
    )
    expect(overlaps(el(ctx, out.ids[0] as string), el(ctx, 'blocker'))).toBe(
      false,
    )
    const _t = tool('add_shape')
    await expect(
      call(
        'add_shape',
        {
          kind: 'rect',
          placement: { relativeTo: 'nope', side: 'left' },
        },
        ctx,
      ),
    ).rejects.toThrow(/placement.relativeTo/)
  })
  it('auto on an empty board lands in the middle of what the student sees', async () => {
    const ctx = ctxOf([], { viewport: { x: 1000, y: 500, w: 800, h: 600 } })
    const out = await written('add_shape', { kind: 'rect', w: 100, h: 50 }, ctx)
    const e = el(ctx, out.ids[0] as string)
    expect(e.x + e.w / 2).toBeCloseTo(1400, -2)
    expect(e.y + e.h / 2).toBeCloseTo(800, -2)
  })
  it("twelve auto placements around a selection never overlap each other or the student's work", async () => {
    const ctx = ctxOf(
      [
        human('s', { x: 400, y: 300, w: 200, h: 100 }),
        human('t', { x: 650, y: 300, w: 100, h: 100 }),
      ],
      {
        selection: ['s'],
        viewport: { x: 0, y: 0, w: 1400, h: 900 },
      },
    )
    const made: Element[] = []
    for (let i = 0; i < 12; i++) {
      const out = await written(
        'add_shape',
        { kind: 'rect', w: 140, h: 70 },
        ctx,
      )
      made.push(el(ctx, out.ids[0] as string))
    }
    for (const m of made) {
      expect(overlaps(m, el(ctx, 's'))).toBe(false)
      expect(overlaps(m, el(ctx, 't'))).toBe(false)
    }
    for (let i = 0; i < made.length; i++)
      for (let j = i + 1; j < made.length; j++)
        expect(overlaps(made[i] as Element, made[j] as Element)).toBe(false)
    // the first one is the nearest free spot to the selection
    const near = (made[0] as Element).x + 70 - 500
    expect(Math.abs(near)).toBeLessThan(400)
  })
})

describe('update_elements', () => {
  it("changes the tutor's own elements and a selected student element, nothing else", async () => {
    const ctx = ctxOf(
      [
        human('mine'),
        human('other', { x: 300 }),
        human('locked', { x: 600, locked: true }),
        human('ai', { x: 900, author: { kind: 'agent', id: 'tutor:t0' } }),
      ],
      { grantedIds: new Set(['mine', 'locked']) },
    )
    await written(
      'update_elements',
      {
        updates: [
          { id: 'mine', set: { 'style.stroke': '#ff0000' } },
          { id: 'ai', set: { x: 950 } },
        ],
      },
      ctx,
    )
    expect(el(ctx, 'mine').style.stroke).toBe('#ff0000')
    expect(el(ctx, 'ai').x).toBe(950)
    const t = tool('update_elements')
    const upd = (id: string, set: Record<string, unknown> = { x: 5 }) =>
      t.execute(t.input.parse({ updates: [{ id, set }] }), ctx)
    await expect(upd('other')).rejects.toThrow(
      /belongs to the student and was not selected/,
    )
    await expect(upd('locked')).rejects.toThrow(/locked/)
    await expect(upd('missing')).rejects.toThrow(/no element missing/)
    await expect(upd('mine', { id: 'x' })).rejects.toThrow(
      /"id" is not editable/,
    )
    expect(el(ctx, 'other').x).toBe(300)
  })
  it('rewording text re-measures its box; a moved box drags its arrows along', async () => {
    const ctx = ctxOf([human('a', { x: 0 }), human('b', { x: 300 })], {
      grantedIds: new Set(['a', 'b']),
    })
    const txt = await written(
      'add_text',
      { text: 'hi', placement: { x: 0, y: 500 } },
      ctx,
    )
    const before = el(ctx, txt.ids[0] as string).w
    await written(
      'update_elements',
      {
        updates: [
          {
            id: txt.ids[0],
            set: { 'data.text': 'a much longer sentence than before' },
          },
        ],
      },
      ctx,
    )
    expect(el(ctx, txt.ids[0] as string).w).toBeGreaterThan(before * 3)

    const arrow = await written('connect', { from: 'a', to: 'b' }, ctx)
    await written(
      'update_elements',
      { updates: [{ id: 'b', set: { x: 500, y: 200 } }] },
      ctx,
    )
    const a = el(ctx, arrow.ids[0] as string) as Extract<
      Element,
      { type: 'shape' }
    >
    const last = (a.data.points as [number, number][]).at(-1) as [
      number,
      number,
    ]
    expect(a.x + last[0]).toBeCloseTo(500) // the arrow's tip follows the left edge of b
    expect(a.y + last[1]).toBeCloseTo(230)
  })
})

describe('delete_elements', () => {
  it('removes allowed elements, unbinding arrows that pointed at them', async () => {
    const ctx = ctxOf([human('a'), human('b', { x: 300 })], {
      grantedIds: new Set(['b']),
    })
    const arrow = await written('connect', { from: 'a', to: 'b' }, ctx)
    await written('delete_elements', { ids: ['b'] }, ctx)
    expect(ctx.scene.els.has('b')).toBe(false)
    const a = el(ctx, arrow.ids[0] as string) as Extract<
      Element,
      { type: 'shape' }
    >
    expect(a.data.end).toBeUndefined()
    expect(a.data.start?.id).toBe('a')
    const _t = tool('delete_elements')
    await expect(call('delete_elements', { ids: ['a'] }, ctx)).rejects.toThrow(
      /belongs to the student/,
    )
  })
})

describe('arrows the tutor may not edit are left alone (side-effect patches obey edit rights)', () => {
  const studentArrow = () =>
    human('sa', {
      type: 'shape',
      x: 100,
      y: 30,
      w: 200,
      h: 0,
      data: {
        kind: 'arrow',
        points: [
          [0, 0],
          [200, 0],
        ],
        start: { id: 'a', fx: 1, fy: 0.5 },
        end: { id: 'b', fx: 0, fy: 0.5 },
      },
    } as Partial<Element>)
  const patched = (out: ToolOutput) =>
    out.kind === 'write'
      ? out.batch.ops.flatMap((o) => (o.op === 'patch' ? [o.id] : []))
      : []

  it('moving a box the tutor may edit does not touch a student arrow attached to it, and says so', async () => {
    const ctx = ctxOf([human('a'), human('b', { x: 300 }), studentArrow()], {
      grantedIds: new Set(['b']),
    })
    const out = await written(
      'update_elements',
      { updates: [{ id: 'b', set: { x: 500 } }] },
      ctx,
    )
    expect(patched(out)).toEqual(['b'])
    expect(out.warnings?.join(' ')).toMatch(/1 attached arrow.*not moved/)
  })
  it("deleting a box the tutor may edit leaves a student arrow's binding alone", async () => {
    const ctx = ctxOf([human('a'), human('b', { x: 300 }), studentArrow()], {
      grantedIds: new Set(['b']),
    })
    const out = await written('delete_elements', { ids: ['b'] }, ctx)
    expect(patched(out)).toEqual([])
    expect(out.warnings?.join(' ')).toMatch(/1 attached arrow/)
  })
  it("the tutor's own arrows are still re-routed", async () => {
    const ctx = ctxOf([human('a'), human('b', { x: 300 })], {
      grantedIds: new Set(['b']),
    })
    const arrow = await written('connect', { from: 'a', to: 'b' }, ctx)
    const out = await written(
      'update_elements',
      { updates: [{ id: 'b', set: { x: 500 } }] },
      ctx,
    )
    expect(patched(out)).toEqual(['b', arrow.ids[0]])
  })
})

describe('strokes', () => {
  it('get_elements finds strokes by type and region, and a text search does not trip on them', async () => {
    const ctx = ctxOf([
      stroke('pen', { x: 1000, y: 0 }),
      human('box'),
      human('t', {
        type: 'text',
        data: { text: 'pen', size: 20, align: 'left', dir: 'auto' },
      } as Partial<Element>),
    ])
    const get = async (input: unknown) =>
      (
        (await tool('get_elements').execute(
          tool('get_elements').input.parse(input),
          ctx,
        )) as { data: { elements: { id: string; detail: string }[] } }
      ).data.elements
    expect(await get({ type: 'freehand' })).toMatchObject([
      { id: 'pen', detail: 'stroke, 3 pts' },
    ])
    expect((await get({ text: 'pen' })).map((e) => e.id)).toEqual(['t'])
    expect(
      (await get({ region: { x: 990, y: -10, w: 30, h: 30 } })).map(
        (e) => e.id,
      ),
    ).toEqual(['pen'])
  })
  it('update_elements moves and recolours a stroke it may edit, but not resize, turn or rewrite it', async () => {
    const ctx = ctxOf([stroke('pen')], { grantedIds: new Set(['pen']) })
    await written(
      'update_elements',
      {
        updates: [
          {
            id: 'pen',
            set: { x: 40, y: 50, 'style.stroke': '#ff0000' },
          },
        ],
      },
      ctx,
    )
    expect(el(ctx, 'pen')).toMatchObject({
      x: 40,
      y: 50,
      style: { stroke: '#ff0000' },
    })
    const t = tool('update_elements')
    for (const set of [
      { w: 300 },
      { h: 10 },
      { rotation: 1 },
      { 'data.points': [[0, 0]] },
    ])
      await expect(
        t.execute(t.input.parse({ updates: [{ id: 'pen', set }] }), ctx),
      ).rejects.toThrow(/stroke/)
  })
})

describe('reading and pointing', () => {
  it('get_elements filters by type, author, text and region and says how many more there are', async () => {
    const els = [
      human('t1', {
        type: 'text',
        data: { text: 'Light reactions', size: 20, align: 'left', dir: 'auto' },
      } as Partial<Element>),
      human('s1', { x: 2000 }),
      human('ai1', { author: { kind: 'agent', id: 'tutor:t9' } }),
    ]
    const ctx = ctxOf(els)
    const get = async (input: unknown) =>
      (
        (await tool('get_elements').execute(
          tool('get_elements').input.parse(input),
          ctx,
        )) as {
          data: {
            matches: number
            elements: { id: string; by: string; detail: string }[]
            more?: number
          }
        }
      ).data
    expect((await get({ text: 'LIGHT' })).elements.map((e) => e.id)).toEqual([
      't1',
    ])
    expect((await get({ author: 'ai' })).elements).toMatchObject([
      { id: 'ai1', by: 'AI t9' },
    ])
    expect(
      (
        await get({
          type: 'shape',
          region: { x: 1900, y: -10, w: 300, h: 100 },
        })
      ).elements.map((e) => e.id),
    ).toEqual(['s1'])
    expect((await get({ limit: 1 })).more).toBe(2)
    expect((await get({ ids: ['t1'] })).elements[0]?.detail).toBe(
      '"Light reactions"',
    )
  })
  it('get_board counts by type; focus_region needs ids or a rect', async () => {
    const ctx = ctxOf([human('a'), human('b', { x: 500 })], {
      selection: ['a'],
    })
    const b = (
      (await tool('get_board').execute({}, ctx)) as {
        data: {
          elements: number
          byType: Record<string, number>
          selection: string[]
        }
      }
    ).data
    expect(b).toMatchObject({
      elements: 2,
      byType: { shape: 2 },
      selection: ['a'],
    })
    const f = await tool('focus_region').execute(
      tool('focus_region').input.parse({ ids: ['a', 'b'] }),
      ctx,
    )
    expect(f).toMatchObject({
      kind: 'focus',
      bounds: { x: 0, y: 0, w: 600, h: 60 },
    })
    await expect(call('focus_region', {}, ctx)).rejects.toThrow(
      /ids of elements/,
    )
  })
})

describe('the soft element budget', () => {
  it('warns once a turn is past the limit, but does not refuse', async () => {
    const ctx = ctxOf([], { added: ELEMENT_BUDGET })
    const out = await written('add_text', { text: 'one more' }, ctx)
    expect(out.warnings?.[0]).toMatch(/soft limit of 40.*ask the student/)
    expect(
      (await written('add_text', { text: 'fine' }, ctxOf())).warnings,
    ).toEqual([])
  })
})

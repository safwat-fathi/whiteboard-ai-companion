import { describe, expect, it } from 'vitest'
import { applyBatch, createScene, ordered } from './scene'
import { type Batch, DEFAULT_STYLE, type Element, type Op } from './schema'
import { UndoManager } from './undo'

const shape = (id: string, z = 'a0'): Element => ({
  id,
  type: 'shape',
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  rotation: 0,
  z,
  style: { ...DEFAULT_STYLE },
  locked: false,
  author: { kind: 'human', id: 'u' },
  v: 0,
  data: { kind: 'rect' },
})
const batch = (...ops: Op[]): Batch => ({ batchId: 'b', label: 'T', ops })

// Mimics editor.commit: apply then record.
function setup(els: Element[] = []) {
  const scene = createScene(els)
  const um = new UndoManager(scene, 3)
  const commit = (b: Batch, kind?: 'edit' | 'undo' | 'redo') => {
    um.record(applyBatch(scene, b), b, kind)
  }
  return { scene, um, commit }
}
const snap = (s: ReturnType<typeof createScene>) =>
  ordered(s).map((e) => ({ ...e, v: 0 }))

describe('UndoManager', () => {
  it('round trips add, patch, remove, reorder through undo and redo', () => {
    const { scene, um, commit } = setup([shape('a'), shape('b', 'a1')])
    const base = snap(scene)
    commit(batch({ op: 'add', el: shape('c', 'a2') }))
    commit(batch({ op: 'patch', id: 'a', set: { x: 5, 'style.opacity': 0.5 } }))
    commit(batch({ op: 'remove', id: 'b' }))
    commit(batch({ op: 'reorder', id: 'a', z: 'a3' }))
    const end = snap(scene)
    for (let i = 0; i < 3; i++) {
      const r = um.undo()
      expect(r?.skipped).toBe(0)
      commit(r?.batch as Batch, 'undo')
    }
    expect(snap(scene)).not.toEqual(end)
    for (let i = 0; i < 3; i++) {
      const r = um.redo()
      expect(r?.skipped).toBe(0)
      commit(r?.batch as Batch, 'redo')
    }
    expect(snap(scene)).toEqual(end)
    for (let i = 0; i < 3; i++) commit(um.undo()?.batch as Batch, 'undo')
    expect(um.canUndo).toBe(false)
    expect(snap(scene)).not.toEqual(base) // depth 3 dropped the oldest (add c)
    expect(scene.els.has('c')).toBe(true)
  })

  it('recording a new batch clears redo', () => {
    const { um, commit } = setup([shape('a')])
    commit(batch({ op: 'patch', id: 'a', set: { x: 1 } }))
    commit(um.undo()?.batch as Batch, 'undo')
    expect(um.canRedo).toBe(true)
    commit(batch({ op: 'patch', id: 'a', set: { x: 2 } }))
    expect(um.canRedo).toBe(false)
    expect(um.redo()).toBeNull()
  })

  it('skips an inverse key whose field changed since, applies the rest', () => {
    const { scene, um, commit } = setup([shape('a')])
    commit(batch({ op: 'patch', id: 'a', set: { x: 1, y: 2 } }))
    ;(scene.els.get('a') as Element).x = 9 // changed outside the manager
    const r = um.undo()
    expect(r?.skipped).toBe(1)
    commit(r?.batch as Batch, 'undo')
    const a = scene.els.get('a') as Element
    expect([a.x, a.y]).toEqual([9, 0])
  })

  it('counts a patch whose element is gone and returns an empty batch when all skipped', () => {
    const scene = createScene([shape('a')])
    const um = new UndoManager(scene)
    const b = batch({ op: 'patch', id: 'a', set: { x: 1 } })
    um.record(applyBatch(scene, b), b)
    scene.els.delete('a') // removed outside the manager
    const r = um.undo()
    expect(r).toEqual({
      batch: expect.objectContaining({ ops: [] }),
      skipped: 1,
    })
    expect(um.canUndo).toBe(false)
    expect(um.canRedo).toBe(false)
  })

  it('does not record a no-op inverse', () => {
    const { um, commit } = setup([shape('a')])
    commit(batch({ op: 'patch', id: 'nope', set: { x: 1 } }))
    expect(um.canUndo).toBe(false)
  })

  it('depth cap drops the oldest; undo after clear() is null', () => {
    const { um, commit } = setup([shape('a')])
    for (let i = 1; i <= 5; i++)
      commit(batch({ op: 'patch', id: 'a', set: { x: i } }))
    let n = 0
    while (um.canUndo) {
      commit(um.undo()?.batch as Batch, 'undo')
      n++
    }
    expect(n).toBe(3)
    um.clear()
    expect(um.undo()).toBeNull()
    expect(um.redo()).toBeNull()
  })

  it('serialises and restores both stacks', () => {
    const { scene, um, commit } = setup([shape('a')])
    commit(batch({ op: 'patch', id: 'a', set: { x: 1 } }))
    commit(batch({ op: 'patch', id: 'a', set: { x: 2 } }))
    commit(um.undo()?.batch as Batch, 'undo')
    const json = JSON.parse(JSON.stringify(um.toJSON()))
    const um2 = UndoManager.fromJSON(scene, json)
    expect([um2.canUndo, um2.canRedo]).toEqual([true, true])
    expect(um2.toJSON()).toEqual(um.toJSON())
    commit(um2.redo()?.batch as Batch, 'redo')
    expect((scene.els.get('a') as Element).x).toBe(2)
  })

  it('undo and redo work after fromJSON, with the scene mutated in between', () => {
    const { scene, um, commit } = setup([shape('a')])
    commit(batch({ op: 'patch', id: 'a', set: { x: 1, y: 2 } }))
    const um2 = UndoManager.fromJSON(
      scene,
      JSON.parse(JSON.stringify(um.toJSON())),
    )
    ;(scene.els.get('a') as Element).y = 7 // changed after reload
    const r = um2.undo()
    expect(r?.skipped).toBe(1)
    um2.record(applyBatch(scene, r?.batch as Batch), r?.batch as Batch, 'undo')
    const a = scene.els.get('a') as Element
    expect([a.x, a.y]).toEqual([0, 7])
    const re = um2.redo()
    expect(re?.skipped).toBe(0)
    um2.record(
      applyBatch(scene, re?.batch as Batch),
      re?.batch as Batch,
      'redo',
    )
    expect((scene.els.get('a') as Element).x).toBe(1)
    expect(um2.canUndo).toBe(true)
  })

  it('an unrelated record between undo() and its commit keeps stacks right', () => {
    const { um, commit } = setup([shape('a')])
    commit(batch({ op: 'patch', id: 'a', set: { x: 1 } }))
    commit(batch({ op: 'patch', id: 'a', set: { x: 2 } }))
    const r = um.undo()
    commit(batch({ op: 'patch', id: 'a', set: { y: 3 } })) // edit clears redo, undo not yet committed
    commit(r?.batch as Batch, 'undo')
    expect(um.canUndo).toBe(true)
    expect(um.canRedo).toBe(true)
  })

  it('two undo() calls before their commits do not corrupt the stacks', () => {
    const { scene, um, commit } = setup([shape('a')])
    commit(batch({ op: 'patch', id: 'a', set: { x: 1 } }))
    commit(batch({ op: 'patch', id: 'a', set: { x: 2 } }))
    const r1 = um.undo()
    const r2 = um.undo() // computed against the uncommitted scene: x=2 != written 1 -> all skipped
    expect(r2?.skipped).toBe(1)
    expect(r2?.batch.ops).toEqual([])
    commit(r1?.batch as Batch, 'undo')
    expect((scene.els.get('a') as Element).x).toBe(1)
    expect([um.canUndo, um.canRedo]).toEqual([false, true])
    commit(um.redo()?.batch as Batch, 'redo')
    expect((scene.els.get('a') as Element).x).toBe(2)
    expect(um.canUndo).toBe(true)
  })

  it('skips an add-inverse when the id already exists', () => {
    const { scene, um, commit } = setup([shape('a')])
    commit(batch({ op: 'remove', id: 'a' }))
    scene.els.set('a', shape('a'))
    const r = um.undo()
    expect(r?.skipped).toBe(1)
    expect(r?.batch.ops).toEqual([])
  })

  it('skips a reorder when z changed since', () => {
    const { scene, um, commit } = setup([shape('a')])
    commit(batch({ op: 'reorder', id: 'a', z: 'a5' }))
    ;(scene.els.get('a') as Element).z = 'a9'
    expect(um.undo()?.skipped).toBe(1)
  })

  it('compares object and array values deeply', () => {
    const { scene, um, commit } = setup([shape('a')])
    commit(
      batch({
        op: 'patch',
        id: 'a',
        set: { style: { ...DEFAULT_STYLE, opacity: 0.5 } },
      }),
    )
    ;(scene.els.get('a') as Element).style = { ...DEFAULT_STYLE, opacity: 0.2 }
    expect(um.undo()?.skipped).toBe(1)
    // arrays vs objects never equal
    const pts = shape('p')
    const sc = createScene([pts])
    const m = new UndoManager(sc)
    const b = batch({ op: 'patch', id: 'p', set: { 'data.points': [[0, 0]] } })
    m.record(
      {
        inverse: batch({ op: 'patch', id: 'p', set: { 'data.points': null } }),
        touched: [],
      },
      b,
    )
    ;(pts as unknown as { data: { points: unknown } }).data.points = {
      0: [0, 0],
    }
    expect(m.undo()?.skipped).toBe(1)
  })

  it('round trips an unset (null) patch', () => {
    const { scene, um, commit } = setup([shape('a')])
    commit(batch({ op: 'patch', id: 'a', set: { parentId: 'p' } }))
    commit(um.undo()?.batch as Batch, 'undo')
    expect((scene.els.get('a') as Element).parentId).toBeUndefined()
    commit(um.redo()?.batch as Batch, 'redo')
    expect((scene.els.get('a') as Element).parentId).toBe('p')
  })

  it('fromJSON rejects a malformed blob', () => {
    const s = createScene()
    expect(() =>
      UndoManager.fromJSON(s, { undo: 1, redo: [] } as never),
    ).toThrow(Error)
    expect(
      UndoManager.fromJSON(s, { undo: [], redo: [], maxDepth: -1 }).toJSON()
        .maxDepth,
    ).toBe(200)
  })

  it('fromJSON drops entries that fail the batch schema and counts them', () => {
    const { scene, um, commit } = setup([shape('a')])
    commit(batch({ op: 'patch', id: 'a', set: { x: 1 } }))
    const good = JSON.parse(JSON.stringify(um.toJSON())).undo[0]
    const empty = { batchId: 'x', label: 'x', ops: [] }
    const m = UndoManager.fromJSON(scene, {
      undo: [
        null,
        'junk',
        { original: null, inverse: null },
        { original: good.original, inverse: empty },
        {
          original: { ...good.original, ops: [{ op: 'nope' }] },
          inverse: good.inverse,
        },
        good,
      ],
      redo: [good, {}],
      maxDepth: 200,
    })
    expect(m.dropped).toBe(6)
    expect(m.toJSON().undo).toEqual([good])
    expect(m.toJSON().redo).toEqual([good])
    expect(UndoManager.fromJSON(scene, um.toJSON()).dropped).toBe(0)
    // what survives still undoes
    const r = m.undo()
    expect(r?.batch.ops).toHaveLength(1)
  })
})

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
  const commit = (b: Batch) => {
    um.record(applyBatch(scene, b), b)
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
      commit(r?.batch as Batch)
    }
    expect(snap(scene)).not.toEqual(end)
    for (let i = 0; i < 3; i++) {
      const r = um.redo()
      expect(r?.skipped).toBe(0)
      commit(r?.batch as Batch)
    }
    expect(snap(scene)).toEqual(end)
    for (let i = 0; i < 3; i++) commit(um.undo()?.batch as Batch)
    expect(um.canUndo).toBe(false)
    expect(snap(scene)).not.toEqual(base) // depth 3 dropped the oldest (add c)
    expect(scene.els.has('c')).toBe(true)
  })

  it('recording a new batch clears redo', () => {
    const { um, commit } = setup([shape('a')])
    commit(batch({ op: 'patch', id: 'a', set: { x: 1 } }))
    commit(um.undo()?.batch as Batch)
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
    commit(r?.batch as Batch)
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
      commit(um.undo()?.batch as Batch)
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
    commit(um.undo()?.batch as Batch)
    const json = JSON.parse(JSON.stringify(um.toJSON()))
    const um2 = UndoManager.fromJSON(scene, json)
    expect([um2.canUndo, um2.canRedo]).toEqual([true, true])
    expect(um2.toJSON()).toEqual(um.toJSON())
    commit(um2.redo()?.batch as Batch)
    expect((scene.els.get('a') as Element).x).toBe(2)
  })
})

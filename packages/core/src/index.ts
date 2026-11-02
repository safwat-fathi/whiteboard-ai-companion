import RBush from 'rbush'
import { bounds, hitTest, type Point, type Rect } from './geometry'
import type { Scene } from './scene'
import type { Element, Id } from './schema'

type Item = Rect & { el: Element }

export class SpatialIndex {
  private tree = new RBush<Item>()
  private items = new Map<Id, Item>()

  load(els: Element[]): void {
    this.tree.clear()
    this.items = new Map(els.map((el) => [el.id, { ...bounds(el), el }]))
    this.tree.load([...this.items.values()])
  }

  upsert(el: Element): void {
    this.remove(el.id)
    const item = { ...bounds(el), el }
    this.items.set(el.id, item)
    this.tree.insert(item)
  }

  remove(id: Id): void {
    const old = this.items.get(id)
    if (old) this.tree.remove(old)
    this.items.delete(id)
  }

  search(r: Rect): Element[] {
    return this.tree.search(r).map((i) => i.el)
  }

  /** Topmost element under `p` (higher z string wins, ties by id). Tolerance is 6 / zoom world units. */
  pick(p: Point, zoom: number, scene: Scene): Element | null {
    const pad = 6 / zoom
    let best: Element | null = null
    for (const found of this.search({
      minX: p.x - pad,
      minY: p.y - pad,
      maxX: p.x + pad,
      maxY: p.y + pad,
    })) {
      const el = scene.els.get(found.id)
      if (!el || !hitTest(el, p, pad)) continue
      if (!best || el.z > best.z || (el.z === best.z && el.id > best.id))
        best = el
    }
    return best
  }
}

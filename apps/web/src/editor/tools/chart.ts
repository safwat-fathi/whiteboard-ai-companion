import {
  DEFAULT_STYLE,
  newId,
  ordered,
  type Point,
  zBetween,
} from '@whiteboard/core'
import type { Editor } from '../editor'
import type { Tool } from './index'

const W = 480
const H = 320

/** A click adds a default bar chart centred on it and opens its data grid; the select tool takes over, as after Math. */
export const chartTool = (ed: Editor): Tool => {
  let down: Point | null = null
  return {
    id: 'chart',
    key: 'c',
    onPointerDown(e) {
      down = e.button === 0 ? e.world : null
    },
    onPointerMove() {},
    onPointerUp() {
      const at = down
      down = null
      if (!at || ed.readOnly || ed.tool.id !== 'chart') return
      const id = newId()
      ed.commit({
        batchId: newId(),
        label: 'Add Chart',
        ops: [
          {
            op: 'add',
            el: {
              id,
              type: 'chart',
              x: at.x - W / 2,
              y: at.y - H / 2,
              w: W,
              h: H,
              rotation: 0,
              z: zBetween(ordered(ed.scene).at(-1)?.z ?? null, null),
              style: { ...DEFAULT_STYLE },
              locked: false,
              author: { ...ed.author },
              v: 0,
              data: {
                kind: 'bar',
                categories: ['A', 'B', 'C'],
                series: [{ name: 'Series 1', values: [3, 5, 2] }],
              },
            },
          },
        ],
      })
      ed.selection.clear()
      ed.selection.add(id)
      ed.setTool('select')
      ed.editChart(id)
    },
    onCancel() {
      down = null
    },
  }
}

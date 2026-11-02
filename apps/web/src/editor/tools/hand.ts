import type { Editor } from '../editor'
import type { Tool } from './index'

export const handTool = (ed: Editor): Tool => {
  let last: { x: number; y: number } | null = null
  return {
    id: 'hand',
    key: 'h',
    navigates: true,
    onPointerDown: (e) => {
      last = e.screen
    },
    onPointerMove: (e) => {
      if (!last) return
      ed.panBy(e.screen.x - last.x, e.screen.y - last.y)
      last = e.screen
    },
    onPointerUp: () => {
      last = null
    },
    onCancel: () => {
      last = null
    },
  }
}

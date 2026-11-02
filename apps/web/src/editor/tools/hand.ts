import type { Editor } from '../editor'
import type { Tool } from './index'

let editor: Editor | undefined
let last: { x: number; y: number } | null = null

export const hand: Tool = {
  id: 'hand',
  key: 'h',
  attach: (e) => {
    editor = e
  },
  onPointerDown: (e) => {
    last = e.screen
  },
  onPointerMove: (e) => {
    if (!last) return
    editor?.panBy(e.screen.x - last.x, e.screen.y - last.y)
    last = e.screen
  },
  onPointerUp: () => {
    last = null
  },
  onCancel: () => {
    last = null
  },
}

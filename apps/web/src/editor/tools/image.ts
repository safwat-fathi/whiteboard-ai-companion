import type { Editor } from '../editor'
import type { Tool } from './index'

export function imageTool(editor: Editor): Tool {
  return {
    id: 'image',
    key: 'i',
    onPointerDown(e) {
      editor.openImagePicker(e.world)
      editor.setTool('select')
    },
    onPointerMove() {},
    onPointerUp() {},
  }
}

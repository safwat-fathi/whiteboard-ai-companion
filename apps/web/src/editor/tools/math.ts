import {
  DEFAULT_STYLE,
  type Element,
  FONT_STACK,
  fitMath,
  newId,
  type Platform,
  type Point,
  topZ,
  zBetween,
} from '@whiteboard/core'
import type { Editor } from '../editor'
import {
  createMathEditor,
  type MathEditorHandle,
  type MathEditorState,
} from '../MathEditor'
import type { Tool } from './index'

type MathEl = Element & { type: 'math' }

export type MathTool = Tool & {
  edit(el: MathEl): void
  draft(): MathEl | null
}

const DEFAULT_SIZE = 28

function measureSourceMath(
  latex: string,
  size: number,
  platform: Platform,
): { w: number; h: number } {
  const fontSize = Math.max(10, Math.min(16, size * 0.6))
  const font = `${fontSize}px ${FONT_STACK}`
  const pad = 4
  const lines = (latex || ' ').split('\n')
  let maxW = 0
  for (const line of lines) {
    maxW = Math.max(maxW, platform.measureText(font, line || ' '))
  }
  const w = Math.max(size, Math.ceil(maxW + pad * 2 + 4))
  const h = Math.max(size, Math.ceil(lines.length * fontSize * 1.3 + pad * 2))
  return { w, h }
}

export const mathTool = (ed: Editor): MathTool => {
  let down: Point | null = null
  let cur: { ui: MathEditorHandle; el: MathEl; isNew: boolean } | null = null

  const withState = (
    s: NonNullable<typeof cur>,
    st: MathEditorState,
  ): MathEl => {
    const entry = ed.platform.math?.peek(
      st.latex,
      st.display,
      s.el.style.stroke,
    )
    const { w, h } = entry?.ok
      ? fitMath(entry, st.size)
      : measureSourceMath(st.latex, st.size, ed.platform)
    return {
      ...s.el,
      w,
      h,
      data: {
        latex: st.latex,
        display: st.display,
        size: st.size,
      },
    }
  }

  const sync = () => {
    if (!cur) return
    cur.ui.sync(cur.el.x, cur.el.y)
  }

  // Committing before the renderer has answered (fast typing, first MathJax load) sizes the box from the source text.
  // Once the metrics arrive, refit it so the equation is not drawn small inside a box of the wrong shape.
  const fitWhenReady = (el: MathEl) => {
    const { latex, display, size } = el.data
    const color = el.style.stroke
    ed.platform.math?.request(latex, display, color, () => {
      const cur = ed.scene.els.get(el.id)
      const entry = ed.platform.math?.peek(latex, display, color)
      if (cur?.type !== 'math' || !entry?.ok || ed.readOnly) return
      // Only if nothing touched the element since: a later edit or resize owns its own size.
      if (cur.v !== el.v || cur.w !== el.w || cur.h !== el.h) return
      const { w, h } = fitMath(entry, size)
      if (Math.abs(w - cur.w) < 0.5 && Math.abs(h - cur.h) < 0.5) return
      ed.commit({
        batchId: newId(),
        label: 'Fit Math',
        ops: [{ op: 'patch', id: el.id, set: { w, h } }],
      })
    })
  }

  const commitEdit = () => {
    const s = cur
    if (!s) return
    const st = s.ui.state()
    const blank = !st.latex.trim()
    const id = s.el.id
    const before = ed.scene.els.get(id)
    const late =
      !blank && !ed.platform.math?.peek(st.latex, st.display, s.el.style.stroke)
    try {
      if (s.isNew) {
        if (!blank) {
          ed.commit({
            batchId: newId(),
            label: 'Add Math',
            ops: [{ op: 'add', el: withState(s, st) }],
          })
        }
      } else if (blank) {
        ed.commit({
          batchId: newId(),
          label: 'Delete Math',
          ops: [{ op: 'remove', id }],
        })
      } else if (
        st.latex !== s.el.data.latex ||
        st.display !== s.el.data.display ||
        st.size !== s.el.data.size
      ) {
        const updated = withState(s, st)
        ed.commit({
          batchId: newId(),
          label: 'Edit Math',
          ops: [
            {
              op: 'patch',
              id,
              set: {
                'data.latex': st.latex,
                'data.display': st.display,
                'data.size': st.size,
                w: updated.w,
                h: updated.h,
              },
            },
          ],
        })
      }
    } finally {
      cur = null
      s.ui.destroy()
      ed.hidden = null
      ed.invalidate()
    }
    const landed = ed.scene.els.get(id)
    if (late && landed?.type === 'math' && landed !== before)
      fitWhenReady(landed)
    ed.selection.clear()
    if (ed.scene.els.has(id)) ed.selection.add(id)
    ed.setTool('select')
  }

  const cancelEdit = () => {
    const s = cur
    if (!s) return
    const id = s.el.id
    cur = null
    s.ui.destroy()
    ed.hidden = null
    ed.invalidate()
    ed.markDirty()
    ed.selection.clear()
    if (!s.isNew && ed.scene.els.has(id)) ed.selection.add(id)
    ed.setTool('select')
  }

  const begin = (el: MathEl, isNew: boolean) => {
    if (cur) commitEdit()
    const ui = createMathEditor(ed, el, {
      onChange: () => ed.markDirty(),
      onCommit: commitEdit,
      onEscape: cancelEdit,
    })
    cur = { ui, el, isNew }
    ed.hidden = isNew ? null : el.id
    ed.invalidate()
  }

  return {
    id: 'math',
    key: 'm',
    edit: (el) => begin(el, false),
    draft: () => {
      if (!cur) return null
      const st = cur.ui.state()
      return st.latex.trim() ? withState(cur, st) : null
    },
    onPointerDown(e) {
      if (cur) {
        commitEdit()
        ed.tool.onPointerDown(e)
        return
      }
      down = e.button === 0 ? e.world : null
    },
    onFrame: sync,
    onPointerMove() {},
    onPointerUp() {
      const at = down
      down = null
      if (!at || cur || ed.tool.id !== 'math') return
      begin(
        {
          id: newId(),
          type: 'math',
          x: at.x,
          y: at.y,
          w: DEFAULT_SIZE,
          h: DEFAULT_SIZE,
          rotation: 0,
          z: zBetween(topZ(ed.scene), null),
          style: { ...DEFAULT_STYLE },
          locked: false,
          author: { ...ed.author },
          v: 0,
          data: { latex: '', display: true, size: DEFAULT_SIZE },
        },
        true,
      )
    },
    onDoubleClick(e) {
      const hit = ed.index.pick(e.world, ed.camera.zoom, ed.scene)
      if (hit?.type === 'math') {
        if (cur?.isNew && !cur.ui.state().latex.trim()) {
          cancelEdit()
        }
        ed.editMath(hit.id)
      }
    },
    onCancel: commitEdit,
  }
}

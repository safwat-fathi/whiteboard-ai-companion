import {
  DEFAULT_STYLE,
  type Element,
  FONT_STACK,
  layoutText,
  newId,
  ordered,
  resolveDir,
  zBetween,
} from '@whiteboard/core'
import type { Editor } from '../editor'
import type { Tool } from './index'

type TextEl = Element & { type: 'text' }
export type TextTool = Tool & { edit(el: TextEl): void }

const SIZE = 24
const SLACK = 2 // css px of room at the text's trailing edge so the caret is not clipped (no horizontal scroll jump)

/**
 * The edited element is hidden from the canvas (Editor.hidden) while a transparent <textarea> sits over it, so the
 * text is drawn once. Commit (blur, Esc, Ctrl/Cmd+Enter, click elsewhere) is one batch; Esc commits, it does not discard.
 */
export const textTool = (ed: Editor): TextTool => {
  let cur: { ta: HTMLTextAreaElement; el: TextEl; isNew: boolean } | null = null

  // The element as it would be committed for `text` (layout is the source of w/h).
  const withText = (s: NonNullable<typeof cur>, text: string): TextEl => {
    const align = s.isNew
      ? resolveDir(text, 'auto') === 'rtl'
        ? 'right'
        : 'left'
      : s.el.data.align
    const el: TextEl = { ...s.el, data: { ...s.el.data, text, align } }
    const l = layoutText(el, ed.platform)
    return { ...el, w: Math.max(1, l.width), h: Math.max(1, l.height) }
  }

  const sync = () => {
    if (!cur) return
    const el = withText(cur, cur.ta.value)
    const z = ed.camera.zoom
    const { align, size } = el.data
    const shift = align === 'right' ? SLACK : align === 'center' ? SLACK / 2 : 0
    const p = ed.worldToClient(el)
    const r = ed.host.getBoundingClientRect()
    const st = cur.ta.style
    cur.ta.dir = resolveDir(cur.ta.value, el.data.dir)
    st.left = `${p.x - r.left - shift}px`
    st.top = `${p.y - r.top}px`
    st.width = `${el.w * z + SLACK}px`
    st.height = `${el.h * z}px`
    st.fontSize = `${size * z}px`
    st.textAlign = align
    st.whiteSpace = el.data.maxWidth === undefined ? 'pre' : 'pre-wrap'
    st.transform = `rotate(${el.rotation}rad)`
  }

  const finish = () => {
    const s = cur
    if (!s) return
    cur = null
    s.ta.remove()
    ed.hidden = null
    const text = s.ta.value
    const blank = !text.trim()
    const id = s.el.id
    if (s.isNew) {
      if (!blank)
        ed.commit({
          batchId: newId(),
          label: 'Add Text',
          ops: [{ op: 'add', el: withText(s, text) }],
        })
    } else if (blank) {
      ed.commit({
        batchId: newId(),
        label: 'Delete Text',
        ops: [{ op: 'remove', id }],
      })
    } else if (text !== s.el.data.text) {
      const el = withText(s, text)
      ed.commit({
        batchId: newId(),
        label: 'Edit Text',
        ops: [
          {
            op: 'patch',
            id,
            set: { 'data.text': text, w: el.w, h: el.h },
          },
        ],
      })
    }
    ed.selection.clear()
    if (ed.scene.els.has(id)) ed.selection.add(id)
    ed.setTool('select')
    ed.invalidate()
  }

  const begin = (el: TextEl, isNew: boolean) => {
    const ta = document.createElement('textarea')
    ta.setAttribute('aria-label', 'Text')
    ta.value = el.data.text
    ta.style.cssText =
      'position:absolute;z-index:2;margin:0;padding:0;border:0;outline:0;background:transparent;resize:none;overflow:hidden;' +
      `font-family:${FONT_STACK};line-height:1.4;transform-origin:center;caret-color:${el.style.stroke};color:${el.style.stroke}`
    cur = { ta, el, isNew }
    ed.hidden = isNew ? null : el.id
    ed.host.append(ta)
    ta.addEventListener('input', sync)
    ta.addEventListener('blur', finish)
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing) return // Esc/Enter belong to the IME while composing
      if (
        e.key === 'Escape' ||
        (e.key === 'Enter' && (e.ctrlKey || e.metaKey))
      ) {
        e.preventDefault()
        finish()
      }
    })
    sync()
    ta.focus({ preventScroll: true })
    ed.invalidate()
  }

  return {
    id: 'text',
    key: 't',
    edit: (el) => begin(el, false),
    onPointerDown() {
      // Clicking away while editing commits (the blur that follows is then a no-op).
      if (cur) finish()
    },
    onPointerMove() {},
    // Creating on pointer-up: the browser moves focus on mousedown, which would blur a textarea focused earlier.
    onPointerUp(e) {
      if (e.button !== 0 || cur || ed.tool.id !== 'text') return
      begin(
        {
          id: newId(),
          type: 'text',
          x: e.world.x,
          y: e.world.y,
          w: 1,
          h: SIZE * 1.4,
          rotation: 0,
          z: zBetween(ordered(ed.scene).at(-1)?.z ?? null, null),
          style: { ...DEFAULT_STYLE },
          locked: false,
          author: { kind: 'human', id: 'local' },
          v: 0,
          data: { text: '', size: SIZE, align: 'left', dir: 'auto' },
        },
        true,
      )
    },
    onCancel: finish,
  }
}

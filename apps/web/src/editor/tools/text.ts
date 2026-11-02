import {
  DEFAULT_STYLE,
  type Element,
  FONT_STACK,
  layoutText,
  newId,
  ordered,
  type Point,
  resolveDir,
  zBetween,
} from '@whiteboard/core'
import type { Editor } from '../editor'
import type { Tool } from './index'

type TextEl = Element & { type: 'text' }
export type TextTool = Tool & {
  edit(el: TextEl): void
  /**
   * The open edit as the element it would commit, or null (nothing open, or blank). Persistence saves it without it
   * entering the scene or the undo history. A blank draft is null even for an existing text: its original stays
   * saved until Delete Text is committed, so a reload never loses text the user has not yet removed for good.
   */
  draft(): TextEl | null
}

const SIZE = 24
const SLACK = 2 // css px of room at the text's trailing edge so the caret is not clipped (no horizontal scroll jump)

/**
 * The edited element is hidden from the canvas (Editor.hidden) while a transparent <textarea> sits over it, so the
 * text is drawn once. Blank text deletes an existing element (undoable). Commit (blur, Esc, Ctrl/Cmd+Enter, click elsewhere) is one batch; Esc commits, it does not discard.
 */
export const textTool = (ed: Editor): TextTool => {
  let down: Point | null = null
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
    // auto = per-paragraph direction, as layoutText does; forced ltr/rtl keep the plain dir attribute
    st.unicodeBidi = el.data.dir === 'auto' ? 'plaintext' : 'normal'
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
    const text = s.ta.value
    const blank = !text.trim()
    const id = s.el.id
    // Commit first and tear down in `finally`: `cur` stays set while committing (getSnapshot swaps by id, so the
    // draft never doubles the element being added), and a throwing commit still removes the textarea and `hidden`.
    try {
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
    } finally {
      cur = null
      s.ta.remove()
      ed.hidden = null
      ed.invalidate() // the element comes back on the canvas, also when the commit threw
    }
    ed.selection.clear()
    if (ed.scene.els.has(id)) ed.selection.add(id)
    ed.setTool('select')
  }

  const begin = (el: TextEl, isNew: boolean) => {
    const ta = document.createElement('textarea')
    ta.setAttribute('aria-label', 'Text')
    ta.maxLength = 100_000 // the schema's text limit: a longer paste would fail the commit and lose everything
    ta.value = el.data.text
    ta.style.cssText = `position:absolute;z-index:2;margin:0;padding:0;border:0;outline:0;background:transparent;resize:none;overflow:hidden;font-family:${FONT_STACK};line-height:1.4;transform-origin:center`
    // Properties, not cssText: a stroke string must not be able to add declarations.
    ta.style.color = ta.style.caretColor = el.style.stroke
    cur = { ta, el, isNew }
    ed.hidden = isNew ? null : el.id
    ed.host.append(ta)
    ta.addEventListener('input', () => {
      sync()
      ed.markDirty() // autosave picks the draft up through getSnapshot
    })
    ta.addEventListener('blur', finish)
    // Esc/Enter belong to the IME while composing. Safari reports keyCode 229 and fires keydown after compositionend,
    // so the flag is cleared a tick late.
    let composing = false
    ta.addEventListener('compositionstart', () => {
      composing = true
    })
    ta.addEventListener('compositionend', () =>
      setTimeout(() => {
        composing = false
      }),
    )
    ta.addEventListener('keydown', (e) => {
      if (composing || e.isComposing || e.keyCode === 229) return
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
    draft: () => (cur?.ta.value.trim() ? withText(cur, cur.ta.value) : null),
    onPointerDown(e) {
      // Clicking away while editing commits (the blur that follows is then a no-op) and the click goes on to the select tool.
      if (cur) {
        finish()
        ed.tool.onPointerDown(e)
        return
      }
      down = e.button === 0 ? e.world : null
    },
    onFrame: sync,
    onPointerMove() {},
    // Creating on pointer-up: the browser moves focus on mousedown, which would blur a textarea focused earlier.
    onPointerUp() {
      const at = down
      down = null
      if (!at || cur || ed.tool.id !== 'text') return
      begin(
        {
          id: newId(),
          type: 'text',
          x: at.x,
          y: at.y,
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

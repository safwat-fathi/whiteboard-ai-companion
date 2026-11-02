import { type Element, fitMath } from '@whiteboard/core'
import type { Editor } from './editor'

type MathEl = Element & { type: 'math' }

const MONO_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
const DEBOUNCE_MS = 150

export type MathEditorState = {
  latex: string
  display: boolean
  size: number
}

export type MathEditorHandle = {
  readonly root: HTMLDivElement
  readonly textarea: HTMLTextAreaElement
  state(): MathEditorState
  sync(x: number, y: number): void
  destroy(): void
}

function clampSize(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  return Math.max(8, Math.min(1000, Math.round(n)))
}

export function createMathEditor(
  ed: Editor,
  el: MathEl,
  callbacks: {
    onChange: () => void
    onCommit: () => void
    onEscape: () => void
  },
): MathEditorHandle {
  let display = el.data.display
  let size = el.data.size
  let disposed = false
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const root = document.createElement('div')
  root.setAttribute('data-testid', 'math-editor')
  root.style.cssText =
    'position:absolute;z-index:3;display:flex;flex-direction:column;gap:6px;padding:8px;min-width:240px;background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 4px 12px rgba(15,23,42,0.12);font:12px system-ui,sans-serif;color:#0f172a'

  const stop = (e: Event) => e.stopPropagation()
  for (const evt of ['pointerdown', 'mousedown', 'dblclick', 'wheel']) {
    root.addEventListener(evt, stop)
  }

  const controls = document.createElement('div')
  controls.style.cssText = 'display:flex;align-items:center;gap:6px'

  const displayBtn = document.createElement('button')
  displayBtn.type = 'button'
  displayBtn.setAttribute('aria-label', 'Display mode')
  displayBtn.style.cssText =
    'font:inherit;padding:2px 8px;border:1px solid #cbd5e1;border-radius:4px;background:#f8fafc;color:#0f172a;cursor:pointer'

  const syncDisplayBtn = () => {
    displayBtn.setAttribute('aria-pressed', String(display))
    displayBtn.textContent = display ? 'Display' : 'Inline'
  }
  syncDisplayBtn()

  const sizeLabel = document.createElement('label')
  sizeLabel.style.cssText =
    'display:flex;align-items:center;gap:4px;margin-left:auto'
  sizeLabel.textContent = 'Size'

  const sizeInput = document.createElement('input')
  sizeInput.type = 'number'
  sizeInput.min = '8'
  sizeInput.max = '1000'
  sizeInput.value = String(size)
  sizeInput.setAttribute('aria-label', 'Font size')
  sizeInput.style.cssText =
    'width:56px;font:inherit;padding:2px 4px;border:1px solid #cbd5e1;border-radius:4px'
  sizeLabel.append(sizeInput)

  controls.append(displayBtn, sizeLabel)

  const ta = document.createElement('textarea')
  ta.setAttribute('aria-label', 'LaTeX')
  ta.setAttribute('spellcheck', 'false')
  ta.setAttribute('autocapitalize', 'off')
  ta.dir = 'ltr'
  ta.maxLength = 4000
  ta.rows = 3
  ta.value = el.data.latex
  ta.style.cssText = `margin:0;padding:6px;border:1px solid #cbd5e1;border-radius:4px;outline:0;resize:vertical;font:13px/1.4 ${MONO_STACK};direction:ltr;unicode-bidi:normal`
  ta.style.color = el.style.stroke
  ta.style.caretColor = el.style.stroke

  const previewWrap = document.createElement('div')
  previewWrap.style.cssText =
    'min-height:36px;display:flex;align-items:center;justify-content:center;padding:4px;background:#f8fafc;border-radius:4px;overflow:auto'

  const previewCanvas = document.createElement('canvas')
  previewCanvas.setAttribute('data-testid', 'math-preview')
  previewCanvas.style.cssText = 'display:none;max-width:100%'
  previewWrap.append(previewCanvas)

  const errBox = document.createElement('div')
  errBox.setAttribute('data-testid', 'math-error')
  errBox.setAttribute('role', 'alert')
  errBox.style.cssText = `display:none;color:#dc2626;font:12px/1.35 ${MONO_STACK};white-space:pre-wrap;word-break:break-word`

  root.append(controls, ta, previewWrap, errBox)
  ed.host.append(root)

  const applyEntry = (
    latex: string,
    disp: boolean,
    sz: number,
    mySeq: number,
  ) => {
    if (disposed || mySeq !== seq) return
    const entry = ed.platform.math?.peek(latex, disp, el.style.stroke)
    if (!entry) return
    if (!entry.ok) {
      previewCanvas.style.display = 'none'
      errBox.textContent = entry.error
      errBox.style.display = 'block'
      return
    }
    errBox.textContent = ''
    errBox.style.display = 'none'
    const dpr = ed.viewport.dpr || 1
    const { w, h } = fitMath(entry, sz)
    const pw = Math.max(1, Math.min(1024, Math.ceil(w * dpr)))
    const ph = Math.max(1, Math.min(1024, Math.ceil(h * dpr)))
    previewCanvas.width = pw
    previewCanvas.height = ph
    previewCanvas.style.width = `${Math.round(pw / dpr)}px`
    previewCanvas.style.height = `${Math.round(ph / dpr)}px`
    previewCanvas.style.display = 'block'
    const ctx = previewCanvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, pw, ph)
    const bmp = entry.bitmapFor(sz * dpr)
    if (bmp) {
      ctx.drawImage(bmp, 0, 0, pw, ph)
      bmp.close?.()
    }
  }

  const runPreview = (mySeq: number) => {
    if (disposed || mySeq !== seq) return
    const latex = ta.value
    if (!latex.trim()) {
      previewCanvas.style.display = 'none'
      errBox.textContent = ''
      errBox.style.display = 'none'
      return
    }
    const disp = display
    const sz = size
    const provider = ed.platform.math
    if (!provider) return
    const cached = provider.peek(latex, disp, el.style.stroke)
    if (cached) {
      applyEntry(latex, disp, sz, mySeq)
      return
    }
    provider.request(latex, disp, el.style.stroke, () => {
      applyEntry(latex, disp, sz, mySeq)
    })
  }

  const schedulePreview = (immediate = false) => {
    const mySeq = ++seq
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (!ta.value.trim()) {
      previewCanvas.style.display = 'none'
      errBox.textContent = ''
      errBox.style.display = 'none'
      return
    }
    if (immediate) {
      runPreview(mySeq)
    } else {
      timer = setTimeout(() => {
        timer = undefined
        runPreview(mySeq)
      }, DEBOUNCE_MS)
    }
  }

  ta.addEventListener('input', () => {
    schedulePreview(false)
    callbacks.onChange()
  })

  displayBtn.addEventListener('click', () => {
    display = !display
    syncDisplayBtn()
    schedulePreview(false)
    callbacks.onChange()
  })

  sizeInput.addEventListener('input', () => {
    size = clampSize(Number(sizeInput.value), size)
    schedulePreview(false)
    callbacks.onChange()
  })

  let composing = false
  root.addEventListener('compositionstart', () => {
    composing = true
  })
  root.addEventListener('compositionend', () =>
    setTimeout(() => {
      composing = false
    }),
  )
  root.addEventListener('keydown', (e) => {
    if (composing || e.isComposing || e.keyCode === 229) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      callbacks.onEscape()
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      e.stopPropagation()
      callbacks.onCommit()
    }
  })

  const sync = (x: number, y: number) => {
    if (disposed) return
    const p = ed.worldToClient({ x, y })
    const r = ed.host.getBoundingClientRect()
    root.style.left = `${p.x - r.left}px`
    root.style.top = `${p.y - r.top}px`
  }

  sync(el.x, el.y)
  if (el.data.latex.trim()) {
    schedulePreview(true)
  }
  ta.focus({ preventScroll: true })

  return {
    root,
    textarea: ta,
    state: () => ({
      latex: ta.value,
      display,
      size: clampSize(Number(sizeInput.value), size),
    }),
    sync,
    destroy() {
      disposed = true
      seq++
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      root.remove()
    },
  }
}

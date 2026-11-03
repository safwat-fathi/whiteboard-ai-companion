import type { ContextDescriptor } from '@whiteboard/core'
import type { Editor } from '../editor/editor'
import { attachOf, type Chips, wantsPicture } from './chips'
import { PICTURE_PAD, rectOfElements, renderPicture } from './pictures'

type Rect = { x: number; y: number; w: number; h: number }
export type PictureKind = 'selection' | 'viewport' | 'board'

/** What the chat needs from the board, so it can be tested without an Editor. */
export type BoardBridge = {
  selection(): string[]
  /** Calls `fn` when the selection changes. */
  subscribe(fn: () => void): () => void
  viewport(): Rect & { zoom: number }
  /** A PNG of the selection (padded), the viewport or the whole board; null when there is nothing to show. */
  picture(of: PictureKind): Promise<{ png: Blob; rect: Rect } | null>
  /** Resolves once the board's own edits have reached the server (or after a short wait). */
  settle(): Promise<void>
}

export type Prepared = {
  context: Partial<ContextDescriptor>
  /** Local copies of the pictures, for "What the AI sees". */
  thumbs: { of: PictureKind; url: string }[]
}

/**
 * The descriptor for one message: waits for pending edits to land (so the server's board matches what the student
 * sees), renders and uploads the pictures the chips ask for, and sends the selection as the edit grant only while the
 * selection chip is on.
 */
export async function prepareContext(
  bridge: BoardBridge,
  upload: (png: Blob) => Promise<string>,
  chips: Chips,
  mode: ContextDescriptor['mode'],
): Promise<Prepared> {
  await bridge.settle()
  const selected = bridge.selection()
  const attach = attachOf(chips, selected.length)
  const pictures: ContextDescriptor['pictures'] = []
  const thumbs: Prepared['thumbs'] = []
  for (const of of ['selection', 'viewport', 'board'] as const) {
    if (!wantsPicture(attach[of])) continue
    const pic = await bridge.picture(of)
    if (!pic) continue
    pictures.push({ blobId: await upload(pic.png), of, rect: pic.rect })
    thumbs.push({ of, url: URL.createObjectURL(pic.png) })
  }
  const v = bridge.viewport()
  return {
    context: {
      mode,
      viewport: v,
      selection: attach.selection === 'none' ? [] : selected,
      attach,
      pictures,
    },
    thumbs,
  }
}

const toWire = (r: {
  minX: number
  minY: number
  maxX: number
  maxY: number
}): Rect => ({
  x: r.minX,
  y: r.minY,
  w: r.maxX - r.minX,
  h: r.maxY - r.minY,
})

const toBlob = (c: unknown): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const canvas = c as HTMLCanvasElement & OffscreenCanvas
    if (typeof canvas.convertToBlob === 'function')
      return void canvas
        .convertToBlob({ type: 'image/png' })
        .then(resolve, reject)
    canvas.toBlob(
      (b) =>
        b ? resolve(b) : reject(new Error('could not encode the picture')),
      'image/png',
    )
  })

/** The bridge over the real editor. `settle` is the sync client's "my edits are acknowledged". */
export function createEditorBridge(
  editor: Editor,
  settle: () => Promise<void>,
): BoardBridge {
  const view = () => {
    const z = editor.camera.zoom
    return {
      x: editor.camera.x,
      y: editor.camera.y,
      w: editor.viewport.width / z,
      h: editor.viewport.height / z,
      zoom: z,
    }
  }
  return {
    selection: () => [...editor.selection],
    subscribe: (fn) => editor.onSelectionChange(fn),
    viewport: view,
    settle,
    async picture(of) {
      const all = [...editor.scene.els.values()]
      const v = view()
      const rect =
        of === 'selection'
          ? rectOfElements(
              all.filter((e) => editor.selection.has(e.id)),
              PICTURE_PAD,
            )
          : of === 'viewport'
            ? { minX: v.x, minY: v.y, maxX: v.x + v.w, maxY: v.y + v.h }
            : rectOfElements(all, PICTURE_PAD)
      if (!rect) return null
      const { png } = await renderPicture({
        scene: editor.scene,
        platform: editor.platform,
        rect,
        createCanvas: (w, h) => editor.platform.createCanvas(w, h),
        encode: toBlob,
      })
      return { png, rect: toWire(rect) }
    },
  }
}

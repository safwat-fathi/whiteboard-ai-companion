// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { RenderCache } from '@whiteboard/core'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdbBlobStore } from './blobs'
import { createBitmapProvider, importImage } from './images'
import { setup } from './test-utils'

let t: ReturnType<typeof setup>

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  t = setup()
})

afterEach(() => {
  t.done()
})

function makePngBytes(w = 64, h = 48, tag = 0): Uint8Array {
  const buf = new Uint8Array(36)
  // PNG signature
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  // IHDR length (13) + 'IHDR'
  buf.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8)
  const dv = new DataView(buf.buffer)
  dv.setUint32(16, w, false)
  dv.setUint32(20, h, false)
  buf[24] = 8 // bit depth
  buf[25] = 6 // RGBA
  dv.setUint32(32, tag, false)
  return buf
}

function makeFakePngHeader(w: number, h: number): Uint8Array {
  return makePngBytes(w, h)
}

/** Minimal valid JPEG with APP1 Exif orientation tag and SOF0 header. */
function makeExifJpegBytes(
  w: number,
  h: number,
  orientation: number,
): Uint8Array {
  const exifPayload = new Uint8Array([
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00, // Exif\0\0
    0x49,
    0x49,
    0x2a,
    0x00,
    0x08,
    0x00,
    0x00,
    0x00, // TIFF II + offset 8
    0x01,
    0x00, // 1 directory entry
    0x12,
    0x01, // Tag 0x0112 (Orientation)
    0x03,
    0x00, // Type SHORT (3)
    0x01,
    0x00,
    0x00,
    0x00, // Count 1
    orientation & 0xff,
    (orientation >> 8) & 0xff,
    0x00,
    0x00, // Value
    0x00,
    0x00,
    0x00,
    0x00, // Next IFD offset 0
  ])
  const app1Len = exifPayload.length + 2
  // SOF0 marker: FF C0, length 11 (0x00 0x0b), precision 8, height (2B BE), width (2B BE), 1 component (1, 0x11, 0)
  const sof0 = new Uint8Array([
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (h >> 8) & 0xff,
    h & 0xff,
    (w >> 8) & 0xff,
    w & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9, // EOI
  ])
  const out = new Uint8Array(2 + 4 + exifPayload.length + sof0.length)
  out[0] = 0xff
  out[1] = 0xd8 // SOI
  out[2] = 0xff
  out[3] = 0xe1 // APP1
  out[4] = (app1Len >> 8) & 0xff
  out[5] = app1Len & 0xff
  out.set(exifPayload, 6)
  out.set(sof0, 6 + exifPayload.length)
  return out
}

/** Minimal valid 2-frame animated GIF (4x2). */
function makeAnimatedGifBytes(): Uint8Array {
  return new Uint8Array([
    // Header GIF89a
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    // Logical Screen Descriptor: 4x2, GCT 2 colors
    0x04, 0x00, 0x02, 0x00, 0x80, 0x00, 0x00,
    // Global Color Table: black, red
    0x00, 0x00, 0x00, 0xff, 0x00, 0x00,
    // Graphic Control Extension
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
    // Image Descriptor frame 1 (0,0 4x2)
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x02, 0x00, 0x00,
    // LZW min code size 2, data
    0x02, 0x02, 0x4c, 0x01, 0x00,
    // Trailer
    0x3b,
  ])
}

function fileOf(bytes: Uint8Array, name: string, type = 'image/png'): File {
  return new File(
    [
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    ],
    name,
    { type },
  )
}

describe('importImage & Editor.addImages', () => {
  it('rejects 0-byte file, SVG renamed .png, text renamed .png, 12 MB file, and >100 MP header', async () => {
    const store = createIdbBlobStore()

    // 0-byte file
    await expect(
      importImage(fileOf(new Uint8Array(0), 'empty.png'), store),
    ).rejects.toMatchObject({ code: 'unsupported' })

    // SVG renamed .png
    const svgBytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    )
    await expect(
      importImage(fileOf(svgBytes, 'sneaky.png', 'image/png'), store),
    ).rejects.toMatchObject({ code: 'unsupported' })

    // Plain text renamed .png
    const txtBytes = new TextEncoder().encode('hello world not an image')
    await expect(
      importImage(fileOf(txtBytes, 'notes.png', 'image/png'), store),
    ).rejects.toMatchObject({ code: 'unsupported' })

    // 12 MB file (> 10 MB limit)
    const bigBytes = new Uint8Array(12 * 2 ** 20)
    bigBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    await expect(
      importImage(fileOf(bigBytes, 'huge.png'), store),
    ).rejects.toMatchObject({ code: 'too-large' })

    // 100+ megapixel PNG header (12000 x 10000 = 120 MP) rejected before decode
    const bombHeader = makeFakePngHeader(12000, 10000)
    await expect(
      importImage(fileOf(bombHeader, 'bomb.png'), store),
    ).rejects.toMatchObject({ code: 'too-large' })
  })

  it('applies EXIF orientation (swapping dimensions for 90 deg rotation) and downscales >4096 long edge', async () => {
    const store = createIdbBlobStore()
    // 80x40 JPEG with EXIF orientation 6 (90 deg CW) -> upright dimensions 40x80
    const exifJpeg = makeExifJpegBytes(80, 40, 6)
    const res = await importImage(
      fileOf(exifJpeg, 'rotated.jpg', 'image/jpeg'),
      store,
    )
    expect(res.naturalW).toBe(40)
    expect(res.naturalH).toBe(80)
    expect(await store.has(res.blobId)).toBe(true)

    // 5000x2500 PNG -> downscaled to 4096x2048
    const largePng = makePngBytes(5000, 2500)
    const scaled = await importImage(fileOf(largePng, 'big.png'), store)
    expect(scaled.naturalW).toBe(4096)
    expect(scaled.naturalH).toBe(2048)
  })

  it('imports animated GIF as first frame PNG', async () => {
    const store = createIdbBlobStore()
    const gif = makeAnimatedGifBytes()
    const res = await importImage(fileOf(gif, 'anim.gif', 'image/gif'), store)
    expect(res.naturalW).toBe(4)
    expect(res.naturalH).toBe(2)
    const stored = await store.get(res.blobId)
    expect(stored?.mime).toBe('image/png')
  })

  it('deduplicates identical drops (1 blob, 2 elements), places 10 files in a 4-col grid in 1 undo step', async () => {
    const png = makePngBytes(120, 80)
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put')

    const r1 = await t.ed.addImages([fileOf(png, 'a.png')])
    const r2 = await t.ed.addImages([fileOf(png, 'b.png')])
    expect(r1.added).toHaveLength(1)
    expect(r2.added).toHaveLength(1)
    expect(t.ed.scene.els.size).toBe(2)
    // Only 1 blob write for identical image bytes
    expect(putSpy).toHaveBeenCalledTimes(1)
    putSpy.mockRestore()

    // 10 files dropped at once -> 10 elements in 1 batch and 1 undo step
    const tenFiles = Array.from({ length: 10 }, (_, i) =>
      fileOf(makePngBytes(60 + i, 40), `img-${i}.png`),
    )
    const r10 = await t.ed.addImages(tenFiles, { x: 100, y: 100 })
    expect(r10.added).toHaveLength(10)
    expect(r10.failed).toHaveLength(0)
    expect(t.ed.scene.els.size).toBe(12)

    // Check grid positions: 4 columns -> first 4 share row 0 (y=100), 5th is on row 1 (y > 100)
    const addedEls = r10.added.map((id) => t.ed.scene.els.get(id))
    expect(addedEls[0]?.y).toBe(addedEls[1]?.y)
    expect(addedEls[0]?.y).toBe(addedEls[3]?.y)
    expect(addedEls[4]?.x).toBe(addedEls[0]?.x)
    expect(addedEls[4]?.y).toBeGreaterThan(addedEls[0]?.y ?? 0)

    // Single undo removes all 10
    t.ed.undoOnce()
    expect(t.ed.scene.els.size).toBe(2)
  })

  it('handles quota exceeded, IndexedDB unavailable, read-only tab, and paste without image', async () => {
    const notices: string[] = []
    t.ed.onNotice = (msg) => notices.push(msg)

    // Paste without image does nothing
    const pasteEv = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(pasteEv, 'clipboardData', {
      value: {
        items: [{ kind: 'string', type: 'text/plain' }],
        files: [],
      },
    })
    window.dispatchEvent(pasteEv)
    expect(t.ed.scene.els.size).toBe(0)

    // Quota exceeded -> notice and no element added
    const spy = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementationOnce(() => {
        throw new DOMException('full', 'QuotaExceededError')
      })
    const rq = await t.ed.addImages([fileOf(makePngBytes(32, 32), 'q.png')])
    expect(rq.added).toHaveLength(0)
    expect(rq.failed).toHaveLength(1)
    expect(t.ed.scene.els.size).toBe(0)
    expect(notices.length).toBeGreaterThan(0)
    spy.mockRestore()

    // IndexedDB unavailable -> notice and no element added
    vi.stubGlobal('indexedDB', undefined)
    const ru = await t.ed.addImages([fileOf(makePngBytes(32, 32), 'u.png')])
    expect(ru.added).toHaveLength(0)
    expect(ru.failed).toHaveLength(1)
    expect(t.ed.scene.els.size).toBe(0)
    globalThis.indexedDB = new IDBFactory()

    // Read-only second tab cannot add images
    t.ed.readOnly = true
    const rr = await t.ed.addImages([fileOf(makePngBytes(32, 32), 'ro.png')])
    expect(rr.added).toHaveLength(0)
    expect(rr.failed).toHaveLength(1)
    expect(t.ed.scene.els.size).toBe(0)
  })

  it('createBitmapProvider decodes once per blob into RenderCache original tier and marks missing blobs', async () => {
    const store = createIdbBlobStore()
    const png = makePngBytes(40, 30)
    const { blobId } = await importImage(fileOf(png, 'p.png'), store)
    const cache = new RenderCache()
    const onReady = vi.fn()
    const provider = createBitmapProvider(store, cache, onReady)

    expect(provider.peek(blobId)).toBeUndefined()
    await new Promise<void>((resolve) => provider.request(blobId, resolve))
    expect(onReady).toHaveBeenCalledTimes(1)
    const hit = provider.peek(blobId)
    expect(hit).toMatchObject({ w: 40, h: 30 })
    expect(cache.bytes).toBe(40 * 30 * 4)

    // Missing blob
    const missingId = 'f'.repeat(64)
    await new Promise<void>((resolve) => provider.request(missingId, resolve))
    expect(provider.peek(missingId)).toBe('missing')
    cache.dispose()
  })
})

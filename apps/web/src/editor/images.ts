import {
  BlobError,
  type BlobStore,
  type ImageBitmapEntry,
  type ImageProvider,
  parseImageHeader,
  type RenderCache,
  sniffMime,
} from '@whiteboard/core'

export const MAX_IMAGE_BYTES = 10 * 2 ** 20 // 10 MB
export const MAX_IMAGE_PIXELS = 100_000_000 // 100 MP
export const MAX_IMAGE_SIDE = 4096

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer())
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () =>
      reject(new BlobError('unsupported', 'Could not read image file'))
    reader.readAsArrayBuffer(blob)
  })
}

async function reencodeInBrowser(
  bmp: ImageBitmap,
  targetW: number,
  targetH: number,
  outMime: 'image/png' | 'image/jpeg',
): Promise<Uint8Array | null> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(targetW, targetH)
    const g = c.getContext('2d')
    if (!g) return null
    g.drawImage(bmp, 0, 0, targetW, targetH)
    if (typeof c.convertToBlob === 'function') {
      const blob = await c.convertToBlob({
        type: outMime,
        quality: outMime === 'image/jpeg' ? 0.92 : undefined,
      })
      return readBlobBytes(blob)
    }
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = targetW
    c.height = targetH
    const g = c.getContext('2d')
    if (!g || typeof c.toBlob !== 'function') return null
    g.drawImage(bmp, 0, 0, targetW, targetH)
    const blob = await new Promise<Blob | null>((r) =>
      c.toBlob(r, outMime, outMime === 'image/jpeg' ? 0.92 : undefined),
    )
    if (blob) return readBlobBytes(blob)
  }
  return null
}

export async function importImage(
  file: Blob & { name?: string },
  store: BlobStore,
): Promise<{ blobId: string; naturalW: number; naturalH: number }> {
  if (file.size === 0) {
    throw new BlobError('unsupported', 'Image file is empty')
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new BlobError('too-large', 'Image exceeds the 10 MB limit')
  }
  const bytes = await readBlobBytes(file)
  if (bytes.byteLength === 0) {
    throw new BlobError('unsupported', 'Image file is empty')
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new BlobError('too-large', 'Image exceeds the 10 MB limit')
  }

  const mime = sniffMime(bytes)
  if (!mime) {
    throw new BlobError(
      'unsupported',
      'Unsupported image format (only PNG, JPEG, WebP, and GIF are allowed)',
    )
  }

  const header = parseImageHeader(bytes, mime)
  if (!header || header.width < 1 || header.height < 1) {
    throw new BlobError('unsupported', 'Corrupt or unreadable image header')
  }
  if (header.width * header.height > MAX_IMAGE_PIXELS) {
    throw new BlobError('too-large', 'Image exceeds the 100 megapixel limit')
  }

  const swapped = header.exifOrientation >= 5 && header.exifOrientation <= 8
  let uprightW = swapped ? header.height : header.width
  let uprightH = swapped ? header.width : header.height

  let bmp: ImageBitmap | null = null
  if (typeof createImageBitmap === 'function') {
    try {
      bmp = await createImageBitmap(
        new Blob(
          [
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          ],
          { type: mime },
        ),
        { imageOrientation: 'from-image' },
      )
      if (bmp.width * bmp.height > MAX_IMAGE_PIXELS) {
        bmp.close()
        throw new BlobError(
          'too-large',
          'Image exceeds the 100 megapixel limit',
        )
      }
      // If browser applied EXIF orientation, bmp dimensions already reflect uprightW/uprightH
      if (!swapped || bmp.width === uprightW) {
        uprightW = bmp.width
        uprightH = bmp.height
      }
    } catch (e) {
      if (e instanceof BlobError) throw e
      throw new BlobError('unsupported', 'Could not decode image')
    }
  }

  const maxSide = Math.max(uprightW, uprightH)
  const scale = maxSide > MAX_IMAGE_SIDE ? MAX_IMAGE_SIDE / maxSide : 1
  const naturalW = Math.max(1, Math.round(uprightW * scale))
  const naturalH = Math.max(1, Math.round(uprightH * scale))
  const needsTransform =
    scale < 1 || mime === 'image/gif' || header.exifOrientation !== 1

  let outBytes = bytes
  let outMime: string = mime === 'image/gif' ? 'image/png' : mime

  if (bmp) {
    try {
      if (needsTransform) {
        const targetMime: 'image/png' | 'image/jpeg' =
          mime === 'image/jpeg' ? 'image/jpeg' : 'image/png'
        const encoded = await reencodeInBrowser(
          bmp,
          naturalW,
          naturalH,
          targetMime,
        )
        if (encoded) {
          outBytes = encoded
          outMime = targetMime
        }
      }
    } finally {
      bmp.close()
    }
  }

  const blobId = await store.put(outBytes, outMime)
  return { blobId, naturalW, naturalH }
}

type CachedOrig = {
  bitmap: CanvasImageSource & { close?(): void }
  w: number
  h: number
  close(): void
}

export function createBitmapProvider(
  store: BlobStore,
  cache: RenderCache,
  onReady?: () => void,
): ImageProvider {
  const missing = new Set<string>()
  const oversize = new Map<string, CachedOrig>()
  const inflight = new Map<string, Promise<void>>()
  const held = (blobId: string) =>
    oversize.get(blobId) ?? cache.get<CachedOrig>(1, `orig:${blobId}`, 0)

  return {
    peek(blobId: string): ImageBitmapEntry | 'missing' | undefined {
      if (missing.has(blobId)) return 'missing'
      const hit = held(blobId)
      if (!hit) return undefined
      return { bitmap: hit.bitmap, w: hit.w, h: hit.h }
    },

    request(blobId: string, cb: () => void): void {
      if (missing.has(blobId) || held(blobId)) {
        cb()
        onReady?.()
        return
      }
      const existing = inflight.get(blobId)
      if (existing) {
        void existing.then(() => {
          cb()
          onReady?.()
        })
        return
      }

      const task = (async () => {
        const rec = await store.get(blobId)
        if (!rec) {
          missing.add(blobId)
          return
        }
        const mime = sniffMime(rec.bytes) ?? 'image/png'
        const header = parseImageHeader(rec.bytes, mime)
        const swapped =
          header !== null &&
          header.exifOrientation >= 5 &&
          header.exifOrientation <= 8
        let w = header ? (swapped ? header.height : header.width) : 100
        let h = header ? (swapped ? header.width : header.height) : 100
        let bitmap: CanvasImageSource & { close?(): void }

        if (typeof createImageBitmap === 'function') {
          try {
            const bmp = await createImageBitmap(
              new Blob(
                [
                  rec.bytes.buffer.slice(
                    rec.bytes.byteOffset,
                    rec.bytes.byteOffset + rec.bytes.byteLength,
                  ) as ArrayBuffer,
                ],
                { type: rec.mime },
              ),
              { imageOrientation: 'from-image' },
            )
            w = bmp.width
            h = bmp.height
            bitmap = bmp
          } catch {
            missing.add(blobId)
            return
          }
        } else {
          bitmap = {
            close() {},
          } as unknown as CanvasImageSource & { close?(): void }
        }

        const entry: CachedOrig = {
          bitmap,
          w,
          h,
          close() {
            bitmap.close?.()
          },
        }
        const bytes = w * h * 4
        // RenderCache.set drops an entry bigger than its budget, so peek() would miss on every frame and re-decode
        // forever. Hold such an original here instead (one per blob, at most 64 MB each after import's 4096 px cap).
        if (bytes > cache.cap) oversize.set(blobId, entry)
        else cache.set(1, `orig:${blobId}`, 0, entry, bytes, 'original')
      })().finally(() => {
        inflight.delete(blobId)
      })

      inflight.set(blobId, task)
      void task.then(() => {
        cb()
        onReady?.()
      })
    },
  }
}

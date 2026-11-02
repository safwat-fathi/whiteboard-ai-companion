import {
  BlobError,
  type BlobStore,
  type ImageBitmapEntry,
  type ImageProvider,
  type RenderCache,
} from '@whiteboard/core'

export const MAX_IMAGE_BYTES = 10 * 2 ** 20 // 10 MB
export const MAX_IMAGE_PIXELS = 100_000_000 // 100 MP
export const MAX_IMAGE_SIDE = 4096

export type AllowedMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'

export function sniffMime(bytes: Uint8Array): AllowedMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

export function parseImageHeader(
  bytes: Uint8Array,
  mime: AllowedMime,
): { width: number; height: number; exifOrientation: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mime === 'image/png') {
    if (bytes.length < 24) return null
    return {
      width: dv.getUint32(16, false),
      height: dv.getUint32(20, false),
      exifOrientation: 1,
    }
  }
  if (mime === 'image/gif') {
    if (bytes.length < 10) return null
    return {
      width: dv.getUint16(6, true),
      height: dv.getUint16(8, true),
      exifOrientation: 1,
    }
  }
  if (mime === 'image/webp') {
    if (bytes.length < 30) return null
    const tag = String.fromCharCode(
      bytes[12] ?? 0,
      bytes[13] ?? 0,
      bytes[14] ?? 0,
      bytes[15] ?? 0,
    )
    if (tag === 'VP8 ') {
      return {
        width: dv.getUint16(26, true) & 0x3fff,
        height: dv.getUint16(28, true) & 0x3fff,
        exifOrientation: 1,
      }
    }
    if (tag === 'VP8L') {
      const b0 = bytes[21] ?? 0
      const b1 = bytes[22] ?? 0
      const b2 = bytes[23] ?? 0
      const b3 = bytes[24] ?? 0
      return {
        width: 1 + (b0 | ((b1 & 0x3f) << 8)),
        height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
        exifOrientation: 1,
      }
    }
    if (tag === 'VP8X') {
      const w =
        1 +
        ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16))
      const h =
        1 +
        ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16))
      return { width: w, height: h, exifOrientation: 1 }
    }
    return null
  }
  if (mime === 'image/jpeg') {
    let offset = 2
    let width = 0
    let height = 0
    let exifOrientation = 1
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break
      while (offset < bytes.length && bytes[offset] === 0xff) offset++
      if (offset >= bytes.length) break
      const marker = bytes[offset++] ?? 0
      if (marker === 0xd9 || marker === 0xda) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
      if (offset + 2 > bytes.length) break
      const segLen = dv.getUint16(offset, false)
      if (segLen < 2 || offset + segLen > bytes.length) break

      if (
        marker === 0xe1 &&
        segLen >= 14 &&
        bytes[offset + 2] === 0x45 &&
        bytes[offset + 3] === 0x78 &&
        bytes[offset + 4] === 0x69 &&
        bytes[offset + 5] === 0x66 &&
        bytes[offset + 6] === 0x00 &&
        bytes[offset + 7] === 0x00
      ) {
        const tiff = offset + 8
        const byteOrder = dv.getUint16(tiff, false)
        const le = byteOrder === 0x4949
        if (le || byteOrder === 0x4d4d) {
          const ifdOffset = dv.getUint32(tiff + 4, le)
          const dir = tiff + ifdOffset
          if (dir + 2 <= offset + segLen) {
            const count = dv.getUint16(dir, le)
            for (let i = 0; i < count; i++) {
              const entry = dir + 2 + i * 12
              if (entry + 12 > offset + segLen) break
              const tag = dv.getUint16(entry, le)
              if (tag === 0x0112) {
                const val = dv.getUint16(entry + 8, le)
                if (val >= 1 && val <= 8) exifOrientation = val
                break
              }
            }
          }
        }
      } else if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (offset + 7 <= bytes.length) {
          height = dv.getUint16(offset + 3, false)
          width = dv.getUint16(offset + 5, false)
        }
      }
      offset += segLen
    }
    if (width > 0 && height > 0) {
      return { width, height, exifOrientation }
    }
  }
  return null
}

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

import type {
  MathBitmapSource,
  MathEntry,
  MathProvider,
} from '@whiteboard/core'

type MathMod = typeof import('@whiteboard/math')

export function createWebMathProvider(
  onReady?: () => void,
  createPath2D: (d?: string) => Path2D = (d) =>
    typeof Path2D !== 'undefined'
      ? d === undefined
        ? new Path2D()
        : new Path2D(d)
      : ({} as Path2D),
): MathProvider {
  let modPromise: Promise<MathMod> | null = null
  const entries = new Map<string, MathEntry>()
  const inflight = new Map<string, Promise<void>>()

  const getMod = () => {
    if (!modPromise) modPromise = import('@whiteboard/math')
    return modPromise
  }

  const keyOf = (latex: string, display: boolean, color: string) =>
    `${display ? 1 : 0}|${color}|${latex}`

  return {
    peek(latex, display, color) {
      return entries.get(keyOf(latex, display, color))
    },

    request(latex, display, color, cb) {
      const k = keyOf(latex, display, color)
      if (entries.has(k)) {
        cb()
        onReady?.()
        return
      }
      const existing = inflight.get(k)
      if (existing) {
        void existing.then(() => {
          cb()
          onReady?.()
        })
        return
      }

      const task = (async () => {
        const mod = await getMod()
        const res = await mod.renderMath(latex, { display, color })
        if (!res.ok) {
          entries.set(k, res)
          return
        }
        const parsed = mod.svgToPaths(res.svg)
        const decodedBitmaps = new Map<number, ImageBitmap>()
        const decodingKeys = new Set<number>()

        const decodeFromBlobUrl = (pxPerEm: number) => {
          const rounded = Math.round(pxPerEm * 100) / 100
          if (
            decodedBitmaps.has(rounded) ||
            decodingKeys.has(rounded) ||
            typeof URL === 'undefined' ||
            typeof URL.createObjectURL !== 'function' ||
            typeof createImageBitmap !== 'function'
          ) {
            return
          }
          decodingKeys.add(rounded)
          const fixed = mod.fixViewBox(res.svg, pxPerEm)
          const blob = new Blob([fixed.svg], {
            type: 'image/svg+xml;charset=utf-8',
          })
          const url = URL.createObjectURL(blob)
          void createImageBitmap(blob)
            .then((bmp) => {
              decodedBitmaps.set(rounded, bmp)
              onReady?.()
            })
            .catch(() => {
              // Chromium SVG blob decode fallback is already covered by OffscreenCanvas Path2D below
            })
            .finally(() => {
              URL.revokeObjectURL(url)
              decodingKeys.delete(rounded)
            })
        }

        const entry: MathEntry = {
          ok: true,
          width: res.width,
          height: res.height,
          depth: res.depth,
          paths: () => parsed,
          bitmapFor(pxPerEm: number): MathBitmapSource | null {
            if (!parsed) {
              const rounded = Math.round(pxPerEm * 100) / 100
              const predecoded = decodedBitmaps.get(rounded)
              if (predecoded) {
                decodedBitmaps.delete(rounded)
                return predecoded
              }
              decodeFromBlobUrl(pxPerEm)
              return null
            }

            const pw = Math.max(1, Math.ceil(res.width * pxPerEm))
            const ph = Math.max(
              1,
              Math.ceil((res.height + res.depth) * pxPerEm),
            )
            if (typeof OffscreenCanvas !== 'undefined') {
              const c = new OffscreenCanvas(pw, ph)
              const ctx = c.getContext(
                '2d',
              ) as unknown as CanvasRenderingContext2D | null
              if (!ctx) return null
              mod.drawMathPaths(
                ctx,
                parsed,
                0,
                0,
                res.width * pxPerEm,
                (res.height + res.depth) * pxPerEm,
                (d) => createPath2D(d),
              )
              if (typeof c.transferToImageBitmap === 'function') {
                return c.transferToImageBitmap()
              }
              return Object.assign(c as unknown as CanvasImageSource, {
                close() {
                  c.width = 0
                  c.height = 0
                },
              })
            }
            if (typeof document !== 'undefined') {
              const c = document.createElement('canvas')
              c.width = pw
              c.height = ph
              const ctx = c.getContext('2d')
              if (!ctx) return null
              mod.drawMathPaths(
                ctx,
                parsed,
                0,
                0,
                res.width * pxPerEm,
                (res.height + res.depth) * pxPerEm,
                (d) => createPath2D(d),
              )
              return Object.assign(c as unknown as CanvasImageSource, {
                close() {
                  c.width = 0
                  c.height = 0
                },
              })
            }
            return null
          },
        }
        entries.set(k, entry)
      })().finally(() => {
        inflight.delete(k)
      })

      inflight.set(k, task)
      void task.then(() => {
        cb()
        onReady?.()
      })
    },
  }
}

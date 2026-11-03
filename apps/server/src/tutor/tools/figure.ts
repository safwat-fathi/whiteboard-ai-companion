import { createCanvas, loadImage } from '@napi-rs/canvas'
import {
  type BlobStore,
  baseFields,
  defineTool,
  type Element,
  layoutText,
  newId,
  PlacementSchema,
  resolvePlacement,
  stackAbove,
  type ToolDef,
  ToolError,
} from '@whiteboard/core'
import { z } from 'zod'
import type { BooksDb } from '../../db'
import { ApiError } from '../../errors'
import { pageRaster } from '../../library/page-image'

export type FigureDeps = { books: BooksDb; dataDir: string; blobs: BlobStore }

const frac = (min: number) => z.number().min(min).max(1)

/**
 * `add_book_figure`: a picture cut from a book page, placed on the board as an image that remembers where it came from
 * (`source.bookPage`). The page is rendered once at 2048 px wide (cached), cropped, stored as a blob and added in one batch.
 */
export function figureTool(
  deps: FigureDeps,
  scopeBook: () => string | undefined,
): ToolDef {
  return defineTool({
    name: 'add_book_figure',
    description:
      "Put a figure from the student's book on the board: a page, or a region of it, with a caption. Use it to show a diagram or table the book already has instead of redrawing it. Give the page number in the book file (the n of the page you read).",
    input: z.object({
      bookId: z
        .string()
        .min(1)
        .optional()
        .describe("Default: this board's book."),
      page: z.number().int().min(1),
      rect: z
        .object({ x: frac(0), y: frac(0), w: frac(0.02), h: frac(0.02) })
        .refine(
          (r) => r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001,
          'must lie within the page',
        )
        .optional()
        .describe(
          'The region as fractions of the page width and height, from the top-left. Default: the whole page.',
        ),
      caption: z.string().max(200).optional(),
      width: z
        .number()
        .min(80)
        .max(900)
        .optional()
        .describe('Width on the board, default 420.'),
      placement: PlacementSchema.optional(),
    }),
    execute: async (i, ctx) => {
      const id = i.bookId ?? scopeBook()
      const book = id ? deps.books.getBook(id) : undefined
      if (book?.status !== 'ready')
        throw new ToolError(
          `bookId: ${id ? `no book ${id} is ready` : 'give a bookId'}`,
          'bookId',
        )
      if (book.pages !== null && i.page > book.pages)
        throw new ToolError(`page: the book has ${book.pages} pages`, 'page')

      let png: Buffer
      try {
        png = await pageRaster({
          dataDir: deps.dataDir,
          book,
          n: i.page,
          width: 2048,
        })
      } catch (e) {
        if (e instanceof ApiError)
          throw new ToolError(`page: ${e.message}`, 'page')
        throw e
      }
      const page = await loadImage(png)
      const r = i.rect ?? { x: 0, y: 0, w: 1, h: 1 }
      const sx = Math.round(r.x * page.width)
      const sy = Math.round(r.y * page.height)
      const cw = Math.max(
        1,
        Math.min(page.width - sx, Math.round(r.w * page.width)),
      )
      const ch = Math.max(
        1,
        Math.min(page.height - sy, Math.round(r.h * page.height)),
      )
      const canvas = createCanvas(cw, ch)
      canvas.getContext('2d').drawImage(page, sx, sy, cw, ch, 0, 0, cw, ch)
      const blobId = await deps.blobs.put(
        canvas.toBuffer('image/png'),
        'image/png',
      )

      const w = i.width ?? 420
      const h = Math.max(1, Math.round((w * ch) / cw))
      const label = deps.books.getPage(book.id, i.page)?.label
      const captionText = i.caption
        ? `${i.caption} (p. ${label ?? i.page})`
        : undefined
      const [zImg, zCap] = stackAbove(ctx, 2) as [string, string]
      const capDraft = captionText
        ? {
            ...baseFields(ctx, zCap),
            type: 'text' as const,
            x: 0,
            y: 0,
            w: 1,
            h: 1,
            data: {
              text: captionText,
              size: 14,
              align: 'left' as const,
              dir: 'auto' as const,
              maxWidth: w,
            },
          }
        : undefined
      const lay = capDraft ? layoutText(capDraft, ctx.platform) : undefined
      const total = { w, h: h + (lay ? lay.height + 6 : 0) }
      const pos = resolvePlacement(i.placement, total, ctx)
      const image = {
        ...baseFields(ctx, zImg),
        type: 'image' as const,
        ...pos,
        w,
        h,
        data: {
          blobId,
          naturalW: cw,
          naturalH: ch,
          alt:
            i.caption ??
            `Page ${label ?? i.page} of ${book.title}`.slice(0, 500),
          source: { bookPage: { bookId: book.id, page: i.page } },
        },
      }
      const els: Element[] = [image as Element]
      if (capDraft && lay)
        els.push({
          ...capDraft,
          x: pos.x,
          y: pos.y + h + 6,
          w: lay.width,
          h: lay.height,
        } as Element)
      return {
        kind: 'write',
        batch: {
          batchId: newId(),
          label: 'Add book figure',
          ops: els.map((el) => ({ op: 'add' as const, el })),
        },
        ids: els.map((e) => e.id),
        bounds: { x: pos.x, y: pos.y, w: total.w, h: total.h },
        warnings: [],
      }
    },
  }) as ToolDef
}

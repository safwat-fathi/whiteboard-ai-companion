import { z } from 'zod'

// Wire shapes shared by the tutor server and the chat dock (api.md, board-context.md). One place, so the two sides cannot drift.

const blobId = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be a 64-char hex sha256')
const rect = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
})
export const BoundsSchema = rect
export type WireBounds = z.infer<typeof BoundsSchema>

export const TURN_MODES = ['ask', 'explain', 'summarize', 'check'] as const

/** What the student attached to a turn (board-context.md "Descriptor"). Every field has a default, so `{}` is a valid plain question. */
export const ContextDescriptorSchema = z.object({
  boardSeq: z.number().int().min(0).optional(),
  mode: z.enum(TURN_MODES).default('ask'),
  viewport: rect.extend({ zoom: z.number().positive() }).optional(),
  /** Ids selected when the turn starts; also the turn's edit grant. */
  selection: z.array(z.string().min(1)).max(500).default([]),
  attach: z
    .object({
      selection: z
        .enum(['none', 'structure', 'picture', 'both'])
        .default('none'),
      viewport: z.enum(['none', 'picture']).default('none'),
      board: z.enum(['none', 'structure', 'picture', 'both']).default('none'),
    })
    .default({ selection: 'none', viewport: 'none', board: 'none' }),
  pictures: z
    .array(
      z.object({
        blobId,
        of: z.enum(['selection', 'viewport', 'board']),
        rect: rect.optional(),
      }),
    )
    .max(3)
    .default([]),
})
export type ContextDescriptor = z.infer<typeof ContextDescriptorSchema>

export const ChatRequestSchema = z.object({
  boardId: z.string().min(1),
  message: z.object({
    text: z
      .string()
      .trim()
      .min(1, 'must not be empty')
      .max(8000, 'must be at most 8000 chars'),
    images: z.array(blobId).max(4).default([]),
  }),
  context: ContextDescriptorSchema.default(ContextDescriptorSchema.parse({})),
})
export type ChatRequest = z.infer<typeof ChatRequestSchema>

export const UsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  cachedTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** null = unpriced (Meta publishes no price); tokens are always present. */
  costUsd: z.number().min(0).nullable(),
  model: z.string(),
  /** Set when the fallback model answered. */
  fallback: z.boolean().optional(),
  /** `cite:` links the server removed because the model was never shown that page. */
  unverifiedCites: z.number().int().min(0).optional(),
})
export type Usage = z.infer<typeof UsageSchema>

export const TURN_STATES = [
  'thinking',
  'reading',
  'drawing',
  'done',
  'stopped',
] as const

/** Custom parts the chat stream adds to the AI SDK UI message stream (`type: 'data-<name>'`). */
export const DataPartSchemas = {
  turn: z.object({ turnId: z.string() }),
  batch: z.object({
    batchId: z.string(),
    seq: z.number().int(),
    label: z.string(),
    bounds: BoundsSchema.nullable(),
    count: z.number().int().min(0),
  }),
  usage: UsageSchema,
  status: z.object({ state: z.enum(TURN_STATES), text: z.string().optional() }),
  /** The tutor pointed at something without changing it (focus_region). */
  focus: z.object({ bounds: BoundsSchema, note: z.string().optional() }),
  /** A page range the model was shown: the only pages a `cite:` link may name. */
  source: z.object({
    bookId: z.string(),
    pageStart: z.number().int().min(1),
    pageEnd: z.number().int().min(1),
    label: z.string().optional(),
  }),
} as const

/** `[p. 40](cite:<bookId>#<page>)` */
export const citeHref = (bookId: string, page: number) =>
  `cite:${bookId}#${page}`
export const parseCite = (
  href: string,
): { bookId: string; page: number } | null => {
  const m = /^cite:([A-Za-z0-9-]{1,64})#([1-9]\d{0,5})$/.exec(href)
  return m ? { bookId: m[1] as string, page: Number(m[2]) } : null
}

export const MessageDtoSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  role: z.enum(['user', 'assistant']),
  parts: z.array(z.unknown()),
  context: z.unknown().optional(),
  model: z.string().optional(),
  usage: UsageSchema.optional(),
  createdAt: z.number(),
})
export type MessageDto = z.infer<typeof MessageDtoSchema>

export const ActivityTurnSchema = z.object({
  turnId: z.string(),
  startedAt: z.number(),
  userText: z.string(),
  status: z.enum(['running', 'done', 'stopped', 'error']),
  bounds: BoundsSchema.nullable(),
  batches: z.array(DataPartSchemas.batch),
})
export type ActivityTurn = z.infer<typeof ActivityTurnSchema>

export const SettingsSchema = z.object({
  profile: z.string().max(2000, 'must be at most 2000 chars').default(''),
  /** Overrides DAILY_BUDGET_USD when set. */
  dailyBudgetUsd: z.number().min(0).nullable().default(null),
})
export type Settings = z.infer<typeof SettingsSchema>

export const UndoResultSchema = z.object({
  undone: z.number().int().min(0),
  skipped: z.number().int().min(0),
})
export type UndoResult = z.infer<typeof UndoResultSchema>

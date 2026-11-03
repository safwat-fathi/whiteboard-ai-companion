import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { TutorConfig } from '../config'
import { ApiError } from '../errors'

// The only module that talks to the model provider. Everything else sees LanguageModel, StepUsage and ApiError.

export type StepUsage = {
  inputTokens: number
  cachedTokens: number
  outputTokens: number
}

/** The AI SDK's per-step usage, reduced to what the footer and the ledger need. */
export function usageOf(u?: {
  inputTokens?: number
  outputTokens?: number
  inputTokenDetails?: { cacheReadTokens?: number }
}): StepUsage {
  return {
    inputTokens: u?.inputTokens ?? 0,
    cachedTokens: u?.inputTokenDetails?.cacheReadTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
  }
}
export const addUsage = (a: StepUsage, b: StepUsage): StepUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  cachedTokens: a.cachedTokens + b.cachedTokens,
  outputTokens: a.outputTokens + b.outputTokens,
})
export const noUsage = (): StepUsage => ({
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
})

/** USD for a usage, or null while the model is unpriced. ponytail: cached input is billed at the full input price. */
export const costOf = (
  price: TutorConfig['price'],
  u: StepUsage,
): number | null =>
  price
    ? (u.inputTokens * price.inPerM + u.outputTokens * price.outPerM) / 1e6
    : null

/** Arabic board? More than half of the letters in the message are Arabic script. */
export function isMostlyArabic(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? []
  if (letters.length === 0) return false
  const ar = letters.filter((c) => /\p{Script=Arabic}/u.test(c)).length
  return ar / letters.length > 0.5
}
export const pickModel = (t: TutorConfig, text: string): string =>
  isMostlyArabic(text) ? t.modelAr : t.model

const statusOf = (e: unknown): number | undefined => {
  const s = (e as { statusCode?: unknown } | null)?.statusCode
  return typeof s === 'number' ? s : undefined
}

/** Turns a provider failure into the api.md error the chat shows (ai-integration "Errors and fallback"). */
export function upstreamError(e: unknown): ApiError {
  const status = statusOf(e)
  if (status === 402)
    return new ApiError(
      'upstream_error',
      'The AI provider says its quota or credits are exhausted.',
      { status },
    )
  if (status === 429)
    return new ApiError(
      'upstream_error',
      'The AI provider is rate limiting requests. Try again in a moment.',
      { status },
    )
  return new ApiError(
    'upstream_error',
    'The AI provider failed to answer. Try again.',
    status === undefined ? undefined : { status },
  )
}

export type Llm = {
  /** The model for a turn. A 5xx before any output is retried once on the fallback model. */
  model(id: string, fallbackId: string, onFallback?: () => void): LanguageModel
}

export function createLlm(o: {
  baseUrl: string
  apiKey: string | undefined
  fetch?: typeof fetch
}): Llm {
  const provider = createOpenAICompatible({
    name: 'meta',
    baseURL: o.baseUrl,
    apiKey: o.apiKey,
    includeUsage: true,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  })
  return {
    model(id, fallbackId, onFallback) {
      const primary = provider(id)
      const fallback = provider(fallbackId)
      // Delegating through the prototype keeps the provider's getters (supportedUrls) working.
      return Object.create(primary, {
        doStream: {
          value: async (opts: Parameters<typeof primary.doStream>[0]) => {
            try {
              return await primary.doStream(opts)
            } catch (e) {
              if ((statusOf(e) ?? 0) < 500) throw e
              onFallback?.()
              return fallback.doStream(opts)
            }
          },
        },
      }) as LanguageModel
    },
  }
}

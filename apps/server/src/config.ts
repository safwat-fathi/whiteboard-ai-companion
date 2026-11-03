import { resolve } from 'node:path'

export type Config = {
  port: number
  host: string
  dataDir: string
  publicOrigin: string
  /** Presence only: the key values never leave the environment. */
  keys: { meta: boolean; openrouter: boolean }
  /** Meta Model API base URL (no trailing slash) and the models M4 calls: page transcription (R4) and summaries. */
  metaBaseUrl: string
  visionModel: string
  cheapModel: string
  /** Embeddings via OpenRouter; `embedDims` must be a multiple of 4 (the exact-search scan reads four lanes at a time). */
  embedModel: string
  embedDims: number
  /** Daily cap in USD for paid OpenRouter calls (embeddings, opt-in R3). */
  dailyBudgetUsd: number
}

/**
 * Reads the server's environment; throws an Error naming the key for any invalid value. A relative DATA_DIR resolves
 * against `baseDir` (the repo root in main.ts, so `./data` means the same wherever the script's cwd is).
 */
export function loadConfig(
  env: Record<string, string | undefined>,
  baseDir: string = process.cwd(),
): Config {
  const port = Number(env.PORT ?? 4000)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`PORT must be an integer 1..65535, got "${env.PORT}"`)
  let publicOrigin: string
  try {
    publicOrigin = new URL(env.PUBLIC_ORIGIN ?? 'http://localhost:3000').origin
  } catch {
    throw new Error(`PUBLIC_ORIGIN must be a URL, got "${env.PUBLIC_ORIGIN}"`)
  }
  let metaBaseUrl: string
  try {
    const u = new URL(env.META_API_BASE_URL || 'https://api.meta.ai/v1')
    metaBaseUrl = u.href.replace(/\/+$/, '')
  } catch {
    throw new Error(
      `META_API_BASE_URL must be a URL, got "${env.META_API_BASE_URL}"`,
    )
  }
  const embedDims = Number(env.EMBED_DIMS ?? 1024)
  if (!Number.isInteger(embedDims) || embedDims < 4 || embedDims % 4 !== 0)
    throw new Error(
      `EMBED_DIMS must be a positive multiple of 4, got "${env.EMBED_DIMS}"`,
    )
  const dailyBudgetUsd = Number(env.DAILY_BUDGET_USD ?? 5)
  if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd < 0)
    throw new Error(
      `DAILY_BUDGET_USD must be a number >= 0, got "${env.DAILY_BUDGET_USD}"`,
    )
  return {
    port,
    host: env.HOST || '127.0.0.1',
    dataDir: resolve(baseDir, env.DATA_DIR || './data'),
    publicOrigin,
    keys: { meta: !!env.META_API_KEY, openrouter: !!env.OPENROUTER_API_KEY },
    metaBaseUrl,
    visionModel: env.VISION_MODEL || 'muse-spark-1.3',
    cheapModel: env.CHEAP_MODEL || 'muse-spark-1.3',
    embedModel: env.EMBED_MODEL || 'baai/bge-m3',
    embedDims,
    dailyBudgetUsd,
  }
}

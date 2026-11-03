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
  tutor: TutorConfig
}

export type TutorConfig = {
  model: string
  /** Used when the student's message is mostly Arabic. */
  modelAr: string
  /** One retry on a 5xx before any output. */
  fallbackModel: string
  maxSteps: number
  /** Only bites when `price` is set: Meta publishes no price, so turns are unpriced by default. */
  maxTurnCostUsd: number
  turnTimeoutMs: number
  chapterStuffMaxTokens: number
  /** How a snapshot reaches the model; Meta rejects images inside tool results. */
  snapshotAdapter: 'follow-up-user' | 'tool-result-image'
  /** USD per million tokens; null = unpriced (tokens are still counted). */
  price: { inPerM: number; outPerM: number } | null
}

function num(
  env: Record<string, string | undefined>,
  key: string,
  dflt: number,
  ok: (n: number) => boolean,
  what: string,
): number {
  const v = Number(env[key] ?? dflt)
  if (env[key] === '' || !Number.isFinite(v) || !ok(v))
    throw new Error(`${key} must be ${what}, got "${env[key]}"`)
  return v
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
  const adapter = env.SNAPSHOT_ADAPTER || 'follow-up-user'
  if (adapter !== 'follow-up-user' && adapter !== 'tool-result-image')
    throw new Error(
      `SNAPSHOT_ADAPTER must be follow-up-user or tool-result-image, got "${adapter}"`,
    )
  const nonNeg = (n: number) => n >= 0
  const priced = env.TUTOR_PRICE_IN_PER_M || env.TUTOR_PRICE_OUT_PER_M
  const tutor: TutorConfig = {
    model: env.TUTOR_MODEL || 'muse-spark-1.3',
    modelAr: env.TUTOR_MODEL_AR || env.TUTOR_MODEL || 'muse-spark-1.3',
    fallbackModel: env.TUTOR_FALLBACK_MODEL || 'muse-spark-1.3',
    maxSteps: num(
      env,
      'MAX_STEPS',
      12,
      (n) => Number.isInteger(n) && n >= 1,
      'an integer >= 1',
    ),
    maxTurnCostUsd: num(env, 'MAX_TURN_COST_USD', 0.5, nonNeg, 'a number >= 0'),
    turnTimeoutMs: num(
      env,
      'TURN_TIMEOUT_MS',
      120_000,
      (n) => Number.isInteger(n) && n >= 1,
      'an integer >= 1',
    ),
    chapterStuffMaxTokens: num(
      env,
      'CHAPTER_STUFF_MAX_TOKENS',
      60_000,
      (n) => Number.isInteger(n) && n >= 1,
      'an integer >= 1',
    ),
    snapshotAdapter: adapter,
    price: priced
      ? {
          inPerM: num(env, 'TUTOR_PRICE_IN_PER_M', 0, nonNeg, 'a number >= 0'),
          outPerM: num(
            env,
            'TUTOR_PRICE_OUT_PER_M',
            0,
            nonNeg,
            'a number >= 0',
          ),
        }
      : null,
  }
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
    tutor,
  }
}

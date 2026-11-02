import { resolve } from 'node:path'

export type Config = {
  port: number
  host: string
  dataDir: string
  publicOrigin: string
  /** Presence only: the key values never leave the environment. */
  keys: { meta: boolean; openrouter: boolean }
}

/** Reads the server's environment; throws an Error naming the key for any invalid value. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const port = Number(env.PORT ?? 4000)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`PORT must be an integer 1..65535, got "${env.PORT}"`)
  let publicOrigin: string
  try {
    publicOrigin = new URL(env.PUBLIC_ORIGIN ?? 'http://localhost:3000').origin
  } catch {
    throw new Error(`PUBLIC_ORIGIN must be a URL, got "${env.PUBLIC_ORIGIN}"`)
  }
  return {
    port,
    host: env.HOST || '127.0.0.1',
    dataDir: resolve(env.DATA_DIR || './data'),
    publicOrigin,
    keys: { meta: !!env.META_API_KEY, openrouter: !!env.OPENROUTER_API_KEY },
  }
}

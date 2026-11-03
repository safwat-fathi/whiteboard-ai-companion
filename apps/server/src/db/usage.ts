import type Database from 'better-sqlite3'

export type UsageDb = ReturnType<typeof createUsageDb>

const DAY = "strftime('%Y-%m-%d', %COL% / 1000, 'unixepoch')"

/** Read-only sums for the usage view: money from the `spend` ledger, tokens from the stored assistant messages. UTC days. */
export function createUsageDb(db: Database.Database) {
  const spend = db.prepare(
    `SELECT ${DAY.replace('%COL%', 'at')} AS day, kind, SUM(cost_usd) AS costUsd FROM spend
     WHERE at >= ? AND at < ? GROUP BY day, kind`,
  )
  const tokens = db.prepare(
    `SELECT ${DAY.replace('%COL%', 'created_at')} AS day, COUNT(*) AS turns,
       SUM(COALESCE(json_extract(usage, '$.inputTokens'), 0)) AS inputTokens,
       SUM(COALESCE(json_extract(usage, '$.cachedTokens'), 0)) AS cachedTokens,
       SUM(COALESCE(json_extract(usage, '$.outputTokens'), 0)) AS outputTokens
     FROM messages WHERE role = 'assistant' AND usage IS NOT NULL AND created_at >= ? AND created_at < ?
     GROUP BY day`,
  )
  return {
    spendByDay: (from: number, to: number) =>
      spend.all(from, to) as { day: string; kind: string; costUsd: number }[],
    tokensByDay: (from: number, to: number) =>
      tokens.all(from, to) as {
        day: string
        turns: number
        inputTokens: number
        cachedTokens: number
        outputTokens: number
      }[],
  }
}

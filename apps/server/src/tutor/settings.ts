import { type Settings, SettingsSchema } from '@whiteboard/core'
import type { Config } from '../config'
import type { SettingsDb, UsageDb } from '../db'

// The student's profile and budget override, in the key/value `settings` table.

const PROFILE = 'profile'
const BUDGET = 'dailyBudgetUsd'

export function loadSettings(db: SettingsDb): Settings {
  const budget = db.get(BUDGET)
  return SettingsSchema.parse({
    profile: db.get(PROFILE) ?? '',
    dailyBudgetUsd: budget === undefined ? null : Number(budget),
  })
}

export function saveSettings(db: SettingsDb, s: Settings): void {
  if (s.profile.trim()) db.set(PROFILE, s.profile)
  else db.delete(PROFILE)
  if (s.dailyBudgetUsd === null) db.delete(BUDGET)
  else db.set(BUDGET, String(s.dailyBudgetUsd))
}

/** The cap on a day's paid calls: the student's override if set, else DAILY_BUDGET_USD. */
export const dailyCap = (
  db: SettingsDb,
  config: Pick<Config, 'dailyBudgetUsd'>,
): number => {
  const v = db.get(BUDGET)
  const n = v === undefined ? NaN : Number(v)
  return Number.isFinite(n) && n >= 0 ? n : config.dailyBudgetUsd
}

const DAY_MS = 86_400_000
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Spend and tokens per UTC day over `[from, to)`, newest day first, plus today's totals. */
export function usageSummary(
  usage: UsageDb,
  o: { from: number; to: number; now: number; cap: number },
) {
  const days = new Map<
    string,
    {
      day: string
      costUsd: number
      byKind: Record<string, number>
      turns: number
      inputTokens: number
      cachedTokens: number
      outputTokens: number
    }
  >()
  const at = (d: string) => {
    let row = days.get(d)
    if (!row) {
      row = {
        day: d,
        costUsd: 0,
        byKind: {},
        turns: 0,
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
      }
      days.set(d, row)
    }
    return row
  }
  for (const s of usage.spendByDay(o.from, o.to)) {
    const row = at(s.day)
    row.byKind[s.kind] = (row.byKind[s.kind] ?? 0) + s.costUsd
    row.costUsd += s.costUsd
  }
  for (const t of usage.tokensByDay(o.from, o.to))
    Object.assign(at(t.day), {
      turns: t.turns,
      inputTokens: t.inputTokens,
      cachedTokens: t.cachedTokens,
      outputTokens: t.outputTokens,
    })
  const list = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1))
  const today = days.get(day(o.now)) ?? {
    day: day(o.now),
    costUsd: 0,
    byKind: {},
    turns: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
  }
  return {
    days: list,
    today,
    dailyCapUsd: o.cap,
    totalUsd: list.reduce((a, d) => a + d.costUsd, 0),
  }
}
export { DAY_MS }

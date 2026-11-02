const MIN_BUDGET = 128 * 2 ** 20
const MAX_BUDGET = 512 * 2 ** 20
const DEFAULT_BUDGET = 256 * 2 ** 20

export function cacheBudgetBytes(opts: {
  deviceMemoryGB?: number
  dpr: number
}): number {
  const mem = opts.deviceMemoryGB
  const base =
    mem !== undefined && Number.isFinite(mem) && mem > 0
      ? Math.min(
          MAX_BUDGET,
          Math.max(MIN_BUDGET, Math.round(mem * 2 ** 30 * 0.06)),
        )
      : DEFAULT_BUDGET
  return opts.dpr >= 3 ? Math.round(base * 0.75) : base
}

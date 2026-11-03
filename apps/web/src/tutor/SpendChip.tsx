'use client'

import { useCallback, useEffect, useState } from 'react'
import type { LibraryApi, UsageSummary } from '../library/api'
import { CoinsIcon } from '../ui/icons'
import { spendLabel } from './chat-core'
import { SettingsDialog } from './SettingsDialog'

/** The top bar's "$0.42 today" (or tokens, while the model is unpriced); a click opens settings and usage. */
export function SpendChip({
  api,
  refreshKey,
}: {
  api: LibraryApi
  refreshKey: number
}) {
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [open, setOpen] = useState(false)
  const [reload, setReload] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and reload are the triggers
  useEffect(() => {
    let on = true
    api.usage().then(
      (u) => on && setUsage(u),
      () => {}, // a missing chip is better than an error on every page
    )
    return () => {
      on = false
    }
  }, [api, refreshKey, reload])
  const saved = useCallback(() => setReload((n) => n + 1), [])
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        title="Settings and usage"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-full border border-slate-200/90 bg-slate-50/80 px-2.5 py-0.5 text-xs font-medium text-slate-700 transition-all duration-150 hover:border-blue-400 hover:bg-blue-50/50 hover:text-blue-700 cursor-pointer"
      >
        <CoinsIcon size={13} className="text-slate-400" />
        <span>{usage ? spendLabel(usage.today) : 'Usage'}</span>
      </button>
      {open && (
        <SettingsDialog
          api={api}
          onClose={() => setOpen(false)}
          onSaved={saved}
        />
      )}
    </>
  )
}

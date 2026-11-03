'use client'

import { useCallback, useEffect, useState } from 'react'
import type { LibraryApi, UsageSummary } from '../library/api'
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
        style={{
          font: 'inherit',
          border: '1px solid #ccc',
          borderRadius: 14,
          background: '#f6f6f6',
          padding: '2px 10px',
          cursor: 'pointer',
        }}
      >
        {usage ? spendLabel(usage.today) : 'Usage'}
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

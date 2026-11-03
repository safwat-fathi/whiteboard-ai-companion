'use client'

import { useEffect, useState } from 'react'
import { ui } from '../../app/library/ui'
import type { LibraryApi, UsageSummary } from '../library/api'

const n = (x: number) => x.toLocaleString('en-US')
const usd = (x: number) => (x === 0 ? '–' : `$${x.toFixed(x < 0.1 ? 4 : 2)}`)

/** The student's profile, the daily budget and what has been used: one dialog from the spend chip (api.md "settings", "usage"). */
export function SettingsDialog({
  api,
  onClose,
  onSaved,
}: {
  api: LibraryApi
  onClose: () => void
  onSaved?: () => void
}) {
  const [profile, setProfile] = useState('')
  const [budget, setBudget] = useState('')
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let on = true
    Promise.all([api.getSettings(), api.usage()]).then(
      ([s, u]) => {
        if (!on) return
        setProfile(s.profile)
        setBudget(s.dailyBudgetUsd === null ? '' : String(s.dailyBudgetUsd))
        setUsage(u)
        setLoaded(true)
      },
      (e) => {
        if (!on) return
        setError(
          e instanceof Error ? e.message : 'Could not load the settings.',
        )
        setLoaded(true)
      },
    )
    return () => {
      on = false
    }
  }, [api])

  const save = async () => {
    const dailyBudgetUsd = budget.trim() === '' ? null : Number(budget)
    if (
      dailyBudgetUsd !== null &&
      !(Number.isFinite(dailyBudgetUsd) && dailyBudgetUsd >= 0)
    )
      return setError(
        'The daily budget must be a number of dollars, 0 or more, or empty for the default.',
      )
    setSaving(true)
    setError(null)
    try {
      await api.putSettings({ profile, dailyBudgetUsd })
      onSaved?.()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.')
      setSaving(false)
    }
  }

  return (
    <div style={ui.backdrop}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings and usage"
        style={{
          ...ui.dialog,
          maxHeight: '85vh',
          overflow: 'auto',
          minWidth: 340,
          maxWidth: 520,
        }}
      >
        <h2
          style={{ marginTop: 0, fontSize: 18 }}
          className="font-bold text-slate-900"
        >
          Settings and usage
        </h2>
        {error && (
          <p role="alert" style={ui.alert}>
            {error}
          </p>
        )}
        {!loaded ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-slate-700">
              About you (level, goals, language): the tutor reads this before
              every answer
              <textarea
                dir="auto"
                rows={4}
                maxLength={2000}
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-slate-50/50 p-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-100 transition-all font-sans"
              />
            </label>
            <label className="flex flex-col gap-1.5 mt-3 text-xs font-medium text-slate-700">
              Daily budget in dollars (empty = the default
              {usage ? `, $${usage.dailyCapUsd}` : ''})
              <input
                inputMode="decimal"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-100 transition-all font-sans"
              />
            </label>
            {usage && (
              <div className="mt-4 rounded-xl border border-slate-200 overflow-hidden">
                <table
                  style={{
                    width: '100%',
                    fontSize: 12,
                    borderCollapse: 'collapse',
                  }}
                  className="divide-y divide-slate-200"
                >
                  <caption className="p-2.5 text-start font-semibold text-xs text-slate-700 bg-slate-50/80 border-b border-slate-200">
                    Use by day
                  </caption>
                  <thead className="bg-slate-50/50 text-slate-500">
                    <tr>
                      {['Day', 'Replies', 'In', 'Cached', 'Out', 'Spent'].map(
                        (h) => (
                          <th key={h} className="p-2 text-start font-semibold">
                            {h}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {usage.days.length === 0 && (
                      <tr>
                        <td
                          colSpan={6}
                          className="p-3 text-center text-slate-400"
                        >
                          Nothing used yet.
                        </td>
                      </tr>
                    )}
                    {usage.days.map((d) => (
                      <tr key={d.day} className="hover:bg-slate-50/60">
                        <td className="p-2 font-mono text-[11px] text-slate-600">
                          {d.day}
                        </td>
                        <td className="p-2">{d.turns}</td>
                        <td className="p-2 text-slate-500">
                          {n(d.inputTokens)}
                        </td>
                        <td className="p-2 text-slate-500">
                          {n(d.cachedTokens)}
                        </td>
                        <td className="p-2 text-slate-500">
                          {n(d.outputTokens)}
                        </td>
                        <td
                          className="p-2 font-semibold text-slate-900"
                          title={Object.entries(d.byKind)
                            .map(([k, v]) => `${k} ${usd(v)}`)
                            .join(', ')}
                        >
                          {usd(d.costUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <div style={ui.actions} className="mt-4 flex gap-2 justify-end">
          <button
            type="button"
            className="rounded-xl border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer shadow-2xs"
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            disabled={!loaded || saving}
            onClick={() => void save()}
            className="rounded-xl bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white shadow-2xs hover:bg-blue-700 transition-colors cursor-pointer disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

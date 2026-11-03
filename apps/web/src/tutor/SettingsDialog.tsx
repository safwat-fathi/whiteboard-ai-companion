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
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Settings and usage</h2>
        {error && (
          <p role="alert" style={ui.alert}>
            {error}
          </p>
        )}
        {!loaded ? (
          <p>Loading…</p>
        ) : (
          <>
            <label style={{ display: 'grid', gap: 4 }}>
              About you (level, goals, language): the tutor reads this before
              every answer
              <textarea
                dir="auto"
                rows={4}
                maxLength={2000}
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, marginTop: 10 }}>
              Daily budget in dollars (empty = the default
              {usage ? `, $${usage.dailyCapUsd}` : ''})
              <input
                inputMode="decimal"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </label>
            {usage && (
              <table
                style={{
                  width: '100%',
                  marginTop: 14,
                  fontSize: 13,
                  borderCollapse: 'collapse',
                }}
              >
                <caption style={{ textAlign: 'start', fontWeight: 600 }}>
                  Use by day
                </caption>
                <thead>
                  <tr>
                    {['Day', 'Replies', 'In', 'Cached', 'Out', 'Spent'].map(
                      (h) => (
                        <th key={h} style={{ textAlign: 'start' }}>
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {usage.days.length === 0 && (
                    <tr>
                      <td colSpan={6}>Nothing used yet.</td>
                    </tr>
                  )}
                  {usage.days.map((d) => (
                    <tr key={d.day}>
                      <td>{d.day}</td>
                      <td>{d.turns}</td>
                      <td>{n(d.inputTokens)}</td>
                      <td>{n(d.cachedTokens)}</td>
                      <td>{n(d.outputTokens)}</td>
                      <td
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
            )}
          </>
        )}
        <div style={ui.actions}>
          <button
            type="button"
            disabled={!loaded || saving}
            onClick={() => void save()}
          >
            Save
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

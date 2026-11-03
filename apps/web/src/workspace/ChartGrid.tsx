'use client'

import { type ChartData, ChartDataSchema, newId } from '@whiteboard/core'
import { Fragment, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ui } from '../../app/library/ui'
import type { Editor } from '../editor/editor'

type Kind = ChartData['kind']
type Col = { name: string; values: string[]; xs: string[] }
type Draft = { kind: Kind; title: string; rows: string[]; series: Col[] }

const KINDS: [Kind, string][] = [
  ['bar', 'Bar'],
  ['line', 'Line'],
  ['area', 'Area'],
  ['pie', 'Pie'],
  ['donut', 'Donut'],
  ['scatter', 'Scatter'],
]
const MAX_SERIES = 8
const MAX_ROWS = 50
const MAX_POINTS = 200
const cell =
  'w-full min-w-16 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100'
const small =
  'rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40'

const letter = (n: number) =>
  n < 26 ? String.fromCharCode(65 + n) : `C${n + 1}`

function toDraft(d: ChartData): Draft {
  const scatter = d.kind === 'scatter'
  const n = scatter
    ? Math.max(0, ...d.series.map((s) => s.values.length))
    : d.categories.length
  const pad = (a: unknown[] | undefined, fill: (i: number) => string) =>
    Array.from({ length: n }, (_, i) =>
      a?.[i] === undefined ? fill(i) : String(a[i]),
    )
  return {
    kind: d.kind,
    title: d.title ?? '',
    rows: scatter ? Array(n).fill('') : [...d.categories],
    series: d.series.map((s) => ({
      name: s.name,
      values: pad(s.values, () => '0'),
      xs: pad(s.xs, (i) => String(i + 1)),
    })),
  }
}

/** The data grid of one chart: edit, add and remove rows and series, then Apply replaces the data in one undo step. */
export function ChartGrid({
  editor,
  id,
  onClose,
}: {
  editor: Editor
  id: string
  onClose: () => void
}) {
  const el = editor.scene.els.get(id)
  const chart = el?.type === 'chart' ? el : null
  const [draft, setDraft] = useState<Draft | null>(() =>
    chart ? toDraft(chart.data) : null,
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!chart) onClose()
  }, [chart, onClose])
  if (!chart || !draft || typeof document === 'undefined') return null

  const scatter = draft.kind === 'scatter'
  const single = draft.kind === 'pie' || draft.kind === 'donut'
  const edit = (f: (d: Draft) => Draft) => {
    setError(null)
    setDraft((d) => (d ? f(d) : d))
  }
  const setKind = (kind: Kind) =>
    edit((d) => ({
      ...d,
      kind,
      // a scatter needs an x per point; leaving one gives the rows names again
      series: d.series.map((s) => ({
        ...s,
        xs:
          s.xs.length === d.rows.length
            ? s.xs
            : d.rows.map((_, i) => String(i + 1)),
      })),
      rows: d.rows.map((c, i) => (kind !== 'scatter' && !c ? letter(i) : c)),
    }))
  const addRow = () =>
    edit((d) => ({
      ...d,
      rows: [...d.rows, scatter ? '' : letter(d.rows.length)],
      series: d.series.map((s) => ({
        ...s,
        values: [...s.values, '0'],
        xs: [...s.xs, String(d.rows.length + 1)],
      })),
    }))
  const removeRow = (r: number) =>
    edit((d) => ({
      ...d,
      rows: d.rows.filter((_, i) => i !== r),
      series: d.series.map((s) => ({
        ...s,
        values: s.values.filter((_, i) => i !== r),
        xs: s.xs.filter((_, i) => i !== r),
      })),
    }))
  const addSeries = () =>
    edit((d) => ({
      ...d,
      series: [
        ...d.series,
        {
          name: `Series ${d.series.length + 1}`,
          values: d.rows.map(() => '0'),
          xs: d.rows.map((_, i) => String(i + 1)),
        },
      ],
    }))
  const setCol = (si: number, f: (c: Col) => Col) =>
    edit((d) => ({
      ...d,
      series: d.series.map((c, i) => (i === si ? f(c) : c)),
    }))

  const apply = () => {
    const num = (v: string, where: string) => {
      const x = Number(v)
      if (v.trim() === '' || !Number.isFinite(x))
        throw new Error(`${where}: "${v}" is not a number`)
      return x
    }
    let data: ChartData
    try {
      data = {
        ...chart.data,
        kind: draft.kind,
        categories: scatter ? [] : draft.rows,
        series: draft.series.map((s, si) => {
          const label = s.name || `Series ${si + 1}`
          const values = s.values.map((v, r) =>
            num(v, `Row ${r + 1}, ${label}`),
          )
          return scatter
            ? {
                name: s.name,
                values,
                xs: s.xs.map((v, r) => num(v, `Row ${r + 1}, ${label} x`)),
              }
            : { name: s.name, values }
        }),
      }
      if (draft.title.trim() === '') delete data.title
      else data.title = draft.title
    } catch (e) {
      return setError((e as Error).message)
    }
    const r = ChartDataSchema.safeParse(data)
    if (!r.success)
      return setError(
        r.error.issues[0]?.message ?? 'The chart data is not valid.',
      )
    if (JSON.stringify(r.data) !== JSON.stringify(chart.data))
      // whole leaves, never a patch by index: last write wins (PLAN F9)
      editor.commit({
        batchId: newId(),
        label: 'Edit chart',
        ops: [
          {
            op: 'patch',
            id,
            set: {
              'data.kind': r.data.kind,
              'data.title': r.data.title ?? null,
              'data.categories': r.data.categories,
              'data.series': r.data.series,
            },
          },
        ],
      })
    onClose()
  }

  return createPortal(
    <div style={ui.backdrop}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Edit chart"
        style={{
          ...ui.dialog,
          maxHeight: '85vh',
          overflow: 'auto',
          minWidth: 340,
          maxWidth: 720,
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          e.stopPropagation()
        }}
      >
        <h2
          style={{ marginTop: 0, fontSize: 18 }}
          className="font-bold text-slate-900"
        >
          Edit chart
        </h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-700">
            Type
            <select
              aria-label="Chart type"
              value={draft.kind}
              onChange={(e) => setKind(e.target.value as Kind)}
              className={cell}
            >
              {KINDS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-slate-700">
            Title
            <input
              aria-label="Title"
              value={draft.title}
              maxLength={120}
              onChange={(e) => edit((d) => ({ ...d, title: e.target.value }))}
              className={cell}
            />
          </label>
        </div>
        {error && (
          <p role="alert" style={ui.alert}>
            {error}
          </p>
        )}
        <div className="mt-3 overflow-auto rounded-xl border border-slate-200">
          <table className="w-full border-collapse text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                {!scatter && (
                  <th className="p-1.5 text-start font-medium">Category</th>
                )}
                {draft.series.map((s, si) => (
                  <th
                    key={si}
                    colSpan={scatter ? 2 : 1}
                    className="p-1.5 text-start font-medium"
                  >
                    <span className="flex items-center gap-1">
                      <input
                        aria-label={`Series ${si + 1} name`}
                        value={s.name}
                        maxLength={40}
                        onChange={(e) =>
                          setCol(si, (c) => ({ ...c, name: e.target.value }))
                        }
                        className={cell}
                      />
                      <button
                        type="button"
                        aria-label={`Remove series ${si + 1}`}
                        disabled={draft.series.length <= 1}
                        onClick={() =>
                          edit((d) => ({
                            ...d,
                            series: d.series.filter((_, i) => i !== si),
                          }))
                        }
                        className={small}
                      >
                        ×
                      </button>
                    </span>
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.rows.map((c, r) => (
                <tr key={r} className="border-t border-slate-100">
                  {!scatter && (
                    <td className="p-1">
                      <input
                        aria-label={`Category ${r + 1}`}
                        value={c}
                        maxLength={40}
                        onChange={(e) =>
                          edit((d) => ({
                            ...d,
                            rows: d.rows.map((x, i) =>
                              i === r ? e.target.value : x,
                            ),
                          }))
                        }
                        className={cell}
                      />
                    </td>
                  )}
                  {draft.series.map((s, si) => (
                    <Fragment key={si}>
                      {scatter && (
                        <td className="p-1">
                          <input
                            aria-label={`Row ${r + 1} Series ${si + 1} x`}
                            inputMode="decimal"
                            value={s.xs[r] ?? ''}
                            onChange={(e) =>
                              setCol(si, (col) => ({
                                ...col,
                                xs: col.xs.map((x, i) =>
                                  i === r ? e.target.value : x,
                                ),
                              }))
                            }
                            className={cell}
                          />
                        </td>
                      )}
                      <td className="p-1">
                        <input
                          aria-label={`Row ${r + 1} Series ${si + 1}`}
                          inputMode="decimal"
                          value={s.values[r] ?? ''}
                          onChange={(e) =>
                            setCol(si, (col) => ({
                              ...col,
                              values: col.values.map((x, i) =>
                                i === r ? e.target.value : x,
                              ),
                            }))
                          }
                          className={cell}
                        />
                      </td>
                    </Fragment>
                  ))}
                  <td className="p-1">
                    <button
                      type="button"
                      aria-label={`Remove row ${r + 1}`}
                      disabled={draft.rows.length <= 1}
                      onClick={() => removeRow(r)}
                      className={small}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-label="Add row"
            disabled={draft.rows.length >= (scatter ? MAX_POINTS : MAX_ROWS)}
            onClick={addRow}
            className={small}
          >
            + Row
          </button>
          <button
            type="button"
            aria-label="Add series"
            title={single ? 'A pie or donut chart takes one series' : undefined}
            disabled={single || draft.series.length >= MAX_SERIES}
            onClick={addSeries}
            className={small}
          >
            + Series
          </button>
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Cancel"
            onClick={onClose}
            className={small}
          >
            Cancel
          </button>
          <button
            type="button"
            aria-label="Apply"
            onClick={apply}
            className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700"
          >
            Apply
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

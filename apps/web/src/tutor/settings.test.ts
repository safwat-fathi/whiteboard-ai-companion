// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LibraryApi, UsageSummary } from '../library/api'
import { SpendChip } from './SpendChip'

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const day = (over: Partial<UsageSummary['today']> = {}) => ({
  day: '2026-11-03',
  costUsd: 0,
  byKind: {},
  turns: 0,
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  ...over,
})
const usageOf = (today = day()): UsageSummary => ({
  days: today.turns || today.costUsd ? [today] : [],
  today,
  dailyCapUsd: 5,
  totalUsd: today.costUsd,
})

function fakeApi(
  o: {
    usage?: UsageSummary
    settings?: { profile: string; dailyBudgetUsd: number | null }
    fail?: boolean
  } = {},
) {
  const puts: unknown[] = []
  const api = {
    usage: vi.fn(async () => o.usage ?? usageOf()),
    getSettings: vi.fn(
      async () => o.settings ?? { profile: '', dailyBudgetUsd: null },
    ),
    putSettings: vi.fn(async (s: unknown) => {
      if (o.fail) throw new Error('The server could not be reached.')
      puts.push(s)
      return s as never
    }),
  } as unknown as LibraryApi
  return { api, puts }
}
let unmount: (() => Promise<void>) | undefined
let host: HTMLDivElement
async function mount(el: ReturnType<typeof createElement>) {
  host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(el))
  await act(async () => {})
  unmount = async () => {
    await act(async () => root.unmount())
    host.remove()
  }
}
afterEach(async () => {
  await unmount?.()
  unmount = undefined
})
const btn = (label: string) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement
const click = (el: Element) => act(async () => (el as HTMLElement).click())
const type = (el: HTMLElement, v: string) =>
  act(async () => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })

describe('SpendChip and the settings dialog', () => {
  it("shows today's spend, in tokens while the model is unpriced", async () => {
    const { api } = fakeApi({
      usage: usageOf(day({ turns: 2, inputTokens: 1200, outputTokens: 300 })),
    })
    await mount(createElement(SpendChip, { api, refreshKey: 0 }))
    expect(host.textContent).toBe('1,500 tokens today')
  })

  it('opens the dialog with the saved profile, budget and a table of use by day', async () => {
    const { api } = fakeApi({
      usage: usageOf(
        day({
          turns: 2,
          inputTokens: 1200,
          cachedTokens: 400,
          outputTokens: 300,
          costUsd: 0.2,
          byKind: { turn: 0.15, embed: 0.05 },
        }),
      ),
      settings: { profile: 'Grade 9', dailyBudgetUsd: 2 },
    })
    await mount(createElement(SpendChip, { api, refreshKey: 0 }))
    expect(host.textContent).toBe('$0.20 today')
    await click(host.querySelector('button') as Element)
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(
      (dialog.querySelector('textarea') as HTMLTextAreaElement).value,
    ).toBe('Grade 9')
    expect((dialog.querySelector('input') as HTMLInputElement).value).toBe('2')
    const row = dialog.querySelector('tbody tr') as HTMLElement
    expect([...row.querySelectorAll('td')].map((td) => td.textContent)).toEqual(
      ['2026-11-03', '2', '1,200', '400', '300', '$0.20'],
    )
    expect(row.querySelector('td[title]')?.getAttribute('title')).toBe(
      'turn $0.15, embed $0.0500',
    )
  })

  it('saves the profile and the budget, closes, and the chip refreshes', async () => {
    const { api, puts } = fakeApi()
    await mount(createElement(SpendChip, { api, refreshKey: 0 }))
    await click(host.querySelector('button') as Element)
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    await type(
      dialog.querySelector('textarea') as HTMLElement,
      'I prefer pictures',
    )
    await type(dialog.querySelector('input') as HTMLElement, '1.5')
    await click(btn('Save'))
    expect(puts).toEqual([
      { profile: 'I prefer pictures', dailyBudgetUsd: 1.5 },
    ])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(api.usage).toHaveBeenCalledTimes(3) // the chip, the dialog, the chip again after saving
  })

  it('an empty budget means the default; a bad one is refused before anything is sent; a failed save stays open', async () => {
    const { api, puts } = fakeApi()
    await mount(createElement(SpendChip, { api, refreshKey: 0 }))
    await click(host.querySelector('button') as Element)
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    await type(dialog.querySelector('input') as HTMLElement, 'lots')
    await click(btn('Save'))
    expect(dialog.querySelector('[role="alert"]')?.textContent).toMatch(
      /must be a number of dollars/,
    )
    expect(puts).toEqual([])
    await type(dialog.querySelector('input') as HTMLElement, '')
    await click(btn('Save'))
    expect(puts).toEqual([{ profile: '', dailyBudgetUsd: null }])
    await unmount?.()
    const bad = fakeApi({ fail: true })
    await mount(createElement(SpendChip, { api: bad.api, refreshKey: 0 }))
    await click(host.querySelector('button') as Element)
    await click(btn('Save'))
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
      /could not be reached/,
    )
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
})

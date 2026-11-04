// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRefreshLoop } from './useRefreshLoop'
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

function Probe(p: { delay: number | null; refresh: () => Promise<void> }) {
  useRefreshLoop(p.delay, p.refresh)
  return null
}

const roots: { unmount(): void }[] = []
const mount = async (delay: number | null, refresh: () => Promise<void>) => {
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  await act(async () => root.render(createElement(Probe, { delay, refresh })))
}
// one act per round: React re-arms the effect when the act scope closes, so a single long advance would run one round
const tick = async (ms: number, rounds = 1) => {
  for (let i = 0; i < rounds; i++)
    await act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount()
  vi.useRealTimers()
  Object.defineProperty(document, 'hidden', {
    value: false,
    configurable: true,
  })
})

describe('useRefreshLoop', () => {
  it('keeps polling after a refresh that throws', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('network down'))
    await mount(100, refresh)
    await tick(100, 4)
    expect(refresh).toHaveBeenCalledTimes(4)
  })

  it('does not poll when the delay is null', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    await mount(null, refresh)
    await tick(1000)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('skips the request while the tab is hidden and resumes when it is shown', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(document, 'hidden', {
      value: true,
      configurable: true,
    })
    await mount(100, refresh)
    await tick(100, 3)
    expect(refresh).not.toHaveBeenCalled()
    Object.defineProperty(document, 'hidden', {
      value: false,
      configurable: true,
    })
    await tick(100, 2)
    expect(refresh).toHaveBeenCalled()
  })
})

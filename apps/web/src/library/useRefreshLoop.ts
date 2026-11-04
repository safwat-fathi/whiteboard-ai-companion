import { useEffect, useState } from 'react'

/**
 * Calls `refresh` every `delayMs` (null = not polling). The next round is scheduled after every round, whether `refresh`
 * succeeded or threw: a failed request used to leave the state unchanged, so nothing re-armed the timer and a book
 * that was still indexing silently stopped updating. A hidden tab skips the request and keeps the timer.
 */
export function useRefreshLoop(
  delayMs: number | null,
  refresh: () => Promise<void>,
): void {
  const [round, setRound] = useState(0)
  // `round` is in the deps as the re-arm trigger, not as an input
  useEffect(() => {
    if (delayMs === null) return
    const t = setTimeout(async () => {
      try {
        if (!document.hidden) await refresh()
      } catch {
        // the caller's refresh reports its own errors; the loop just carries on
      }
      setRound((n) => n + 1)
    }, delayMs)
    return () => clearTimeout(t)
  }, [delayMs, refresh, round])
}

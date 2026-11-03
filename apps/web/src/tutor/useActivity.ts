'use client'

import type { ActivityTurn } from '@whiteboard/core'
import { useCallback, useEffect, useState } from 'react'
import type { LibraryApi } from '../library/api'

/** The turns that changed the board (jump-to-ai.md "Activity tab"), refreshed whenever `refreshKey` changes. */
export function useActivity(
  api: LibraryApi | null,
  boardId: string | undefined,
  refreshKey: number,
) {
  const [turns, setTurns] = useState<ActivityTurn[]>([])
  const [next, setNext] = useState<string | undefined>()
  const [failed, setFailed] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger
  useEffect(() => {
    if (!api || boardId === undefined) return
    let on = true
    api.activity(boardId, { limit: 20 }).then(
      (r) => {
        if (!on) return
        setTurns(r.turns)
        setNext(r.next)
        setFailed(false)
      },
      () => on && setFailed(true),
    )
    return () => {
      on = false
    }
  }, [api, boardId, refreshKey])

  const loadMore = useCallback(async () => {
    if (!api || boardId === undefined || !next) return
    const r = await api.activity(boardId, { limit: 20, before: next })
    setTurns((t) => [
      ...t,
      ...r.turns.filter((x) => !t.some((y) => y.turnId === x.turnId)),
    ])
    setNext(r.next)
  }, [api, boardId, next])

  /** A short name for a turn, for the hover tag. */
  const labelOf = useCallback(
    (turnId: string) =>
      turns.find((t) => t.turnId === turnId)?.userText.slice(0, 40),
    [turns],
  )
  return { turns, hasMore: next !== undefined, loadMore, failed, labelOf }
}

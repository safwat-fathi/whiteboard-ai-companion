'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { getOrCreateBoard } from '../src/workspace/board-id'
import { Workspace } from '../src/workspace/Workspace'

/** Local mode keeps its one board here; server mode resolves a board and moves to its own URL. */
export default function Home() {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE?.replace(/\/+$/, '')
  if (apiBase === undefined) return <Workspace />
  return <OpenBoard apiBase={apiBase} />
}

function OpenBoard({ apiBase }: { apiBase: string }) {
  const router = useRouter()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    getOrCreateBoard(apiBase).then(
      (id) => live && router.replace(`/boards/${encodeURIComponent(id)}`),
      (e) => {
        console.error('getting/creating board failed', e)
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [apiBase, router])
  return failed ? (
    <p role="alert" style={{ padding: 16 }}>
      The board could not be loaded. Is the server running?{' '}
      <button type="button" onClick={() => location.reload()}>
        Reload
      </button>
    </p>
  ) : (
    <p role="status" style={{ padding: 16 }}>
      Opening your board…
    </p>
  )
}

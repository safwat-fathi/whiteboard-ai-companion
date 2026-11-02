'use client'

import { useEffect, useRef, useState } from 'react'
import { createHttpBlobStore } from '../src/editor/blobs-http'
import { Editor } from '../src/editor/editor'
import { loadFonts } from '../src/editor/fonts'
import {
  acquireBoardLock,
  createPersistence,
  releaseBoardLock,
} from '../src/editor/persist'
import { browserPlatform } from '../src/editor/platform'
import { createSyncClient } from '../src/editor/sync'
import { type Note, Notices } from './Notice'
import { Toolbar } from './Toolbar'

const BOARD = 'local'
const WHY = {
  corrupt: 'The saved board is damaged and could not be read.',
  'newer-version': 'The saved board was made by a newer version of this app.',
  unavailable: 'Browser storage is unavailable.',
} as const
const reload = () => location.reload()

async function getOrCreateBoard(apiBase: string): Promise<string> {
  const cached =
    typeof localStorage !== 'undefined'
      ? localStorage.getItem('whiteboard:boardId')
      : null
  const res = await fetch(`${apiBase}/api/boards`)
  if (!res.ok) throw new Error(`Failed to list boards: ${res.status}`)
  const data = (await res.json()) as { boards?: { id: string }[] }
  const boards = data.boards ?? []
  if (cached && boards.some((b) => b.id === cached)) {
    return cached
  }
  if (boards.length > 0 && boards[0]) {
    const id = boards[0].id
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('whiteboard:boardId', id)
    }
    return id
  }
  const postRes = await fetch(`${apiBase}/api/boards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Main' }),
  })
  if (!postRes.ok) throw new Error(`Failed to create board: ${postRes.status}`)
  const postData = (await postRes.json()) as { id: string }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('whiteboard:boardId', postData.id)
  }
  return postData.id
}

function toWsUrl(apiBase: string, boardId: string): string {
  const url = new URL(
    apiBase,
    typeof window !== 'undefined'
      ? window.location.href
      : 'http://localhost:3000',
  )
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws'
  url.search = `?boardId=${encodeURIComponent(boardId)}`
  return url.toString()
}

export default function Page() {
  const host = useRef<HTMLDivElement>(null)
  const [notes, setNotes] = useState<Note[]>([])
  // Set once the stored board is loaded; null while loading.
  const [board, setBoard] = useState<{
    editor: Editor
    readOnly: boolean
  } | null>(null)

  useEffect(() => {
    const note = (key: string, n: Omit<Note, 'key'> | null) =>
      setNotes((all) => [
        ...all.filter((x) => x.key !== key),
        ...(n ? [{ key, ...n }] : []),
      ])

    const apiBase = process.env.NEXT_PUBLIC_API_BASE?.replace(/\/+$/, '')

    if (apiBase) {
      let editor: Editor | undefined
      let syncClient: ReturnType<typeof createSyncClient> | undefined
      let stop = false

      ;(async () => {
        await loadFonts().catch((err) =>
          console.error('font loading failed', err),
        )
        if (stop || !host.current) return

        let boardId: string
        try {
          boardId = await getOrCreateBoard(apiBase)
        } catch (err) {
          console.error('getting/creating board failed', err)
          if (!stop)
            note('load', {
              text: 'The board could not be loaded, so it is read-only and nothing is being saved.',
              role: 'alert',
              action: { label: 'Reload', run: reload },
            })
          return
        }
        if (stop || !host.current) return

        const ed = new Editor(host.current, {
          platform: browserPlatform(),
          blobs: createHttpBlobStore(apiBase),
        })
        editor = ed
        ed.author = { kind: 'human', id: 'owner' }
        ed.onNotice = (text) => note('notice', { text, role: 'alert' })
        ed.readOnly = true
        setBoard({ editor: ed, readOnly: true })

        if (process.env.NODE_ENV !== 'production')
          (window as unknown as { __editor?: Editor }).__editor = ed

        const wsUrl = toWsUrl(apiBase, boardId)
        syncClient = createSyncClient({
          url: wsUrl,
          boardId,
          editor: ed,
          onStatus: (status, detail) => {
            if (stop) return
            if (status === 'live') {
              ed.readOnly = false
              setBoard({ editor: ed, readOnly: false })
              note('offline', null)
            } else if (status === 'offline') {
              note('offline', {
                text: 'Offline: changes are not saved',
                role: 'alert',
              })
            } else if (status === 'failed') {
              note('offline', {
                text: `Connection failed: ${detail ?? 'error'}`,
                role: 'alert',
              })
            }
          },
        })
        syncClient.start()
      })()

      return () => {
        stop = true
        try {
          syncClient?.stop()
        } finally {
          editor?.dispose()
        }
      }
    }

    let editor: Editor | undefined
    let persistence: ReturnType<typeof createPersistence> | undefined
    let stop = false
    ;(async () => {
      await loadFonts().catch((err) =>
        console.error('font loading failed', err),
      )
      if (stop || !host.current) return
      const locked = await acquireBoardLock(BOARD)
      if (stop) return // cleanup already released the lock
      // Platform is created after fonts load: text layout is memoised per Platform object.
      editor = new Editor(host.current, { platform: browserPlatform() })
      editor.onNotice = (text) => note('notice', { text, role: 'alert' })
      editor.readOnly = true // until load() resolves: a pre-load edit would be wiped by setScene
      const p = createPersistence(editor, BOARD, {
        onSaveError: () =>
          note('save', {
            text: 'Could not save (storage full?)',
            role: 'alert',
          }),
        onSaved: () => note('save', null),
      })
      persistence = p
      let r: Awaited<ReturnType<typeof p.load>>
      try {
        r = await p.load(locked) // a read-only tab never writes, not even a backup
      } catch (err) {
        console.error('loading the board failed', err)
        if (!stop)
          note('load', {
            text: 'The board could not be loaded, so it is read-only and nothing is being saved.',
            role: 'alert',
            action: { label: 'Reload', run: reload },
          })
        return // the editor stays read-only
      }
      if (stop) return
      editor.readOnly = !locked
      setBoard({ editor, readOnly: !locked })
      // Published after load so tests wait for the stored board.
      // Test hook for Playwright; absent from production builds.
      if (process.env.NODE_ENV !== 'production')
        (window as unknown as { __editor?: Editor }).__editor = editor
      if (!locked) {
        note('lock', {
          text: 'Open in another tab (read-only)',
          role: 'alert',
        })
        return // a read-only tab never writes
      }
      p.start()
      if (r.status === 'ok' && r.backupFailed)
        note('backup', {
          text: 'Could not keep a backup copy of your board, so changes are NOT being saved. Reload to try again.',
          role: 'alert',
          action: { label: 'Reload', run: reload },
        })
      if (r.status === 'ok' && r.dropped && !r.backupFailed)
        note('dropped', {
          text: `${r.dropped} invalid elements were dropped (a backup copy of the stored board was kept)`,
          role: 'status',
        })
      if (r.status === 'ok' && r.undoDropped && !r.backupFailed)
        note('undo-dropped', {
          text: 'Some undo history could not be restored and was dropped (a backup copy of the stored board was kept)',
          role: 'status',
        })
      if (r.status === 'unreadable') {
        note('unreadable', {
          text: `${WHY[r.reason]} Changes are NOT being saved.`,
          role: 'alert',
          action:
            r.reason === 'unavailable'
              ? { label: 'Retry', run: reload }
              : {
                  label: 'Start empty and keep a backup copy',
                  run: () =>
                    p.startEmptyKeepingBackup().then(
                      () => note('unreadable', null),
                      () =>
                        note('save', {
                          text: 'Could not save (storage full?)',
                          role: 'alert',
                        }),
                    ),
                },
        })
      }
    })()
    return () => {
      stop = true
      // Each step in its own try/finally: a throw must not skip dispose() or leave the lock held (a remount would be read-only).
      try {
        persistence?.stop() // commits an open text edit and saves it; only then dispose() tears the editor down
      } finally {
        try {
          editor?.dispose()
        } finally {
          releaseBoardLock(BOARD)
        }
      }
    }
  }, [])
  return (
    <>
      <div ref={host} style={{ position: 'fixed', inset: 0 }} />
      <Notices notes={notes} />
      <Toolbar
        editor={board?.editor ?? null}
        readOnly={board?.readOnly ?? true}
      />
    </>
  )
}

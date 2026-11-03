'use client'

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import { type Note, Notices } from '../../app/Notice'
import { Toolbar } from '../../app/Toolbar'
import { createHttpBlobStore } from '../editor/blobs-http'
import { Editor } from '../editor/editor'
import { loadFonts } from '../editor/fonts'
import {
  acquireBoardLock,
  createPersistence,
  releaseBoardLock,
} from '../editor/persist'
import { browserPlatform } from '../editor/platform'
import { createSyncClient } from '../editor/sync'
import { createLibraryApi } from '../library/api'
import { ChatTab } from '../tutor/ChatTab'
import { Dock, TopBar, useDockLayout } from './Dock'

const BOARD = 'local'
const WHY = {
  corrupt: 'The saved board is damaged and could not be read.',
  'newer-version': 'The saved board was made by a newer version of this app.',
  unavailable: 'Browser storage is unavailable.',
} as const
const reload = () => location.reload()

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

/**
 * The board and its dock. `boardId` is given in server mode (the `/boards/[id]` route); local mode (no
 * NEXT_PUBLIC_API_BASE) keeps the one board in this browser and has no dock.
 */
export function Workspace({ boardId }: { boardId?: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const apiBase = process.env.NEXT_PUBLIC_API_BASE?.replace(/\/+$/, '')
  const serverMode = apiBase !== undefined
  const dock = useDockLayout(serverMode)
  const [title, setTitle] = useState('Board')
  const [live, setLive] = useState(false) // the board's socket is up: the chat needs it to send
  useEffect(() => {
    if (apiBase === undefined || boardId === undefined) return
    let live = true
    createLibraryApi(apiBase)
      .getBoard(boardId)
      .then(
        (b) => live && setTitle(b.title),
        () => {}, // the title is decoration; the sync client reports a real connection problem
      )
    return () => {
      live = false
    }
  }, [apiBase, boardId])
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

    if (apiBase !== undefined) {
      let editor: Editor | undefined
      let syncClient: ReturnType<typeof createSyncClient> | undefined
      let stop = false

      ;(async () => {
        await loadFonts().catch((err) =>
          console.error('font loading failed', err),
        )
        if (stop || !host.current) return

        if (boardId === undefined) {
          if (!stop)
            note('load', {
              text: 'No board was given, so nothing can be loaded.',
              role: 'alert',
              action: { label: 'Reload', run: reload },
            })
          return
        }

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
            setLive(status === 'live')
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
  }, [boardId])
  return (
    // display: contents keeps this wrapper out of the layout; it only carries the dock width the toolbar and notices centre on.
    <div
      style={
        {
          display: 'contents',
          '--dock-w': `${dock.narrow ? 0 : dock.inset.right}px`,
        } as CSSProperties
      }
    >
      <div
        ref={host}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: dock.inset.right,
          bottom: dock.inset.bottom,
        }}
      />
      <Notices notes={notes} />
      <Toolbar
        editor={board?.editor ?? null}
        readOnly={board?.readOnly ?? true}
      />
      {serverMode && <TopBar title={title} />}
      {serverMode && (
        <Dock
          layout={dock}
          panes={{
            chat:
              apiBase !== undefined && boardId !== undefined ? (
                <ChatTab apiBase={apiBase} boardId={boardId} connected={live} />
              ) : null,
            activity: (
              <Empty>The tutor's work on this board will be listed here.</Empty>
            ),
            source: <Empty>Open a citation to see the book page here.</Empty>,
          }}
        />
      )}
    </div>
  )
}

const Empty = ({ children }: { children: ReactNode }) => (
  <p style={{ padding: 12, color: '#555', fontSize: 13 }}>{children}</p>
)

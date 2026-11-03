'use client'

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
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
import { boardBookScope, type Scope } from '../library/scope'
import { ActivityTab } from '../tutor/ActivityTab'
import { AiTag } from '../tutor/AiTag'
import { createEditorBridge } from '../tutor/board-context'
import { ChatTab } from '../tutor/ChatTab'
import {
  AiPresence,
  BackChip,
  EdgeIndicator,
  GhostFrame,
  useJump,
} from '../tutor/jump'
import { ScopeChip } from '../tutor/ScopeChip'
import { SelectionToolbar } from '../tutor/SelectionToolbar'
import { type SourceRef, SourceTab } from '../tutor/SourceTab'
// import { SpendChip } from '../tutor/SpendChip'
import { useActivity } from '../tutor/useActivity'
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
  const [scope, setScope] = useState<Scope | null>(null)
  const [source, setSource] = useState<SourceRef | null>(null)
  const [askSignal, setAskSignal] = useState(0)
  const [activityKey, setActivityKey] = useState(0)
  const [reveal, setReveal] = useState<
    { turnId: string; n: number } | undefined
  >()
  const syncRef = useRef<ReturnType<typeof createSyncClient> | null>(null)
  const api = useMemo(
    () => (apiBase === undefined ? null : createLibraryApi(apiBase)),
    [apiBase],
  )
  const [live, setLive] = useState(false) // the board's socket is up: the chat needs it to send
  useEffect(() => {
    if (!api || boardId === undefined) return
    let on = true
    api.getBoard(boardId).then(
      (b) => {
        if (!on) return
        setTitle(b.title)
        setScope(boardBookScope(b.scope))
      },
      () => {}, // decoration only; the sync client reports a real connection problem
    )
    return () => {
      on = false
    }
  }, [api, boardId])
  const upload = useMemo(() => {
    if (apiBase === undefined) return undefined
    const store = createHttpBlobStore(apiBase)
    return async (png: Blob) =>
      store.put(
        new Uint8Array(await png.arrayBuffer()),
        png.type || 'image/png',
      )
  }, [apiBase])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
    }
  }, [])

  // A verified citation opens the page it names in the Source tab.
  const openSource = (c: SourceRef) => {
    setSource(c)
    dock.setCollapsed(false)
    dock.setTab('source')
  }
  // Set once the stored board is loaded; null while loading.
  const [board, setBoard] = useState<{
    editor: Editor
    readOnly: boolean
  } | null>(null)

  const bridge = useMemo(
    () =>
      board
        ? createEditorBridge(
            board.editor,
            () => syncRef.current?.idle() ?? Promise.resolve(),
          )
        : undefined,
    [board],
  )

  // Follow AI is off until the student turns it on, and it turns itself off when they take the canvas.
  const [follow, setFollow] = useState(false)
  const [turn, setTurn] = useState<{ running: boolean; state?: string }>({
    running: false,
  })
  const stopFollowing = useCallback(() => setFollow(false), [])
  const toast = useCallback((text: string) => {
    setNotes((all) => [
      ...all.filter((x) => x.key !== 'toast'),
      { key: 'toast', text, role: 'status' as const },
    ])
    setTimeout(
      () => setNotes((all) => all.filter((x) => x.key !== 'toast')),
      4000,
    )
  }, [])
  const dismissNote = useCallback((key: string) => {
    setNotes((all) => all.filter((x) => x.key !== key))
  }, [])
  const jump = useJump(board?.editor ?? null, {
    follow,
    onFollowOff: stopFollowing,
    notify: toast,
  })
  const activity = useActivity(api, boardId, activityKey)
  const bumpActivity = useRef(() => {})
  bumpActivity.current = () => setActivityKey((n) => n + 1)
  const jumpRef = useRef(jump)
  jumpRef.current = jump
  const onTurn = useCallback((t: { running: boolean; state?: string }) => {
    setTurn(t)
    if (!t.running) jumpRef.current.turnEnded()
  }, [])
  // deep links: ?el=, ?turn= and ?batch= land on the work once the board has loaded
  const deepLinked = useRef(false)
  useEffect(() => {
    if (deepLinked.current || !board || !live || !api || boardId === undefined)
      return
    deepLinked.current = true
    const q = new URLSearchParams(window.location.search)
    const el = q.get('el')
    const turnId = q.get('turn')
    const batchId = q.get('batch')
    if (el) void jumpRef.current.locate([{ ids: [el], bounds: null }])
    else if (turnId || batchId)
      api.activity(boardId, { turn: turnId, batch: batchId }).then(
        (r) => {
          const t = r.turns[0]
          if (!t) return
          const batches = batchId
            ? t.batches.filter((b) => b.batchId === batchId)
            : t.batches
          void jumpRef.current.locate(
            batches.map((b) => ({ ids: b.touchedIds ?? [], bounds: b.bounds })),
          )
        },
        () => {},
      )
  }, [board, live, api, boardId])

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
          onServerBatch: (sb) => {
            jumpRef.current.onAgentBatch(sb)
            if (sb.author?.kind === 'agent') bumpActivity.current()
          },
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
        syncRef.current = syncClient
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
      <Notices notes={notes} onDismiss={dismissNote} />
      <Toolbar
        editor={board?.editor ?? null}
        readOnly={board?.readOnly ?? true}
      />
      {serverMode && board && (
        <SelectionToolbar
          editor={board.editor}
          onAsk={() => {
            dock.setCollapsed(false)
            dock.setTab('chat')
            setAskSignal((n) => n + 1)
          }}
        />
      )}
      {serverMode && (
        <TopBar title={title}>
          {api && boardId !== undefined && (
            <ScopeChip
              api={api}
              boardId={boardId}
              scope={scope}
              onChange={setScope}
            />
          )}
          <label className="flex items-center gap-1.5 cursor-pointer text-xs font-medium text-slate-600 hover:text-slate-900 select-none">
            <input
              type="checkbox"
              role="switch"
              aria-checked={follow}
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
              className="accent-blue-600 w-3.5 h-3.5 cursor-pointer rounded"
            />
            Follow AI
          </label>
          {/* Temporary decision: SpendChip (daily spend badge) hidden from top bar for now. See docs/plans/chat-ui.md */}
          {/* {api && <SpendChip api={api} refreshKey={activityKey} />} */}
          {turn.running && (
            <button
              type="button"
              onClick={() => void jump.locateLatest()}
              className="flex items-center gap-1.5 rounded-full bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 transition-all duration-150 animate-pulse cursor-pointer"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-white" />
              Jump to AI
            </button>
          )}
        </TopBar>
      )}
      {serverMode && board && (
        <AiTag
          editor={board.editor}
          labelOf={activity.labelOf}
          onShow={(turnId) => {
            dock.setCollapsed(false)
            dock.setTab('chat')
            setReveal((r) => ({ turnId, n: (r?.n ?? 0) + 1 }))
          }}
        />
      )}
      {serverMode && board && jump.canBack && (
        <BackChip onBack={() => void jump.back()} />
      )}
      {serverMode && board && jump.indicator && (
        <EdgeIndicator
          at={jump.indicator}
          onJump={() => void jump.locateLatest()}
        />
      )}
      {serverMode && board && jump.ghost && (
        <GhostFrame editor={board.editor} rect={jump.ghost} />
      )}
      {serverMode && board && turn.running && jump.latestRect && (
        <AiPresence
          editor={board.editor}
          rect={jump.latestRect}
          label={
            turn.state === 'reading'
              ? 'reading…'
              : turn.state === 'drawing'
                ? 'drawing…'
                : 'thinking…'
          }
        />
      )}
      {serverMode && (
        <Dock
          layout={dock}
          panes={{
            chat:
              apiBase !== undefined && boardId !== undefined ? (
                <ChatTab
                  apiBase={apiBase}
                  boardId={boardId}
                  connected={live}
                  actions={{
                    onCite: openSource,
                    onLocate: (id) =>
                      void jump.locate([{ ids: [id], bounds: null }]),
                    onLocateBatch: (b) =>
                      void jump.locate([
                        { ids: b.touchedIds ?? [], bounds: b.bounds },
                      ]),
                  }}
                  onTurn={onTurn}
                  revealTurn={reveal}
                  bridge={bridge}
                  upload={upload}
                  focusSignal={askSignal}
                  previewContext={
                    api
                      ? (context, images) =>
                          api.contextPreview(boardId, context, images)
                      : undefined
                  }
                  undo={
                    api
                      ? {
                          turn: (turnId) => api.undoTurn(boardId, turnId),
                          batch: (batchId) => api.undoBatch(boardId, batchId),
                        }
                      : undefined
                  }
                />
              ) : null,
            activity: (
              <ActivityTab
                turns={activity.turns}
                hasMore={activity.hasMore}
                loadMore={() => void activity.loadMore()}
                failed={activity.failed}
                onLocate={(items) => void jump.locate(items)}
                undo={
                  api && boardId !== undefined
                    ? {
                        turn: (id) => api.undoTurn(boardId, id),
                        batch: (id) => api.undoBatch(boardId, id),
                      }
                    : undefined
                }
              />
            ),
            source: api ? (
              <SourceTab
                api={api}
                source={source}
                onPage={(page) => source && setSource({ ...source, page })}
              />
            ) : null,
          }}
        />
      )}
    </div>
  )
}

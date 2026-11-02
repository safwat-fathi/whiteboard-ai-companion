'use client'

import { useEffect, useRef, useState } from 'react'
import { Editor } from '../src/editor/editor'
import { loadFonts } from '../src/editor/fonts'
import {
  acquireBoardLock,
  createPersistence,
  releaseBoardLock,
} from '../src/editor/persist'
import { browserPlatform } from '../src/editor/platform'
import { type Note, Notices } from './Notice'
import { Toolbar } from './Toolbar'

const BOARD = 'local'
const WHY = {
  corrupt: 'The saved board is damaged and could not be read.',
  'newer-version': 'The saved board was made by a newer version of this app.',
  unavailable: 'Browser storage is unavailable.',
} as const
const reload = () => location.reload()

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
      if (r.status === 'ok' && r.dropped)
        note('dropped', {
          text: `${r.dropped} invalid elements were dropped (a backup copy of the stored board was kept)`,
          role: 'status',
        })
      if (r.status === 'ok' && r.undoDropped)
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
      persistence?.stop() // commits an open text edit and saves it; only then dispose() tears the editor down
      editor?.dispose()
      releaseBoardLock(BOARD)
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

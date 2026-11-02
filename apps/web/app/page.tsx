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
      const r = await p.load()
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
          text: `${r.dropped} invalid elements were dropped`,
          role: 'status',
        })
      if (r.status === 'unreadable') {
        const text = `Saved data could not be read (${r.reason.replace('-', ' ')})`
        note('unreadable', {
          text,
          role: 'alert',
          action:
            r.reason === 'unavailable'
              ? undefined
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

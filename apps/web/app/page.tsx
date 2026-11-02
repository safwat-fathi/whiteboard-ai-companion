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

const BOARD = 'local'

export default function Page() {
  const host = useRef<HTMLDivElement>(null)
  const [notes, setNotes] = useState<Note[]>([])
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
      // Test hook for Playwright; absent from production builds.
      if (process.env.NODE_ENV !== 'production')
        (window as unknown as { __editor?: Editor }).__editor = editor
      const p = createPersistence(editor, BOARD, {
        onSaveError: () =>
          note('save', { text: 'Could not save (storage full?)' }),
        onSaved: () => note('save', null),
      })
      persistence = p
      const r = await p.load()
      if (stop) return
      if (!locked) {
        editor.readOnly = true
        note('lock', { text: 'Open in another tab (read-only)' })
        return // a read-only tab never writes
      }
      p.start()
      if (r.status === 'ok' && r.dropped)
        note('dropped', { text: `${r.dropped} invalid elements were dropped` })
      if (r.status === 'unreadable') {
        const text = `Saved data could not be read (${r.reason.replace('-', ' ')})`
        note('unreadable', {
          text,
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
                        }),
                    ),
                },
        })
      }
    })()
    return () => {
      stop = true
      persistence?.stop()
      editor?.dispose()
      releaseBoardLock(BOARD)
    }
  }, [])
  return (
    <>
      <div ref={host} style={{ position: 'fixed', inset: 0 }} />
      <Notices notes={notes} />
    </>
  )
}

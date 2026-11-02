'use client'

import { useEffect, useRef } from 'react'
import { Editor } from '../src/editor/editor'
import { loadFonts } from '../src/editor/fonts'
import { browserPlatform } from '../src/editor/platform'

export default function Page() {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let editor: Editor | undefined
    let stop = false
    loadFonts().then(() => {
      // Platform is created after fonts load: text layout is memoised per Platform object.
      if (!stop && host.current)
        editor = new Editor(host.current, { platform: browserPlatform() })
    })
    return () => {
      stop = true
      editor?.dispose()
    }
  }, [])
  return <div ref={host} style={{ position: 'fixed', inset: 0 }} />
}

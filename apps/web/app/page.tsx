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
    loadFonts()
      .catch((err) => console.error('font loading failed', err))
      .then(() => {
        // Platform is created after fonts load: text layout is memoised per Platform object.
        if (!stop && host.current)
          editor = new Editor(host.current, { platform: browserPlatform() })
        // Test hook for Playwright; absent from production builds.
        if (editor && process.env.NODE_ENV !== 'production')
          (window as unknown as { __editor?: Editor }).__editor = editor
      })
    return () => {
      stop = true
      editor?.dispose()
    }
  }, [])
  return <div ref={host} style={{ position: 'fixed', inset: 0 }} />
}

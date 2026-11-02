'use client'

import { useEffect, useRef } from 'react'
import { runBench } from '../../src/bench/run'
import { Editor } from '../../src/editor/editor'
import { loadFonts } from '../../src/editor/fonts'
import { browserPlatform } from '../../src/editor/platform'

// /bench?n=5000|20000&dpr=<recorded only>: runs the S1 method against a real Editor and prints one JSON block;
// the result is also window.__benchResult (an { error } object if the run failed).
export default function Bench() {
  const host = useRef<HTMLDivElement>(null)
  const out = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const alive = { stop: false }
    let editor: Editor | undefined
    const show = (r: unknown) => {
      if (alive.stop) return
      ;(window as unknown as { __benchResult?: unknown }).__benchResult = r
      if (out.current) out.current.textContent = JSON.stringify(r, null, 1)
    }
    ;(async () => {
      const q = new URLSearchParams(location.search)
      const n = Number(q.get('n')) || 5000
      await loadFonts()
      if (alive.stop || !host.current) return
      editor = new Editor(host.current, { platform: browserPlatform() })
      show(await runBench(editor, n, q.get('dpr'), alive))
    })().catch((e) => show({ error: String(e?.stack ?? e) }))
    return () => {
      alive.stop = true
      editor?.dispose()
    }
  }, [])
  return (
    <>
      <div
        ref={host}
        style={{ position: 'fixed', top: 0, left: 0, width: 1440, height: 900 }}
      />
      <pre ref={out} style={{ paddingTop: 900, fontSize: 12 }}>
        running...
      </pre>
    </>
  )
}

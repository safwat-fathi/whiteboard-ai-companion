'use client'

import type { ContextDescriptor } from '@whiteboard/core'
import { useEffect, useRef, useState } from 'react'
import { type BoardBridge, prepareContext } from './board-context'
import {
  batchesOf,
  errorNotice,
  textOf,
  turnIdOf,
  turnStateOf,
  undoNote,
} from './chat-core'
import {
  type Chips,
  defaultChips,
  modeWords,
  type SelMode,
  selectionChip,
} from './chips'
import {
  type MessageActions,
  MessageBoundary,
  MessageView,
} from './MessageView'
import { type Mode, useTutorChat } from './useTutorChat'

type Preview = {
  text: string
  pictures: { blobId: string; of: string }[]
  tokens: number
}

const QUICK: {
  label: string
  mode: Mode
  text: string
  needsSelection?: boolean
}[] = [
  {
    label: 'Explain on the board',
    mode: 'explain',
    text: 'Explain this on the board: ',
  },
  {
    label: 'Summarise this chapter',
    mode: 'summarize',
    text: 'Summarise this chapter on the board.',
  },
  {
    label: 'Check my work',
    mode: 'check',
    text: 'Check my work.',
    needsSelection: true,
  },
  { label: 'Ask', mode: 'ask', text: '' },
]

const WORKING: Record<string, string> = {
  thinking: 'Thinking…',
  reading: 'Reading the book…',
  drawing: 'Drawing on the board…',
}

export function ChatTab(o: {
  apiBase: string
  boardId: string
  /** The WebSocket is live: sending needs the board to be reachable. */
  connected: boolean
  /** The board: selection, pictures, settling. Absent = a plain chat with no board context. */
  bridge?: BoardBridge
  /** Stores a picture or a pasted image on the server and returns its blob id. */
  upload?: (png: Blob) => Promise<string>
  /** "What the AI sees": the server's rendering of a context descriptor. */
  previewContext?: (
    context: Partial<ContextDescriptor>,
    images: string[],
  ) => Promise<Preview>
  /** Bumped by the selection toolbar's Ask AI: focus the composer. */
  focusSignal?: number
  /** "Show in chat" on an AI-drawn element: scroll to that turn's reply. */
  revealTurn?: { turnId: string; n: number }
  /** Told whenever a turn starts, changes what it is doing, or ends. */
  onTurn?: (t: { running: boolean; state?: string }) => void
  getContext?: () => Partial<ContextDescriptor>
  actions?: MessageActions
  /** Undoes the board changes of a whole turn or of one batch; absent = no undo buttons. */
  undo?: {
    turn: (turnId: string) => Promise<{ undone: number; skipped: number }>
    batch: (batchId: string) => Promise<{ undone: number; skipped: number }>
  }
  fetch?: typeof fetch
}) {
  const chat = useTutorChat(o)
  const [text, setText] = useState('')
  const [mode, setMode] = useState<Mode>('ask')
  const [heard, setHeard] = useState('')
  const [sel, setSel] = useState<string[]>([])
  const [chips, setChips] = useState<Chips>(defaultChips())
  const [files, setFiles] = useState<{ blobId: string; url: string }[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [peek, setPeek] = useState<
    | { state: 'loading' }
    | { state: 'error'; message: string }
    | {
        state: 'ready'
        preview: Preview
        thumbs: { of: string; url: string }[]
      }
    | null
  >(null)
  const hasSelection = sel.length > 0
  const [undoing, setUndoing] = useState<
    Record<string, { busy: boolean; note?: string }>
  >({})
  /** Runs an undo for a turn (`key` = turn id) and shows its outcome under the message. */
  const runUndo = async (
    key: string,
    call: () => Promise<{ undone: number; skipped: number }>,
  ) => {
    setUndoing((u) => ({ ...u, [key]: { busy: true } }))
    try {
      const note = undoNote(await call())
      setUndoing((u) => ({ ...u, [key]: { busy: false, note } }))
    } catch (e) {
      setUndoing((u) => ({
        ...u,
        [key]: {
          busy: false,
          note: e instanceof Error ? e.message : 'Could not undo.',
        },
      }))
    }
  }
  // follow the board's selection; a new selection brings a removed chip back
  const bridge = o.bridge
  useEffect(() => {
    if (!bridge) return
    const read = () => setSel(bridge.selection())
    read()
    return bridge.subscribe(read)
  }, [bridge])
  const selKey = sel.join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of selection resets the chip
  useEffect(
    () => setChips((c) => (c.selectionOff ? { ...c, selectionOff: false } : c)),
    [selKey],
  )
  const box = useRef<HTMLTextAreaElement>(null)
  const log = useRef<HTMLDivElement>(null)
  const reveal = o.revealTurn
  useEffect(() => {
    if (!reveal) return
    const el = [...(log.current?.querySelectorAll('[data-turn]') ?? [])].find(
      (x) => x.getAttribute('data-turn') === reveal.turnId,
    )
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    el?.animate?.([{ background: '#fff3b0' }, { background: 'transparent' }], {
      duration: 1500,
    })
  }, [reveal])
  const { focusSignal } = o
  useEffect(() => {
    if (focusSignal) box.current?.focus()
  }, [focusSignal])
  const attach = async (list: File[]) => {
    if (!o.upload) return
    try {
      for (const f of list) {
        if (!f.type.startsWith('image/')) continue
        const blobId = await o.upload(f)
        setFiles((x) =>
          [...x, { blobId, url: URL.createObjectURL(f) }].slice(0, 4),
        )
      }
    } catch (e) {
      setProblem(
        e instanceof Error ? e.message : 'Could not attach the picture.',
      )
    }
  }
  const end = useRef<HTMLDivElement>(null)
  const streaming = chat.status === 'streaming'
  const dailyOut =
    chat.error?.code === 'budget_exceeded' &&
    chat.error.details?.cap === 'daily'
  const last = chat.messages.at(-1)
  const undoUi = (m: (typeof chat.messages)[number]) => {
    const turn = turnIdOf(m)
    if (!o.undo || !turn || m.role !== 'assistant') return undefined
    const state = undoing[turn]
    const running = streaming && m === last
    return {
      available: !running && batchesOf(m).length > 0,
      busy: state?.busy ?? false,
      note: state?.note,
      run: () =>
        void runUndo(turn, () =>
          (o.undo as NonNullable<typeof o.undo>).turn(turn),
        ),
    }
  }

  // keep the newest text in view
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every change of the last message
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [chat.messages.length, last])

  // Screen readers hear one line when a turn starts and one when it ends, not every streamed word.
  const turnState = last ? turnStateOf(last) : undefined
  const { onTurn } = o
  useEffect(() => {
    onTurn?.({ running: streaming, state: streaming ? turnState : undefined })
  }, [streaming, turnState, onTurn])
  const wasStreaming = useRef(false)
  useEffect(() => {
    if (streaming && !wasStreaming.current) setHeard('The tutor is answering.')
    if (!streaming && wasStreaming.current && last?.role === 'assistant')
      setHeard(`The tutor finished: ${textOf(last).slice(0, 200)}`)
    wasStreaming.current = streaming
  }, [streaming, last])

  const submit = async () => {
    const body = text
    if (!body.trim() || streaming || !o.connected || dailyOut) return
    const m = mode
    setProblem(null)
    let context: Partial<ContextDescriptor> = {}
    if (o.bridge && o.upload) {
      setPreparing(true)
      try {
        context = (await prepareContext(o.bridge, o.upload, chips, m)).context
      } catch (e) {
        setPreparing(false)
        setProblem(
          `The board could not be attached: ${e instanceof Error ? e.message : 'unknown error'}`,
        )
        return // keep the text; nothing was sent
      }
      setPreparing(false)
    }
    const images = files.map((f) => f.blobId)
    setText('')
    setFiles([])
    setMode('ask')
    box.current?.focus()
    await chat.send(body, m, { context, images })
    box.current?.focus()
  }

  const openPeek = async () => {
    if (!o.bridge || !o.upload || !o.previewContext) return
    setPeek({ state: 'loading' })
    try {
      const p = await prepareContext(o.bridge, o.upload, chips, mode)
      const preview = await o.previewContext(
        p.context,
        files.map((f) => f.blobId),
      )
      setPeek({
        state: 'ready',
        preview,
        thumbs: [
          ...p.thumbs,
          ...files.map((f) => ({ of: 'attachment', url: f.url })),
        ],
      })
    } catch (e) {
      setPeek({
        state: 'error',
        message:
          e instanceof Error ? e.message : 'Could not build the preview.',
      })
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        position: 'relative',
      }}
    >
      <div
        ref={log}
        role="log"
        aria-label="Conversation"
        aria-live="off"
        style={{
          flex: 1,
          overflow: 'auto',
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {chat.hasEarlier && (
          <button type="button" onClick={() => void chat.loadEarlier()}>
            Show earlier messages
          </button>
        )}
        {chat.loaded && chat.messages.length === 0 && (
          <p style={{ color: '#555', fontSize: 13 }}>
            Ask a question about your book or your board. The tutor answers here
            and draws on the board.
          </p>
        )}
        {chat.messages.map((m) => (
          <MessageBoundary key={m.id}>
            <MessageView
              message={m}
              actions={{
                ...o.actions,
                ...(o.undo && turnIdOf(m)
                  ? {
                      onUndoBatch: (b) =>
                        void runUndo(`${turnIdOf(m)}`, () =>
                          (o.undo as NonNullable<typeof o.undo>).batch(
                            b.batchId,
                          ),
                        ),
                    }
                  : {}),
              }}
              undo={undoUi(m)}
            />
          </MessageBoundary>
        ))}
        {streaming && last?.role === 'assistant' && (
          <p style={{ color: '#555', fontSize: 13, margin: 0 }}>
            {WORKING[turnStateOf(last) ?? 'thinking'] ?? 'Working…'}
          </p>
        )}
        <div ref={end} />
      </div>
      <div
        aria-live="polite"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
        }}
      >
        {heard}
      </div>
      {!o.connected && (
        <p
          role="status"
          style={{
            margin: 0,
            padding: '6px 10px',
            background: '#fff7e0',
            fontSize: 13,
          }}
        >
          Reconnecting… sending is paused until the board is back.
        </p>
      )}
      {chat.error && (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: '6px 10px',
            background: '#fdecec',
            fontSize: 13,
          }}
        >
          {errorNotice(chat.error)}{' '}
          <button type="button" onClick={chat.clearError}>
            Dismiss
          </button>
        </p>
      )}
      <div
        style={{
          padding: 8,
          borderTop: '1px solid #ddd',
          display: 'grid',
          gap: 6,
        }}
      >
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {QUICK.map((q) => (
            <button
              key={q.label}
              type="button"
              disabled={streaming || (q.needsSelection && !hasSelection)}
              title={
                q.needsSelection && !hasSelection
                  ? 'Select something on the board first'
                  : undefined
              }
              onClick={() => {
                setMode(q.mode)
                setText(q.text)
                box.current?.focus()
              }}
            >
              {q.label}
            </button>
          ))}
        </div>
        {bridge && (
          <fieldset
            aria-label="What goes with your message"
            style={{
              display: 'flex',
              gap: 6,
              flexWrap: 'wrap',
              alignItems: 'center',
              fontSize: 13,
              border: 'none',
              margin: 0,
              padding: 0,
            }}
          >
            {selectionChip(chips, sel.length) && (
              <span
                title="The AI may edit these"
                style={{
                  display: 'inline-flex',
                  gap: 4,
                  alignItems: 'center',
                  border: '1px solid #c9d3ea',
                  background: '#f1f5ff',
                  borderRadius: 14,
                  padding: '1px 8px',
                }}
              >
                Selection ({sel.length}) ·
                <select
                  aria-label="How the selection is sent"
                  value={chips.selection}
                  onChange={(e) =>
                    setChips((c) => ({
                      ...c,
                      selection: e.target.value as SelMode,
                    }))
                  }
                >
                  {(['structure', 'picture', 'both'] as const).map((m) => (
                    <option key={m} value={m}>
                      {modeWords(m)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label="Do not send the selection"
                  onClick={() =>
                    setChips((c) => ({ ...c, selectionOff: true }))
                  }
                >
                  ×
                </button>
              </span>
            )}
            <button
              type="button"
              aria-pressed={chips.viewport}
              onClick={() => setChips((c) => ({ ...c, viewport: !c.viewport }))}
            >
              Viewport
            </button>
            <label>
              Whole board{' '}
              <select
                value={chips.board}
                onChange={(e) =>
                  setChips((c) => ({
                    ...c,
                    board: e.target.value as Chips['board'],
                  }))
                }
              >
                <option value="off">off</option>
                {(['structure', 'picture', 'both'] as const).map((m) => (
                  <option key={m} value={m}>
                    {modeWords(m)}
                  </option>
                ))}
              </select>
            </label>
            {o.previewContext && (
              <button type="button" onClick={() => void openPeek()}>
                What the AI sees
              </button>
            )}
          </fieldset>
        )}
        {files.length > 0 && (
          <div style={{ display: 'flex', gap: 6 }}>
            {files.map((f) => (
              <span key={f.blobId} style={{ position: 'relative' }}>
                {/* biome-ignore lint/performance/noImgElement: a local object URL of the pasted image */}
                <img
                  src={f.url}
                  alt="Attached"
                  style={{ height: 40, borderRadius: 4 }}
                />
                <button
                  type="button"
                  aria-label="Remove the attached picture"
                  onClick={() => setFiles((x) => x.filter((y) => y !== f))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {problem && (
          <p role="alert" style={{ margin: 0, fontSize: 13, color: '#a33' }}>
            {problem}
          </p>
        )}
        <textarea
          ref={box}
          onPaste={(e) => {
            const imgs = [...e.clipboardData.files].filter((f) =>
              f.type.startsWith('image/'),
            )
            if (imgs.length === 0) return
            e.preventDefault()
            void attach(imgs)
          }}
          onDrop={(e) => {
            const imgs = [...e.dataTransfer.files].filter((f) =>
              f.type.startsWith('image/'),
            )
            if (imgs.length === 0) return
            e.preventDefault()
            void attach(imgs)
          }}
          dir="auto"
          rows={3}
          aria-label="Message the tutor"
          placeholder="Ask the tutor…"
          value={text}
          disabled={dailyOut}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault()
              void submit()
            }
          }}
          style={{ resize: 'vertical', font: 'inherit' }}
        />
        {streaming ? (
          <button type="button" onClick={chat.stop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            disabled={!text.trim() || !o.connected || dailyOut || preparing}
            onClick={() => void submit()}
          >
            {preparing ? 'Attaching…' : 'Send'}
          </button>
        )}
      </div>
      {peek && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="What the AI sees"
          style={{
            position: 'absolute',
            inset: 0,
            background: '#fff',
            padding: 10,
            overflow: 'auto',
            zIndex: 5,
          }}
        >
          <h3 style={{ marginTop: 0 }}>What the AI sees</h3>
          {peek.state === 'loading' && <p>Preparing…</p>}
          {peek.state === 'error' && <p role="alert">{peek.message}</p>}
          {peek.state === 'ready' && (
            <>
              <p style={{ fontSize: 13 }}>
                About {peek.preview.tokens.toLocaleString('en-US')} tokens are
                added to your message.
              </p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {peek.thumbs.map((t) => (
                  // biome-ignore lint/performance/noImgElement: a local object URL of the picture that will be sent
                  <img
                    key={t.url + t.of}
                    src={t.url}
                    alt={`The ${t.of}, as the AI will see it`}
                    style={{ height: 80, border: '1px solid #ccc' }}
                  />
                ))}
              </div>
              <pre dir="auto" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
                {peek.preview.text}
              </pre>
            </>
          )}
          <button type="button" onClick={() => setPeek(null)}>
            Close
          </button>
        </div>
      )}
    </div>
  )
}

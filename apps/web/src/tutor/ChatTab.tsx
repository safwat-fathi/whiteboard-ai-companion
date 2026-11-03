'use client'

import type { ContextDescriptor } from '@whiteboard/core'
import { useEffect, useRef, useState } from 'react'
import {
  CloseIcon,
  EyeIcon,
  SendIcon,
  SparklesIcon,
  StopIcon,
} from '../ui/icons'
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
        className="flex-1 overflow-auto p-3 flex flex-col gap-3 min-h-0 bg-white"
      >
        {chat.hasEarlier && (
          <button
            type="button"
            onClick={() => void chat.loadEarlier()}
            className="self-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer shadow-2xs"
          >
            Show earlier messages
          </button>
        )}
        {chat.loaded && chat.messages.length === 0 && (
          <div className="my-auto flex flex-col items-center justify-center p-6 text-center">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-blue-50 text-blue-600 shadow-2xs">
              <SparklesIcon size={20} />
            </div>
            <p className="text-xs sm:text-sm font-medium text-slate-600 max-w-[260px] leading-relaxed">
              Ask a question about your book or your board. The tutor answers
              here and draws on the board.
            </p>
          </div>
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
          <div className="flex items-center gap-2 text-xs font-medium text-blue-600 bg-blue-50/70 px-3 py-1.5 rounded-full w-fit">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-600 animate-ping" />
            <span>
              {WORKING[turnStateOf(last) ?? 'thinking'] ?? 'Working…'}
            </span>
          </div>
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
      <div className="border-t border-slate-200/80 bg-slate-50/50 flex flex-col gap-2 p-2">
        <div className="flex flex-wrap gap-1.5 px-1">
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
              className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-2xs transition-all hover:border-blue-400 hover:bg-blue-50/50 hover:text-blue-700 disabled:opacity-40 disabled:hover:border-slate-200 disabled:hover:bg-white cursor-pointer"
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
            className="flex flex-wrap items-center gap-1.5 px-1 text-xs text-slate-600 border-none m-0"
          >
            {selectionChip(chips, sel.length) && (
              <span
                title="The AI may edit these"
                className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50/90 px-2.5 py-0.5 text-xs font-medium text-blue-700 shadow-2xs"
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
                  className="bg-transparent text-xs font-semibold text-blue-800 focus:outline-none cursor-pointer"
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
                  className="ml-0.5 text-sm font-bold text-blue-500 hover:text-blue-800 cursor-pointer leading-none"
                >
                  ×
                </button>
              </span>
            )}
            <button
              type="button"
              aria-pressed={chips.viewport}
              onClick={() => setChips((c) => ({ ...c, viewport: !c.viewport }))}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors cursor-pointer shadow-2xs ${
                chips.viewport
                  ? 'border-blue-500 bg-blue-50 text-blue-700 font-semibold'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              Viewport
            </button>
            <label className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs text-slate-600 shadow-2xs cursor-pointer">
              Whole board{' '}
              <select
                value={chips.board}
                onChange={(e) =>
                  setChips((c) => ({
                    ...c,
                    board: e.target.value as Chips['board'],
                  }))
                }
                className="bg-transparent text-xs font-medium text-slate-800 focus:outline-none cursor-pointer"
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
              <button
                type="button"
                onClick={() => void openPeek()}
                className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs text-slate-600 hover:border-slate-300 hover:bg-slate-50 transition-colors cursor-pointer shadow-2xs"
              >
                What the AI sees
              </button>
            )}
          </fieldset>
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1">
            {files.map((f) => (
              <span key={f.blobId} className="relative inline-block">
                {/* biome-ignore lint/performance/noImgElement: a local object URL of the pasted image */}
                <img
                  src={f.url}
                  alt="Attached"
                  className="h-10 rounded-lg border border-slate-200 object-cover shadow-2xs"
                />
                <button
                  type="button"
                  aria-label="Remove the attached picture"
                  onClick={() => setFiles((x) => x.filter((y) => y !== f))}
                  className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-slate-800 text-[10px] font-bold text-white hover:bg-red-600 cursor-pointer"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {problem && (
          <p role="alert" className="m-0 px-1 text-xs font-medium text-red-600">
            {problem}
          </p>
        )}
        <div className="flex flex-col rounded-2xl border border-slate-200/90 bg-white p-2 shadow-xs transition-all focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-100">
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
            className="w-full resize-none border-none bg-transparent p-1 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none font-sans leading-relaxed min-h-[52px]"
          />
          <div className="flex items-center justify-end pt-1">
            {streaming ? (
              <button
                type="button"
                onClick={chat.stop}
                className="flex items-center gap-1 rounded-full bg-rose-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-rose-700 active:scale-95 transition-all cursor-pointer"
              >
                <StopIcon size={12} fill="currentColor" /> Stop
              </button>
            ) : (
              <button
                type="button"
                disabled={!text.trim() || !o.connected || dailyOut || preparing}
                onClick={() => void submit()}
                className="flex items-center gap-1.5 rounded-full bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-40 disabled:hover:bg-blue-600 cursor-pointer"
              >
                <SendIcon size={12} />
                <span>{preparing ? 'Attaching…' : 'Send'}</span>
              </button>
            )}
          </div>
        </div>
      </div>
      {peek && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="What the AI sees"
          className="absolute inset-0 z-30 flex flex-col bg-white/95 p-4 backdrop-blur-md overflow-auto animate-in fade-in"
        >
          <div className="flex items-center justify-between border-b border-slate-200 pb-2 mb-3">
            <h3 className="m-0 text-base font-semibold text-slate-900 flex items-center gap-2">
              <EyeIcon size={18} className="text-blue-600" />
              What the AI sees
            </h3>
            <button
              type="button"
              onClick={() => setPeek(null)}
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
            >
              <CloseIcon size={16} />
            </button>
          </div>
          {peek.state === 'loading' && (
            <p className="text-sm text-slate-500">Preparing…</p>
          )}
          {peek.state === 'error' && (
            <p role="alert" className="text-sm text-red-600">
              {peek.message}
            </p>
          )}
          {peek.state === 'ready' && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-slate-600 bg-slate-50 p-2 rounded-lg border border-slate-200">
                About{' '}
                <strong>{peek.preview.tokens.toLocaleString('en-US')}</strong>{' '}
                tokens are added to your message.
              </p>
              {peek.thumbs.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                  {peek.thumbs.map((t) => (
                    // biome-ignore lint/performance/noImgElement: a local object URL of the picture that will be sent
                    <img
                      key={t.url + t.of}
                      src={t.url}
                      alt={`The ${t.of}, as the AI will see it`}
                      className="h-20 rounded-lg border border-slate-200 shadow-2xs object-cover"
                    />
                  ))}
                </div>
              )}
              <pre
                dir="auto"
                className="whitespace-pre-wrap text-xs bg-slate-50 p-3 rounded-lg border border-slate-200 text-slate-800 font-mono max-h-[300px] overflow-auto"
              >
                {peek.preview.text}
              </pre>
            </div>
          )}
          <div className="mt-auto pt-3">
            <button
              type="button"
              onClick={() => setPeek(null)}
              className="w-full rounded-xl border border-slate-200 bg-slate-100 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-200 transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

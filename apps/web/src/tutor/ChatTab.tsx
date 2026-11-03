'use client'

import type { ContextDescriptor } from '@whiteboard/core'
import { useEffect, useRef, useState } from 'react'
import {
  batchesOf,
  errorNotice,
  textOf,
  turnIdOf,
  turnStateOf,
  undoNote,
} from './chat-core'
import {
  type MessageActions,
  MessageBoundary,
  MessageView,
} from './MessageView'
import { type Mode, useTutorChat } from './useTutorChat'

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
  hasSelection?: boolean
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
  const box = useRef<HTMLTextAreaElement>(null)
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
    setText('')
    const m = mode
    setMode('ask')
    box.current?.focus()
    await chat.send(body, m)
    box.current?.focus()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
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
              disabled={streaming || (q.needsSelection && !o.hasSelection)}
              title={
                q.needsSelection && !o.hasSelection
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
        <textarea
          ref={box}
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
            disabled={!text.trim() || !o.connected || dailyOut}
            onClick={() => void submit()}
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}

'use client'

import type { ContextDescriptor, MessageDto } from '@whiteboard/core'
import { DefaultChatTransport, readUIMessageStream } from 'ai'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type ChatError,
  parseChatError,
  type TutorMessage,
  textOf,
  toMessage,
} from './chat-core'

/** Yields what `source` yields until `signal` aborts, then stops at once (a closed connection may leave the reader waiting). */
async function* until<T>(signal: AbortSignal, source: AsyncIterable<T>) {
  const it = source[Symbol.asyncIterator]()
  const aborted = new Promise<{ done: true; value: undefined }>((resolve) => {
    if (signal.aborted) resolve({ done: true, value: undefined })
    signal.addEventListener(
      'abort',
      () => resolve({ done: true, value: undefined }),
      { once: true },
    )
  })
  try {
    for (;;) {
      const r = await Promise.race([it.next(), aborted])
      if (r.done) return
      yield r.value as T
    }
  } finally {
    void it.return?.(undefined)?.catch?.(() => {})
  }
}

export type ChatStatus = 'idle' | 'streaming'
export type Mode = ContextDescriptor['mode']

/**
 * The chat for one board: history from the server, then each turn streamed over `POST /api/chat`. The server owns the
 * conversation, so a request carries only the new message and its context (chat-ui.md "Transport"; AI SDK transport,
 * no `@ai-sdk/react`).
 */
export function useTutorChat(o: {
  apiBase: string
  boardId: string
  /** What the student attached; read when a message is sent. */
  getContext?: () => Partial<ContextDescriptor>
  fetch?: typeof fetch
}) {
  const { apiBase, boardId } = o
  const [messages, setMessages] = useState<TutorMessage[]>([])
  const [status, setStatus] = useState<ChatStatus>('idle')
  const [error, setError] = useState<ChatError | null>(null)
  const [next, setNext] = useState<string | undefined>()
  const [loaded, setLoaded] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const seq = useRef(0)
  const getContext = useRef(o.getContext)
  getContext.current = o.getContext
  const fetchRef = useRef(o.fetch)
  fetchRef.current = o.fetch
  // a stable function, so the transport and the history loader are not rebuilt on every render
  const doFetch = useCallback(
    (...a: Parameters<typeof fetch>) => (fetchRef.current ?? fetch)(...a),
    [],
  )

  const transport = useMemo(
    () =>
      new DefaultChatTransport<TutorMessage>({
        api: `${apiBase}/api/chat`,
        fetch: doFetch,
        prepareSendMessagesRequest: ({ messages: sent, body }) => ({
          body: {
            boardId,
            message: {
              text: textOf(sent.at(-1) as TutorMessage),
              images: (body as { images?: string[] } | undefined)?.images ?? [],
            },
            context: (body as { context?: unknown } | undefined)?.context ?? {},
          },
        }),
      }),
    [apiBase, boardId, doFetch],
  )

  const page = useCallback(
    async (before?: string) => {
      const q = `limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`
      const res = await doFetch(
        `${apiBase}/api/boards/${encodeURIComponent(boardId)}/messages?${q}`,
      )
      if (!res.ok) throw new Error(`history: ${res.status}`)
      return (await res.json()) as { messages: MessageDto[]; next?: string }
    },
    [apiBase, boardId, doFetch],
  )

  useEffect(() => {
    let live = true
    setMessages([])
    setLoaded(false)
    page().then(
      (r) => {
        if (!live) return
        setMessages(r.messages.map(toMessage))
        setNext(r.next)
        setLoaded(true)
      },
      () => live && setLoaded(true), // an empty history is better than a stuck spinner; sending still works
    )
    return () => {
      live = false
      abort.current?.abort()
    }
  }, [page])

  const loadEarlier = useCallback(async () => {
    if (!next) return
    const r = await page(next)
    setMessages((m) => [...r.messages.map(toMessage), ...m])
    setNext(r.next)
  }, [next, page])

  const send = useCallback(
    async (
      text: string,
      mode: Mode = 'ask',
      /** What the student attached to this message: the context descriptor and pasted images (blob ids). */
      extra: { context?: Partial<ContextDescriptor>; images?: string[] } = {},
    ) => {
      const body = text.trim()
      if (!body || abort.current) return
      const ac = new AbortController()
      abort.current = ac
      setError(null)
      setStatus('streaming')
      const mine: TutorMessage = {
        id: `local-${++seq.current}`,
        role: 'user',
        parts: [{ type: 'text', text: body }],
      }
      setMessages((m) => [...m, mine])
      const stop = () => {
        abort.current = null
        setStatus('idle')
      }
      let stream: Awaited<ReturnType<typeof transport.sendMessages>>
      try {
        stream = await transport.sendMessages({
          chatId: boardId,
          messages: [mine],
          abortSignal: ac.signal,
          trigger: 'submit-message',
          messageId: undefined,
          body: {
            context: { ...getContext.current?.(), ...extra.context, mode },
            images: extra.images ?? [],
          },
        })
      } catch (e) {
        // refused before any byte (turn_busy, budget, no key ...): the server stored nothing, so neither do we
        setMessages((m) => m.filter((x) => x !== mine))
        if (!ac.signal.aborted) setError(parseChatError(e))
        return stop()
      }
      try {
        for await (const snap of until(
          ac.signal,
          readUIMessageStream<TutorMessage>({
            stream,
            onError: (e) => setError(parseChatError(e)),
          }),
        )) {
          setMessages((m) => {
            const i = m.findIndex((x) => x.id === snap.id)
            return i >= 0 ? m.map((x, j) => (j === i ? snap : x)) : [...m, snap]
          })
        }
      } catch (e) {
        if (!ac.signal.aborted) setError(parseChatError(e))
      }
      stop()
    },
    [boardId, transport],
  )

  /** New chat: the server hides the old messages and drops its summary; the board is untouched. */
  const newChat = useCallback(async () => {
    if (abort.current) return
    const res = await doFetch(
      `${apiBase}/api/boards/${encodeURIComponent(boardId)}/chat/reset`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    )
    if (!res.ok)
      return setError(parseChatError(await res.text().catch(() => '')))
    setMessages([])
    setNext(undefined)
    setError(null)
  }, [apiBase, boardId, doFetch])

  return {
    newChat,
    messages,
    status,
    error,
    loaded,
    hasEarlier: next !== undefined,
    loadEarlier,
    send,
    /** Stop: closes the request; the server aborts the model call and keeps what was said and drawn. */
    stop: useCallback(() => abort.current?.abort(), []),
    clearError: useCallback(() => setError(null), []),
  }
}

// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatTab } from './ChatTab'

vi.mock('@whiteboard/math', () => ({
  renderMath: async (latex: string) => ({
    ok: true,
    svg: `<svg xmlns="http://www.w3.org/2000/svg"><title>${latex}</title></svg>`,
    width: 2,
    height: 1,
    depth: 0.2,
  }),
}))

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const BOOK = 'a'.repeat(64)
const usage = {
  inputTokens: 1200,
  cachedTokens: 400,
  outputTokens: 210,
  costUsd: null,
  model: 'muse-spark-1.3',
}
const sse = (chunks: unknown[]) =>
  new Response(
    [
      ...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`),
      'data: [DONE]\n\n',
    ].join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
const err = (
  status: number,
  code: string,
  message: string,
  details?: unknown,
) =>
  new Response(JSON.stringify({ error: { code, message, details } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
const text = (id: string, ...deltas: string[]) => [
  { type: 'text-start', id },
  ...deltas.map((delta) => ({ type: 'text-delta', id, delta })),
  { type: 'text-end', id },
]
const turn = (...middle: unknown[]) => [
  { type: 'start', messageId: 'srv-1' },
  { type: 'data-turn', data: { turnId: 't1' } },
  ...middle,
  { type: 'data-usage', data: usage },
  { type: 'finish' },
]

// biome-ignore lint/suspicious/noExplicitAny: the posted JSON is inspected loosely
type Posted = { url: string; body: any }
function world(
  post: (init: RequestInit) => Response | Promise<Response>,
  history: unknown[] = [],
) {
  const posted: Posted[] = []
  const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === 'POST') {
      posted.push({ url: u, body: JSON.parse(String(init.body)) })
      return post(init)
    }
    if (u.includes('/messages'))
      return new Response(JSON.stringify({ messages: history }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    return new Response('nope', { status: 404 })
  })
  return { posted, fetch: fetchFn as unknown as typeof fetch }
}

let unmount: (() => Promise<void>) | undefined
let host: HTMLDivElement
async function mount(
  w: { fetch: typeof fetch },
  props: Record<string, unknown> = {},
) {
  host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      createElement(ChatTab, {
        apiBase: 'http://srv',
        boardId: 'b1',
        connected: true,
        fetch: w.fetch,
        ...props,
      }),
    )
  })
  await act(async () => {}) // history
  unmount = async () => {
    await act(async () => root.unmount())
    host.remove()
  }
}
afterEach(async () => {
  await unmount?.()
  unmount = undefined
})
const q = <T extends Element>(s: string) => host.querySelector(s) as T
const box = () => q<HTMLTextAreaElement>('textarea')
const btn = (label: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement
async function type(v: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set
    set?.call(box(), v)
    box().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const press = (key: string, o: KeyboardEventInit = {}) =>
  act(async () => {
    box().dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...o,
      }),
    )
  })
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })

describe('ChatTab', () => {
  it('restores history, in the message language direction, with the stored footer', async () => {
    const w = world(
      () => err(500, 'x', 'x'),
      [
        {
          id: 'u1',
          turnId: 't',
          role: 'user',
          parts: [{ type: 'text', text: 'ما هو الجذر؟' }],
          createdAt: 1,
        },
        {
          id: 'a1',
          turnId: 't',
          role: 'assistant',
          parts: [{ type: 'text', text: 'الجذر هو …' }],
          usage,
          createdAt: 2,
        },
      ],
    )
    await mount(w)
    expect(host.querySelectorAll('article')).toHaveLength(2)
    expect(q('article[aria-label="You"] div').getAttribute('dir')).toBe('auto')
    expect(host.textContent).toContain('1,200 in (400 cached)')
    expect(box().getAttribute('dir')).toBe('auto')
  })

  it('sends only the new message and its context, streams the reply, and renders chips, math and verified citations', async () => {
    const onCite = vi.fn()
    const onLocate = vi.fn()
    const w = world(() =>
      sse(
        turn(
          {
            type: 'data-source',
            data: { bookId: BOOK, pageStart: 40, pageEnd: 44 },
          },
          ...text(
            'x',
            `Roots: $x^2=4$. See [p. 41](cite:${BOOK}#41), `,
            `[p. 99](cite:${BOOK}#99) and `,
            '[the box](board:el_7), [bad](https://evil.test).',
          ),
          {
            type: 'data-batch',
            data: {
              batchId: 'b1',
              seq: 3,
              label: 'Added concept map',
              bounds: null,
              count: 12,
            },
          },
        ),
      ),
    )
    await mount(w, {
      actions: { onCite, onLocate },
      getContext: () => ({ selection: ['el_1'] }),
    })
    await type('Explain roots')
    await press('Enter')
    await settle()
    expect(w.posted).toHaveLength(1)
    expect(w.posted[0]?.url).toBe('http://srv/api/chat')
    expect(Object.keys(w.posted[0]?.body)).toEqual([
      'boardId',
      'message',
      'context',
    ])
    expect(w.posted[0]?.body).toMatchObject({
      boardId: 'b1',
      message: { text: 'Explain roots' },
      context: { mode: 'ask', selection: ['el_1'] },
    })

    const reply = q('article[aria-label="Tutor"]')
    expect(reply.textContent).toContain('Roots:')
    expect(reply.querySelector('img[alt="x^2=4"]')).not.toBeNull()
    expect(reply.textContent).toContain('Added concept map · 12 elements')
    expect(reply.textContent).toContain('1,200 in (400 cached)')
    // verified page -> a button; invented page -> plain text; board link -> button; outside link -> plain text
    const links = [...reply.querySelectorAll('button')].map(
      (b) => b.textContent,
    )
    expect(links).toEqual(expect.arrayContaining(['p. 41', 'the box']))
    expect(links).not.toContain('p. 99')
    expect(reply.textContent).toContain('p. 99')
    expect(reply.querySelector('a')).toBeNull()
    expect(reply.textContent).toContain('bad')
    await act(async () => (btn('p. 41') as HTMLElement).click())
    expect(onCite).toHaveBeenCalledWith({ bookId: BOOK, page: 41 })
    await act(async () => (btn('the box') as HTMLElement).click())
    expect(onLocate).toHaveBeenCalledWith('el_7')
    expect(box().value).toBe('')
  })

  it('Shift+Enter is a newline, not a send; an empty message is never sent', async () => {
    const w = world(() => sse(turn(...text('x', 'ok'))))
    await mount(w)
    await press('Enter')
    await type('line one')
    await press('Enter', { shiftKey: true })
    expect(w.posted).toHaveLength(0)
    await press('Enter', { isComposing: true }) // an IME confirming a character
    expect(w.posted).toHaveLength(0)
  })

  it('Stop closes the request, keeps the partial reply and offers Send again without an error', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c
      },
    })
    const enc = new TextEncoder()
    const w = world(
      () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    )
    await mount(w)
    await type('slow one')
    await press('Enter')
    await act(async () => {
      for (const c of [
        { type: 'start', messageId: 's' },
        ...text('p', 'Partial answer'),
      ].slice(0, 3))
        controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`))
    })
    await settle()
    expect(btn('Stop')).toBeTruthy()
    expect(btn('Send')).toBeUndefined()
    await act(async () => btn('Stop').click())
    await settle()
    expect(btn('Send')).toBeTruthy()
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelectorAll('article')).toHaveLength(2)
  })

  it('turn_busy shows a plain notice and leaves no half-sent message behind', async () => {
    const w = world(() =>
      err(409, 'turn_busy', 'The AI is still working on this board.'),
    )
    await mount(w)
    await type('hello')
    await press('Enter')
    await settle()
    expect(q('[role="alert"]').textContent).toMatch(
      /still working on this board/,
    )
    expect(host.querySelectorAll('article')).toHaveLength(0)
  })

  it('the daily budget cap disables the composer and says what to do', async () => {
    const w = world(() =>
      err(429, 'budget_exceeded', 'The daily budget is used up.', {
        cap: 'daily',
      }),
    )
    await mount(w)
    await type('hello')
    await press('Enter')
    await settle()
    expect(q('[role="alert"]').textContent).toMatch(/daily AI budget/)
    expect(box().disabled).toBe(true)
  })

  it("a failure in the middle of the stream shows the server's words", async () => {
    const w = world(() =>
      sse([
        { type: 'start', messageId: 's' },
        {
          type: 'error',
          errorText: JSON.stringify({
            code: 'upstream_error',
            message: 'The AI provider failed to answer. Try again.',
          }),
        },
      ]),
    )
    await mount(w)
    await type('hello')
    await press('Enter')
    await settle()
    expect(q('[role="alert"]').textContent).toContain(
      'The AI provider failed to answer',
    )
  })

  it('while the board is disconnected it says so and will not send', async () => {
    const w = world(() => sse(turn(...text('x', 'ok'))))
    await mount(w, { connected: false })
    expect(q('[role="status"]').textContent).toMatch(/Reconnecting/)
    await type('hello')
    expect(btn('Send').disabled).toBe(true)
    await press('Enter')
    expect(w.posted).toHaveLength(0)
  })

  it('a quick action sets the turn mode; Check my work needs a selection', async () => {
    const w = world(() => sse(turn(...text('x', 'ok'))))
    await mount(w)
    expect(btn('Check my work').disabled).toBe(true)
    await act(async () => btn('Explain on the board').click())
    expect(box().value).toMatch(/Explain this on the board/)
    await press('Enter')
    await settle()
    expect(w.posted[0]?.body.context.mode).toBe('explain')
  })
})

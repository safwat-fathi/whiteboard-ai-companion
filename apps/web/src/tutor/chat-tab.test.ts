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

  it('a malformed link in the reply cannot crash the chat: it renders as plain text', async () => {
    const w = world(() =>
      sse(
        turn(
          ...text('x', 'See [bad id](board:%E0%A4%A) and [ok](board:el_2).'),
        ),
      ),
    )
    await mount(w, { actions: { onLocate: vi.fn() } })
    await type('hello')
    await press('Enter')
    await settle()
    const reply = q('article[aria-label="Tutor"]')
    expect(reply.textContent).toContain('bad id')
    expect(
      [...reply.querySelectorAll('button')].map((b) => b.textContent),
    ).toEqual(['ok'])
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
    const dismissBtn = q<HTMLButtonElement>(
      '[role="alert"] button[aria-label="Dismiss error"]',
    )
    expect(dismissBtn).toBeTruthy()
    await act(async () => dismissBtn.click())
    await settle()
    expect(host.querySelector('[role="alert"]')).toBeNull()
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

  describe('undo', () => {
    const chip = {
      batchId: 'b1',
      seq: 3,
      label: 'Added concept map',
      bounds: null,
      count: 12,
    }
    const drew = () =>
      sse(turn(...text('x', 'Here it is.'), { type: 'data-batch', data: chip }))
    const fakeUndo = (
      over: Partial<{
        turn: () => Promise<{ undone: number; skipped: number }>
      }> = {},
    ) => ({
      turn: vi.fn(over.turn ?? (async () => ({ undone: 3, skipped: 1 }))),
      batch: vi.fn(async () => ({ undone: 1, skipped: 0 })),
    })

    it('offers Undo this response once the turn that drew is over, and reports what happened', async () => {
      const w = world(drew)
      const undo = fakeUndo()
      await mount(w, { undo })
      await type('draw it')
      await press('Enter')
      await settle()
      await act(async () => btn('Undo this response').click())
      expect(undo.turn).toHaveBeenCalledWith('t1')
      expect(host.textContent).toContain(
        'Undid 3 changes. 1 change was kept because you edited it afterwards.',
      )
    })

    it('a chip has its own Undo', async () => {
      const w = world(drew)
      const undo = fakeUndo()
      await mount(w, { undo })
      await type('draw it')
      await press('Enter')
      await settle()
      await act(async () => btn('Undo').click())
      expect(undo.batch).toHaveBeenCalledWith('b1')
      expect(host.textContent).toContain('Undid 1 change.')
    })

    it('is not offered for a reply that changed nothing, or while the reply is still streaming', async () => {
      const plain = world(() => sse(turn(...text('x', 'Just words.'))))
      await mount(plain, { undo: fakeUndo() })
      await type('hi')
      await press('Enter')
      await settle()
      expect(btn('Undo this response')).toBeUndefined()
      await unmount?.()
      unmount = undefined

      let controller!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c
        },
      })
      const open = world((init) => {
        init.signal?.addEventListener('abort', () =>
          controller.error(new DOMException('Aborted', 'AbortError')),
        )
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      })
      await mount(open, { undo: fakeUndo() })
      await type('draw')
      await press('Enter')
      await act(async () => {
        const enc = new TextEncoder()
        for (const c of [
          { type: 'start', messageId: 's' },
          { type: 'data-turn', data: { turnId: 't2' } },
          { type: 'data-batch', data: chip },
        ])
          controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`))
      })
      await settle()
      expect(btn('Undo this response')).toBeUndefined()
      await act(async () => btn('Stop').click())
      await settle()
      expect(btn('Undo this response')).toBeTruthy() // after Stop the batches that landed can be undone
    })

    it('shows the failure in words and lets the student try again', async () => {
      const w = world(drew)
      const undo = fakeUndo({
        turn: async () => {
          throw new Error('The server could not be reached.')
        },
      })
      await mount(w, { undo })
      await type('draw it')
      await press('Enter')
      await settle()
      await act(async () => btn('Undo this response').click())
      expect(host.textContent).toContain('The server could not be reached.')
      expect(btn('Undo this response').disabled).toBe(false)
    })
  })

  describe('board context', () => {
    const rect = { x: 0, y: 0, w: 10, h: 10 }
    function fakeBridge(initial: string[]) {
      let selection = initial
      const listeners = new Set<() => void>()
      const pictured: string[] = []
      const bridge = {
        selection: () => selection,
        subscribe: (fn: () => void) => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        viewport: () => ({ x: 0, y: 0, w: 800, h: 600, zoom: 1 }),
        picture: async (of: string) => {
          pictured.push(of)
          return {
            png: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
            rect,
          }
        },
        settle: async () => {},
      }
      return {
        bridge,
        pictured,
        select: async (ids: string[]) => {
          selection = ids
          await act(async () => {
            for (const fn of listeners) fn()
          })
        },
      }
    }
    const uploads: Blob[] = []
    const upload = async (b: Blob) => {
      uploads.push(b)
      return `blob-${uploads.length}`
    }
    const ok = () => sse(turn(...text('x', 'ok')))
    const chipRow = () => q('[aria-label="What goes with your message"]')

    it('sends the selection as data and a picture, and the ids that may be edited', async () => {
      uploads.length = 0
      URL.createObjectURL = () => 'blob:local'
      const b = fakeBridge(['a', 'b'])
      const w = world(ok)
      await mount(w, { bridge: b.bridge, upload })
      expect(chipRow().textContent).toContain('Selection (2)')
      expect(q('[title="The AI may edit these"]')).not.toBeNull()
      await type('make these red')
      await press('Enter')
      await settle()
      expect(uploads).toHaveLength(1)
      expect(w.posted[0]?.body.context).toMatchObject({
        selection: ['a', 'b'],
        attach: { selection: 'both', viewport: 'none', board: 'none' },
        pictures: [{ blobId: 'blob-1', of: 'selection', rect }],
        viewport: { w: 800 },
      })
    })

    it('structure only sends no picture; removing the chip sends no selection at all; a new selection brings it back', async () => {
      uploads.length = 0
      URL.createObjectURL = () => 'blob:local'
      const b = fakeBridge(['a'])
      const w = world(ok)
      await mount(w, { bridge: b.bridge, upload })
      const mode = q<HTMLSelectElement>(
        'select[aria-label="How the selection is sent"]',
      )
      await act(async () => {
        mode.value = 'structure'
        mode.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await type('one')
      await press('Enter')
      await settle()
      expect(w.posted[0]?.body.context).toMatchObject({
        selection: ['a'],
        attach: { selection: 'structure' },
        pictures: [],
      })
      expect(uploads).toHaveLength(0)

      await act(async () =>
        (q('[aria-label="Do not send the selection"]') as HTMLElement).click(),
      )
      expect(chipRow().textContent).not.toContain('Selection (')
      await type('two')
      await press('Enter')
      await settle()
      expect(w.posted[1]?.body.context).toMatchObject({
        selection: [],
        attach: { selection: 'none' },
      })

      await b.select(['a', 'c'])
      expect(chipRow().textContent).toContain('Selection (2)')
    })

    it('the viewport and whole-board chips add their pictures; Check my work needs a selection', async () => {
      uploads.length = 0
      URL.createObjectURL = () => 'blob:local'
      const b = fakeBridge([])
      const w = world(ok)
      await mount(w, { bridge: b.bridge, upload })
      expect(btn('Check my work').disabled).toBe(true)
      await b.select(['a'])
      expect(btn('Check my work').disabled).toBe(false)
      await b.select([])
      await act(async () => btn('Viewport').click())
      const board = [...host.querySelectorAll('label')]
        .find((l) => l.textContent?.includes('Whole board'))
        ?.querySelector('select') as HTMLSelectElement
      await act(async () => {
        board.value = 'picture'
        board.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await type('what do you see')
      await press('Enter')
      await settle()
      expect(b.pictured).toEqual(['viewport', 'board'])
      expect(w.posted[0]?.body.context).toMatchObject({
        attach: { selection: 'none', viewport: 'picture', board: 'picture' },
      })
    })

    it('"What the AI sees" shows the digest text, the pictures and the size, and sends nothing', async () => {
      uploads.length = 0
      URL.createObjectURL = () => 'blob:local'
      const b = fakeBridge(['a'])
      const w = world(ok)
      const previewContext = vi.fn(async (_c: unknown, _i: string[]) => ({
        text: '<board_state>BOARD "B"</board_state>',
        pictures: [{ blobId: 'blob-1', of: 'selection' }],
        tokens: 1700,
      }))
      await mount(w, { bridge: b.bridge, upload, previewContext })
      await act(async () => btn('What the AI sees').click())
      await settle()
      const dialog = document.querySelector('[role="dialog"]') as HTMLElement
      expect(dialog.textContent).toContain('BOARD "B"')
      expect(dialog.textContent).toContain('1,700 tokens')
      expect(dialog.querySelector('img')).not.toBeNull()
      expect(previewContext.mock.calls[0]?.[0]).toMatchObject({
        selection: ['a'],
        attach: { selection: 'both' },
      })
      expect(w.posted).toHaveLength(0)
    })

    it('a picture that cannot be prepared keeps the text and says why; nothing is sent', async () => {
      const b = fakeBridge(['a'])
      const w = world(ok)
      await mount(w, {
        bridge: b.bridge,
        upload: async () => {
          throw new Error('upload failed')
        },
      })
      await type('hello')
      await press('Enter')
      await settle()
      expect(q('[role="alert"]').textContent).toMatch(
        /could not be attached: upload failed/,
      )
      expect(box().value).toBe('hello')
      expect(w.posted).toHaveLength(0)
    })

    it('a pasted image is uploaded and goes along with the message', async () => {
      uploads.length = 0
      URL.createObjectURL = () => 'blob:local'
      const w = world(ok)
      await mount(w, { upload })
      const file = new File([new Uint8Array([1, 2, 3])], 'p.png', {
        type: 'image/png',
      })
      await act(async () => {
        const e = new Event('paste', {
          bubbles: true,
          cancelable: true,
        }) as Event & { clipboardData: unknown }
        e.clipboardData = { files: [file] }
        box().dispatchEvent(e)
      })
      await settle()
      expect(host.querySelector('img[alt="Attached"]')).not.toBeNull()
      await type('what is this')
      await press('Enter')
      await settle()
      expect(w.posted[0]?.body.message).toEqual({
        text: 'what is this',
        images: ['blob-1'],
      })
      expect(host.querySelector('img[alt="Attached"]')).toBeNull() // used up
    })
  })

  describe('Show in chat', () => {
    it('scrolls to the reply of the turn that drew the element', async () => {
      const w = world(
        () => err(500, 'x', 'x'),
        [
          {
            id: 'u1',
            turnId: 't1',
            role: 'user',
            parts: [{ type: 'text', text: 'first' }],
            createdAt: 1,
          },
          {
            id: 'a1',
            turnId: 't1',
            role: 'assistant',
            parts: [
              { type: 'data-turn', data: { turnId: 't1' } },
              { type: 'text', text: 'one' },
            ],
            createdAt: 2,
          },
          {
            id: 'u2',
            turnId: 't2',
            role: 'user',
            parts: [{ type: 'text', text: 'second' }],
            createdAt: 3,
          },
          {
            id: 'a2',
            turnId: 't2',
            role: 'assistant',
            parts: [
              { type: 'data-turn', data: { turnId: 't2' } },
              { type: 'text', text: 'two' },
            ],
            createdAt: 4,
          },
        ],
      )
      const scrolled: string[] = []
      Element.prototype.scrollIntoView = function (this: Element) {
        if (this.getAttribute('data-turn'))
          scrolled.push(this.getAttribute('data-turn') as string)
      }
      host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const render = (revealTurn?: { turnId: string; n: number }) =>
        act(async () =>
          root.render(
            createElement(ChatTab, {
              apiBase: 'http://srv',
              boardId: 'b1',
              connected: true,
              fetch: w.fetch,
              revealTurn,
            }),
          ),
        )
      await render()
      await act(async () => {})
      scrolled.length = 0
      await render({ turnId: 't1', n: 1 })
      expect(scrolled).toEqual(['t1'])
      await render({ turnId: 't2', n: 2 })
      expect(scrolled).toEqual(['t1', 't2'])
      unmount = async () => {
        await act(async () => root.unmount())
        host.remove()
      }
    })
  })
})

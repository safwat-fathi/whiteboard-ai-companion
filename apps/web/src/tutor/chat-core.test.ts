import { describe, expect, it } from 'vitest'
import {
  type ChatError,
  chipText,
  errorNotice,
  footerText,
  isVerifiedCite,
  parseChatError,
  sourcesOf,
  type TutorMessage,
  textOf,
  toMessage,
} from './chat-core'

const usage = {
  inputTokens: 1200,
  cachedTokens: 400,
  outputTokens: 210,
  costUsd: null,
  model: 'muse-spark-1.3',
}

describe('toMessage', () => {
  it('keeps stored parts in order and appends the stored usage as a data part', () => {
    const m = toMessage({
      id: 'a',
      turnId: 't',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'hi' },
        {
          type: 'data-batch',
          data: {
            batchId: 'b',
            seq: 1,
            label: 'Added',
            bounds: null,
            count: 2,
          },
        },
      ],
      usage,
      createdAt: 1,
    })
    expect(m.parts.map((p) => p.type)).toEqual([
      'text',
      'data-batch',
      'data-usage',
    ])
    expect(textOf(m)).toBe('hi')
  })
})

describe('parseChatError', () => {
  it('reads a refused request (the api.md envelope as the Error text)', () => {
    const e = parseChatError(
      new Error(
        JSON.stringify({
          error: {
            code: 'budget_exceeded',
            message: 'The daily budget is used up.',
            details: { cap: 'daily' },
          },
        }),
      ),
    )
    expect(e).toEqual({
      code: 'budget_exceeded',
      message: 'The daily budget is used up.',
      details: { cap: 'daily' },
    })
  })
  it('reads a mid-stream error text, a network failure and plain text', () => {
    expect(
      parseChatError(
        new Error(
          '{"code":"upstream_error","message":"The AI provider failed to answer. Try again."}',
        ),
      ).code,
    ).toBe('upstream_error')
    expect(parseChatError(new TypeError('Failed to fetch')).code).toBe(
      'network',
    )
    expect(parseChatError(new Error('boom'))).toEqual({
      code: 'error',
      message: 'boom',
    })
  })
  it('words the notices the dock shows', () => {
    const e = (code: string, details?: Record<string, unknown>): ChatError => ({
      code,
      message: 'm',
      details,
    })
    expect(errorNotice(e('turn_busy'))).toMatch(/still working/)
    expect(errorNotice(e('budget_exceeded', { cap: 'daily' }))).toMatch(
      /daily AI budget/,
    )
    expect(errorNotice(e('upstream_error'))).toBe('m')
  })
})

describe('citations', () => {
  const book = 'a'.repeat(64)
  const msg = {
    id: 'x',
    role: 'assistant',
    parts: [
      {
        type: 'data-source',
        data: { bookId: book, pageStart: 40, pageEnd: 44 },
      },
    ],
  } as TutorMessage
  it('only a page the model was shown is verified', () => {
    const s = sourcesOf(msg)
    expect(isVerifiedCite({ bookId: book, page: 40 }, s)).toBe(true)
    expect(isVerifiedCite({ bookId: book, page: 44 }, s)).toBe(true)
    expect(isVerifiedCite({ bookId: book, page: 45 }, s)).toBe(false)
    expect(isVerifiedCite({ bookId: 'b'.repeat(64), page: 41 }, s)).toBe(false)
    expect(isVerifiedCite({ bookId: book, page: 41 }, [])).toBe(false)
  })
})

describe('footer and chips', () => {
  it('shows tokens always and dollars only when priced', () => {
    expect(footerText(usage)).toBe(
      'muse-spark-1.3 · 1,200 in (400 cached) · 210 out',
    )
    expect(
      footerText({
        ...usage,
        cachedTokens: 0,
        costUsd: 0.01234,
        fallback: true,
        unverifiedCites: 2,
      }),
    ).toBe(
      'muse-spark-1.3 · 1,200 in · 210 out · $0.0123 · fallback model · 2 citations could not be verified',
    )
  })
  it('words a chip', () => {
    const b = {
      batchId: 'b',
      seq: 1,
      label: 'Added concept map',
      bounds: null,
      count: 1,
    }
    expect(chipText(b)).toBe('Added concept map · 1 element')
    expect(chipText({ ...b, count: 12 })).toBe(
      'Added concept map · 12 elements',
    )
  })
})

import { describe, expect, it } from 'vitest'
import {
  ChatRequestSchema,
  ContextDescriptorSchema,
  citeHref,
  DataPartSchemas,
  parseCite,
  SettingsSchema,
} from './tutor-wire'

const book = 'a'.repeat(64)

describe('tutor wire', () => {
  it('a bare question is a valid request with an empty context', () => {
    const r = ChatRequestSchema.parse({
      boardId: 'b',
      message: { text: ' hi ' },
    })
    expect(r.message).toEqual({ text: 'hi', images: [] })
    expect(r.context).toMatchObject({
      mode: 'ask',
      selection: [],
      attach: { selection: 'none', viewport: 'none', board: 'none' },
      pictures: [],
    })
  })

  it('rejects an empty or oversize message, too many pictures and a bad mode', () => {
    const msg = (text: string) => ({ boardId: 'b', message: { text } })
    expect(() => ChatRequestSchema.parse(msg('   '))).toThrow()
    expect(() => ChatRequestSchema.parse(msg('x'.repeat(8001)))).toThrow()
    const pic = { blobId: book, of: 'selection' as const }
    expect(() =>
      ContextDescriptorSchema.parse({ pictures: [pic, pic, pic, pic] }),
    ).toThrow()
    expect(() => ContextDescriptorSchema.parse({ mode: 'draw' })).toThrow()
    expect(() =>
      ContextDescriptorSchema.parse({
        pictures: [{ blobId: 'x', of: 'selection' }],
      }),
    ).toThrow()
  })

  it('cite hrefs round trip and only accept a hex book id with a positive page', () => {
    expect(parseCite(citeHref(book, 40))).toEqual({ bookId: book, page: 40 })
    for (const bad of [
      'cite:abc def#1',
      'cite:#1',
      `cite:${book}#0`,
      `cite:${book}#1.5`,
      `cite:${book}`,
      `http://x/${book}#1`,
    ])
      expect(parseCite(bad)).toBeNull()
  })

  it('data parts validate their payloads', () => {
    expect(
      DataPartSchemas.batch.parse({
        batchId: 'x',
        seq: 1,
        label: 'Added',
        bounds: null,
        count: 2,
      }).count,
    ).toBe(2)
    expect(() => DataPartSchemas.status.parse({ state: 'dancing' })).toThrow()
    expect(
      DataPartSchemas.usage.parse({
        inputTokens: 1,
        cachedTokens: 0,
        outputTokens: 2,
        costUsd: null,
        model: 'm',
      }).costUsd,
    ).toBeNull()
  })

  it('settings default to an empty profile and no budget override', () => {
    expect(SettingsSchema.parse({})).toEqual({
      profile: '',
      dailyBudgetUsd: null,
    })
    expect(() => SettingsSchema.parse({ dailyBudgetUsd: -1 })).toThrow()
  })
})

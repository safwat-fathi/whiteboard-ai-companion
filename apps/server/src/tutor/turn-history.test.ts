import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../db'
import { historyOf } from './turn'

const row = (role: 'user' | 'assistant', parts: unknown[]) =>
  ({ role, parts, context: undefined }) as unknown as MessageRow

describe('historyOf', () => {
  it('leaves out an assistant message that said nothing (Stop before any text)', () => {
    const h = historyOf([
      row('user', [{ type: 'text', text: 'hi' }]),
      row('assistant', [{ type: 'data-turn', data: {} }]),
    ])
    expect(h).toEqual([{ role: 'user', content: 'hi' }])
  })
})

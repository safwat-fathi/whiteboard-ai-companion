// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const renderMath = vi.fn(async (latex: string) => ({
  ok: true as const,
  svg: `<svg xmlns="http://www.w3.org/2000/svg"><title>${latex}</title></svg>`,
  width: 2,
  height: 1,
  depth: 0,
}))
vi.mock('@whiteboard/math', () => ({ renderMath }))

import { Markdown } from './Markdown'
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const roots: { unmount(): void }[] = []
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount()
  renderMath.mockClear()
})
const settle = () =>
  act(async () => void (await new Promise((r) => setTimeout(r, 0))))

describe('Markdown while a reply streams', () => {
  it('typesets a formula once, not again for every token that follows it', async () => {
    const root = createRoot(document.createElement('div'))
    roots.push(root)
    const handlers = { isVerified: () => true }
    const show = (text: string) =>
      act(async () =>
        root.render(
          createElement(Markdown, { text, handlers: { ...handlers } }),
        ),
      )
    await show('Here: $x^2$')
    await settle()
    await show('Here: $x^2$ and then')
    await settle()
    await show('Here: $x^2$ and then some more words')
    await settle()
    expect(renderMath).toHaveBeenCalledTimes(1)
  })
})

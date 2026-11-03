// @vitest-environment jsdom
import {
  alignBatch,
  distributeBatch,
  type Element,
  ordered,
} from '@whiteboard/core'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '../editor/editor'
import { mk, put, setup } from '../editor/test-utils'
import { SelectionToolbar } from './SelectionToolbar'

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let ed: Editor
let done: () => void
let unmount: () => Promise<void>
beforeEach(() => {
  ;({ ed, done } = setup())
})
afterEach(async () => {
  await unmount?.()
  done()
})

async function open(...selected: string[]) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  ed.selection.clear()
  for (const id of selected) ed.selection.add(id)
  await act(async () =>
    root.render(
      createElement(SelectionToolbar, { editor: ed, onAsk: () => {} }),
    ),
  )
  await act(async () => {}) // the selection announces itself in a microtask
  unmount = async () => {
    await act(async () => root.unmount())
    host.remove()
  }
}
const btn = (label: string) =>
  document.querySelector(
    `button[aria-label="${label}"]`,
  ) as HTMLButtonElement | null
const click = (label: string) =>
  act(async () => (btn(label) as HTMLButtonElement).click())
const scene = () => ordered(ed.scene)
const els = (...ids: string[]) => ids.map((i) => ed.scene.els.get(i) as Element)
const strip = (b: { ops: unknown[] } | null) => JSON.stringify(b?.ops)

describe('the Arrange menu', () => {
  it('is offered for two or more elements and not for one', async () => {
    put(ed, mk('a', 0, 0), mk('b', 200, 100))
    await open('a')
    expect(btn('Arrange')).toBeNull()
    await unmount()
    await open('a', 'b')
    expect(btn('Arrange')).not.toBeNull()
    expect(btn('Align left')).toBeNull() // closed until asked for
  })

  it('its buttons commit the very batches the builders make', async () => {
    put(ed, mk('a', 10, 100), mk('b', 200, 20), mk('c', 400, 300))
    await open('a', 'b', 'c')
    const commit = vi.spyOn(ed, 'commit')
    await click('Arrange')
    const expectAlign = alignBatch(ed.scene, els('a', 'b', 'c'), 'left')
    await click('Align left')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(strip(commit.mock.calls[0]?.[0] as never)).toBe(strip(expectAlign))
    expect(commit.mock.calls[0]?.[0].label).toBe('Align left')
    expect(btn('Align left')).toBeNull() // the menu closes after a choice
    await click('Arrange')
    const expectDist = distributeBatch(ed.scene, els('a', 'b', 'c'), 'vertical')
    await click('Distribute vertically')
    expect(strip(commit.mock.calls[1]?.[0] as never)).toBe(strip(expectDist))
  })

  it('distribute needs three; Group groups; Ungroup dissolves it', async () => {
    put(ed, mk('a', 0, 0), mk('b', 200, 100))
    await open('a', 'b')
    await click('Arrange')
    expect(btn('Distribute horizontally')?.disabled).toBe(true)
    expect(btn('Ungroup')?.disabled).toBe(true)
    await click('Group')
    const g = scene().find((e) => e.type === 'group') as Element
    expect(g).toBeDefined()
    expect(ed.scene.els.get('a')?.parentId).toBe(g.id)
    await click('Arrange')
    expect(btn('Ungroup')?.disabled).toBe(false)
    await click('Ungroup')
    expect(scene().some((e) => e.type === 'group')).toBe(false)
  })
})

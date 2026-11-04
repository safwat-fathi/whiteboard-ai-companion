import { describe, expect, it } from 'vitest'
import { createQueue } from './queue'

const tick = () => new Promise<void>((r) => setTimeout(r, 5))

describe('createQueue', () => {
  it('runs jobs one at a time, in the order they were added', async () => {
    const log: string[] = []
    let running = 0
    let peak = 0
    const q = createQueue(async (id) => {
      peak = Math.max(peak, ++running)
      log.push(`start ${id}`)
      await tick()
      log.push(`end ${id}`)
      running--
    })
    q.enqueue('a')
    q.enqueue('b')
    q.enqueue('c')
    await q.whenIdle()
    expect(log).toEqual([
      'start a',
      'end a',
      'start b',
      'end b',
      'start c',
      'end c',
    ])
    expect(peak).toBe(1)
  })

  it('reports a failing job and carries on with the next', async () => {
    const seen: string[] = []
    const errors: [string, string][] = []
    const q = createQueue(
      async (id) => {
        if (id === 'bad') throw new Error('boom')
        seen.push(id)
      },
      { onError: (id, e) => errors.push([id, (e as Error).message]) },
    )
    q.enqueue('a')
    q.enqueue('bad')
    q.enqueue('c')
    await q.whenIdle()
    expect(seen).toEqual(['a', 'c'])
    expect(errors).toEqual([['bad', 'boom']])
  })

  it('does not queue a book that is already waiting or running', async () => {
    const runs: string[] = []
    const q = createQueue(async (id) => {
      runs.push(id)
      await tick()
    })
    expect(q.enqueue('a')).toBe(true)
    expect(q.enqueue('a')).toBe(false) // running
    expect(q.enqueue('b')).toBe(true)
    expect(q.enqueue('b')).toBe(false) // waiting
    await q.whenIdle()
    expect(runs).toEqual(['a', 'b'])
    expect(q.enqueue('a')).toBe(true) // finished, so it may be queued again
    await q.whenIdle()
    expect(runs).toEqual(['a', 'b', 'a'])
  })

  it('tells when it has been idle and calls onDone after each job', async () => {
    const done: string[] = []
    const q = createQueue(async () => {}, { onDone: (id) => done.push(id) })
    await q.whenIdle() // nothing queued: resolves at once
    q.enqueue('x')
    expect(q.size()).toBe(1)
    await q.whenIdle()
    expect(q.size()).toBe(0)
    expect(done).toEqual(['x'])
  })

  it('reports a crashed job through onFail and goes on with the next one', async () => {
    const failed: string[] = []
    const ran: string[] = []
    const q = createQueue(
      async (id) => {
        ran.push(id)
        if (id === 'a') throw new Error('ingest worker exited with code 1')
      },
      { onFail: (id, e) => failed.push(`${id}: ${(e as Error).message}`) },
    )
    q.enqueue('a')
    q.enqueue('b')
    await q.whenIdle()
    expect(failed).toEqual(['a: ingest worker exited with code 1'])
    expect(ran).toEqual(['a', 'b'])
  })
})

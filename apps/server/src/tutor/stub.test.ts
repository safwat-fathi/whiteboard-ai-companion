import { isStepCount, streamText, tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type StubFixture, stubModel } from './stub'

const fixtures: StubFixture[] = [
  {
    match: 'photo',
    steps: [
      {
        text: 'Let me draw it.',
        toolCalls: [
          { name: 'add_text', input: { text: 'Page $PAGE_0 of $BOOK' } },
        ],
        usage: { in: 100, cached: 10, out: 20 },
      },
      { text: 'Done, see [p. 3](cite:$BOOK#3).' },
    ],
  },
  {
    match: 'loop',
    steps: [{ toolCalls: [{ name: 'add_text', input: { text: 'again' } }] }],
  },
  { match: '*', steps: [{ text: 'default answer' }] },
]

const runTool = (calls: unknown[]) =>
  tool({
    description: 'add',
    inputSchema: z.object({ text: z.string() }),
    execute: async (i) => {
      calls.push(i)
      return 'ok'
    },
  })

async function run(userText: string, max = 6) {
  const calls: unknown[] = []
  const model = stubModel(fixtures, userText, { BOOK: 'bk"1', PAGE_0: '3' })
  const steps: { text: string; usage: unknown }[] = []
  const r = streamText({
    model,
    prompt: userText,
    tools: { add_text: runTool(calls) },
    stopWhen: isStepCount(max),
    onStepFinish: (s) => void steps.push({ text: s.text, usage: s.usage }),
  })
  await r.consumeStream()
  return { text: await r.text, calls, steps, model }
}

describe('stubModel', () => {
  it('plays the matching fixture: text, a tool call, then the final text, with placeholders filled and escaped', async () => {
    const { calls, steps, model } = await run('Explain PHOTOsynthesis')
    expect(calls).toEqual([{ text: 'Page 3 of bk"1' }])
    expect(steps.map((s) => s.text)).toEqual([
      'Let me draw it.',
      'Done, see [p. 3](cite:bk"1#3).',
    ])
    expect(steps[0]?.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      inputTokenDetails: { cacheReadTokens: 10 },
    })
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('falls back to the * fixture, and to a built-in answer when there is none', async () => {
    expect((await run('something else')).text).toBe('default answer')
    const bare = stubModel([], 'x', {})
    const r = streamText({ model: bare, prompt: 'x' })
    expect(await r.text).toMatch(/stub/i)
  })

  it('repeats its last step, so a one-step tool fixture is a runaway loop that only stopWhen ends', async () => {
    const { calls, steps } = await run('loop forever', 4)
    expect(steps).toHaveLength(4)
    expect(calls).toHaveLength(4)
  })
})

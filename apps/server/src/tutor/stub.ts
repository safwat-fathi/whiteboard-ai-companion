import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'

/** One model call. `toolCalls` make the loop run another step; a step with only text ends it. */
export type StubStep = {
  text?: string
  toolCalls?: { name: string; input: unknown }[]
  usage?: { in?: number; cached?: number; out?: number }
  /** Pause between streamed chunks: lets a spec press Stop mid-answer. */
  chunkDelayMs?: number
}
export type StubFixture = {
  /** Case-insensitive substring of the student's message; `*` matches anything. */
  match: string
  /** The last step repeats once the list runs out, so a single tool-call step is a runaway loop. */
  steps: StubStep[]
}

export function loadFixtures(dir: string): StubFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as
        | StubFixture
        | StubFixture[]
      return Array.isArray(j) ? j : [j]
    })
}

const DEFAULT: StubFixture = {
  match: '*',
  steps: [{ text: 'This is the stub tutor.' }],
}

/** `$NAME` in a step becomes vars.NAME (JSON-escaped), so fixtures can name the book and pages of the turn. */
const fill = (step: StubStep, vars: Record<string, string>): StubStep =>
  JSON.parse(
    JSON.stringify(step).replace(/\$([A-Z][A-Z0-9_]*)/g, (m, k: string) =>
      k in vars ? JSON.stringify(vars[k]).slice(1, -1) : m,
    ),
  ) as StubStep

const words = (t: string) => t.match(/\S+\s*/g) ?? []

/**
 * `TUTOR_STUB=1`: a scripted model in place of the real one. Everything else (loop, tools, board, caps) runs for real.
 * The mock records every request in `doStreamCalls`, which the stub-only test route exposes.
 */
export function stubModel(
  fixtures: StubFixture[],
  userText: string,
  vars: Record<string, string>,
): MockLanguageModelV4 {
  const lower = userText.toLowerCase()
  const fx =
    fixtures.find(
      (f) => f.match !== '*' && lower.includes(f.match.toLowerCase()),
    ) ??
    fixtures.find((f) => f.match === '*') ??
    DEFAULT
  let call = 0
  return new MockLanguageModelV4({
    modelId: 'stub-tutor',
    doStream: async () => {
      const raw = fx.steps[Math.min(call, fx.steps.length - 1)] ?? {}
      const n = call++
      const step = fill(raw, vars)
      const calls = step.toolCalls ?? []
      const chunks = [
        { type: 'stream-start' as const, warnings: [] },
        ...(step.text
          ? [
              { type: 'text-start' as const, id: `t${n}` },
              ...words(step.text).map((delta) => ({
                type: 'text-delta' as const,
                id: `t${n}`,
                delta,
              })),
              { type: 'text-end' as const, id: `t${n}` },
            ]
          : []),
        ...calls.map((c, i) => ({
          type: 'tool-call' as const,
          toolCallId: `c${n}-${i}`,
          toolName: c.name,
          input: JSON.stringify(c.input),
        })),
        {
          type: 'finish' as const,
          finishReason: {
            unified: calls.length ? ('tool-calls' as const) : ('stop' as const),
            raw: undefined,
          },
          usage: {
            inputTokens: {
              total: step.usage?.in ?? 0,
              noCache: (step.usage?.in ?? 0) - (step.usage?.cached ?? 0),
              cacheRead: step.usage?.cached ?? 0,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: step.usage?.out ?? 0,
              text: step.usage?.out ?? 0,
              reasoning: undefined,
            },
          },
        },
      ]
      return {
        stream: simulateReadableStream({
          chunks,
          chunkDelayInMs: step.chunkDelayMs ?? null,
        }),
      }
    },
  })
}

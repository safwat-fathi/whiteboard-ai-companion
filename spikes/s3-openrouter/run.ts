// S3 spike: provider loop checks. Usage: tsx --env-file=../../.env run.ts [--provider meta] --model <id> --test <name>|all
// --provider meta = Meta Llama API (OpenAI-compatible): tokens only, no USD cost, no OpenRouter routing/cache options.
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, tool, isStepCount, type ModelMessage } from 'ai';
import { z } from 'zod';
import { createCanvas } from '@napi-rs/canvas';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const CEILING = 1.5;
const arg = (k: string) => process.argv[process.argv.indexOf(`--${k}`) + 1];
const modelId = arg('model');
const which = arg('test') ?? 'all';
mkdirSync('out', { recursive: true });
const spendFile = 'out/spend.json';
const getSpend = (): number => (existsSync(spendFile) ? JSON.parse(readFileSync(spendFile, 'utf8')).total : 0);
const addSpend = (c: number) => writeFileSync(spendFile, JSON.stringify({ total: getSpend() + c }));

const meta = arg('provider') === 'meta';
const textOnly = meta && !/Llama-4|Vision|muse/i.test(modelId); // Llama-3.3-70B etc. cannot take images
const tok = { in: 0, out: 0 };
let lastToks: { in: number; out: number; cached: number }[] = [];
const mp = createOpenAICompatible({ name: 'meta-llama', baseURL: process.env.META_API_BASE_URL!, apiKey: process.env.META_API_KEY, includeUsage: true });
const or = createOpenRouter({ compatibility: 'strict', appName: 'whiteboard-ai-s3', extraBody: { provider: { data_collection: 'deny' } } });
const lm = (id = modelId) => (meta ? mp(id) : or(id, { usage: { include: true } }));

// PNG containing ZEBRA
const png = (() => {
  const c = createCanvas(600, 300), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 600, 300);
  g.fillStyle = '#000'; g.font = 'bold 120px sans-serif'; g.fillText('ZEBRA', 40, 180);
  return c.toBuffer('image/png').toString('base64');
})();

const tools = {
  add_text: tool({ description: 'Add a text label to the board', inputSchema: z.object({ text: z.string(), x: z.number(), y: z.number() }), execute: async () => ({ ids: ['t1'], bounds: [0, 0, 100, 30] }) }),
  add_shape: tool({ description: 'Add a shape (rect/ellipse) to the board', inputSchema: z.object({ kind: z.enum(['rect', 'ellipse']), x: z.number(), y: z.number(), w: z.number(), h: z.number() }), execute: async () => ({ ids: ['s1'] }) }),
  add_math: tool({ description: 'Add a LaTeX formula to the board', inputSchema: z.object({ latex: z.string(), x: z.number(), y: z.number() }), execute: async () => ({ ids: ['m1'] }) }),
};
const snapTool = (image: boolean) => tool({
  description: 'Get a PNG snapshot of the board',
  inputSchema: z.object({}),
  execute: async () => ({ note: 'snapshot attached' }),
  ...(image ? { toModelOutput: () => ({ type: 'content' as const, value: [{ type: 'text' as const, text: 'snapshot attached' }, { type: 'file' as const, mediaType: 'image/png', data: { type: 'data' as const, data: png } }] }) } : {}),
});

type Run = { text: string; steps: number; calls: number; costs: (number | undefined)[]; toks: { in: number; out: number; cached: number }[]; cost: number; cached: number[]; meta: any };
async function go(opts: { model?: string; system?: string | ModelMessage; prompt?: string; messages?: ModelMessage[]; tools?: any; maxSteps?: number }): Promise<Run> {
  if (!meta && getSpend() > CEILING) throw new Error(`spend ceiling ${CEILING} passed`);
  const costs: (number | undefined)[] = [], toks: { in: number; out: number; cached: number }[] = [], cached: number[] = []; let calls = 0, metaOut: any;
  const r = streamText({
    model: lm(opts.model), instructions: opts.system as any, prompt: opts.prompt, messages: opts.messages, tools: opts.tools,
    stopWhen: isStepCount(opts.maxSteps ?? 6),
    onStepFinish: (s: any) => {
      if (meta) {
        const t = {
          in: s.usage?.inputTokens ?? 0,
          out: s.usage?.outputTokens ?? 0,
          cached: s.usage?.inputTokenDetails?.cacheReadTokens ?? -1,
        };
        toks.push(t);
        tok.in += t.in;
        tok.out += t.out;
        cached.push(t.cached);
        metaOut = s.usage;
      } else {
        const u = s.providerMetadata?.openrouter?.usage; metaOut = s.providerMetadata?.openrouter;
        costs.push(u?.cost); cached.push(u?.promptTokensDetails?.cachedTokens ?? u?.prompt_tokens_details?.cached_tokens ?? -1);
      }
      calls += s.toolCalls?.length ?? 0;
    },
  });
  const text = await r.text; const steps = (await r.steps).length;
  const cost = costs.reduce<number>((a, c) => a + (c ?? 0), 0);
  if (!meta) addSpend(cost);
  lastToks = toks;
  return { text, steps, calls, costs, toks, cost, cached, meta: metaOut };
}
const line = (ok: boolean, t: string, d: string, cost: number) => {
  const metaDetails = `tokens=${tok.in}in/${tok.out}out${lastToks.length > 1 ? ` perStep=${JSON.stringify(lastToks)}` : ''}`;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${t} ${modelId} ${d} ${meta ? metaDetails : `costUsd=${cost.toFixed(5)} spendUsd=${getSpend().toFixed(4)}`}`);
  tok.in = tok.out = 0;
  lastToks = [];
};
const na = (t: string, d?: string) => console.log(`N/A  ${t} ${modelId}${d ? ` ${d}` : ''}`);

const tests: Record<string, () => Promise<void>> = {
  async streamingCost() {
    const r = await go({ prompt: 'Add a text label "hello" at 0,0 using the tool, then say done.', tools: { add_text: tools.add_text } });
    line(r.steps >= 2 && (meta ? r.toks.every((t) => t.in > 0 && t.out > 0) : r.costs.every((c) => typeof c === 'number' && c > 0)), 'streamingCost', `steps=${r.steps} perStep=${JSON.stringify(meta ? r.toks : r.costs)}`, r.cost);
  },
  async toolLoop() {
    const r = await go({ system: 'You are a maths tutor drawing on a whiteboard with the tools. Use tools to draw, then summarise in one sentence.', prompt: 'Explain the quadratic formula on the board with a title, the formula and a box around it.', tools });
    line(r.calls >= 2 && r.text.length > 0, 'toolLoop', `steps=${r.steps} calls=${r.calls} text=${JSON.stringify(r.text.slice(0, 60))}`, r.cost);
  },
  async dataCollection() {
    if (meta) return na('dataCollection');
    const r = await go({ prompt: 'Say OK.' });
    line(r.text.length > 0, 'dataCollection', `provider=${JSON.stringify(r.meta?.provider ?? Object.keys(r.meta ?? {}))}`, r.cost);
  },
  async imageInToolResult() {
    if (textOnly) {
      na('imageInToolResult(a:tool-result)');
      na('imageInToolResult(b:follow-up-user)');
      return;
    }
    const a = await go({ prompt: 'Call get_snapshot, then tell me the single word written in the picture.', tools: { get_snapshot: snapTool(true) } }).catch((e) => ({ text: `ERR ${e.message}`, cost: 0, steps: 0, calls: 0, costs: [], toks: [], cached: [], meta: null } as Run));
    line(/zebra/i.test(a.text), 'imageInToolResult(a:tool-result)', JSON.stringify(a.text.slice(0, 60)), a.cost);
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'Call get_snapshot, then tell me the single word written in the picture.' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'get_snapshot', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'get_snapshot', output: { type: 'text', value: 'snapshot attached below' } }] },
      { role: 'user', content: [{ type: 'text', text: 'Snapshot of the board:' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: png } }] },
    ];
    const b = await go({ messages: msgs, tools: { get_snapshot: snapTool(false) } }).catch((e) => ({ text: `ERR ${e.message}`, cost: 0, steps: 0, calls: 0, costs: [], toks: [], cached: [], meta: null } as Run));
    line(/zebra/i.test(b.text), 'imageInToolResult(b:follow-up-user)', JSON.stringify(b.text.slice(0, 60)), b.cost);
  },
  async arabic() {
    const ps = ['اشرح لي نظرية فيثاغورس بإيجاز مع مثال.', 'ما الفرق بين المشتقة والتكامل؟ اشرح بجملتين لكل منهما.', 'اكتب معادلة الدرجة الثانية وحلها بالصيغة العامة: س² - 5س + 6 = 0'];
    let out = '', total = 0;
    for (const p of ps) { const r = await go({ prompt: p, system: process.env.RULES ? 'Answer entirely in the language of the user (no English words in an Arabic answer). Write all math as LaTeX with $...$ for inline and $$...$$ for display; never use \\( \\) or \\[ \\].' : undefined }); out += `## ${p}\n\n${r.text}\n\n`; total += r.cost; }
    writeFileSync(`out/arabic-${modelId.replace('/', '_')}${process.env.RULES ? '-rules' : ''}.md`, out);
    line(out.length > 200, 'arabic', `saved out/arabic-${modelId.replace('/', '_')}${process.env.RULES ? '-rules' : ''}.md (rate 1-5)`, total);
  },
  async cheap() {
    const text = readFileSync('../../docs/plans/rag-context-engineering.md', 'utf8').slice(0, 6000);
    const r = await go({ prompt: `Summarise this page in 150-400 tokens:\n\n${text}` });
    line(r.text.length > 100, 'cheap', `chars=${r.text.length}`, r.cost);
  },
  async cache() {
    const filler = Array.from({ length: 700 }, (_, i) => `Fact ${i}: the value of item ${i * 7919 % 10007} in table ${i % 13} is ${(i * 31337) % 99991}.`).join('\n');
    const sys = { role: 'system' as const, content: `You answer briefly.\n${filler}`, ...(meta ? {} : { providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } } }) };
    const t1 = await go({ system: sys, messages: [{ role: 'user', content: 'What is Fact 3? One line.' }] });
    await new Promise((r) => setTimeout(r, 5000));
    const t2 = await go({ system: sys, messages: [{ role: 'user', content: 'What is Fact 4? One line.' }] });
    if (meta) {
      const hit = t2.cached[0] > 0;
      if (hit) {
        line(true, 'cache', `cachedTokens turn1=${t1.cached[0]} turn2=${t2.cached[0]}`, 0);
      } else {
        na('cache', `not reported (turn1=${t1.cached[0]} turn2=${t2.cached[0]})`);
      }
    } else {
      line(t2.cached[0] > 0, 'cache', `cachedTokens turn1=${t1.cached[0]} turn2=${t2.cached[0]}`, t1.cost + t2.cost);
    }
    console.log('usage meta', JSON.stringify(meta ? t2.meta : t2.meta?.usage));
  },
  async cache1h() {
    if (meta) return na('cache1h');
    const filler = Array.from({ length: 700 }, (_, i) => `Fact ${i}: the value of item ${i * 7919 % 10007} in table ${i % 13} is ${(i * 31337) % 99991} (1h).`).join('\n');
    const sys = { role: 'system' as const, content: `You answer briefly.\n${filler}`, providerOptions: { openrouter: { cacheControl: { type: 'ephemeral', ttl: '1h' } } } };
    const t1 = await go({ system: sys, messages: [{ role: 'user', content: 'What is Fact 3? One line.' }] });
    console.log('waiting 6 min'); await new Promise((r) => setTimeout(r, 6 * 60_000));
    const t3 = await go({ system: sys, messages: [{ role: 'user', content: 'What is Fact 5? One line.' }] });
    line(t3.cached[0] > 0, 'cache1h', `cachedTokens turn1=${t1.cached[0]} after6min=${t3.cached[0]}`, t1.cost + t3.cost);
  },
};

const order = ['streamingCost', 'toolLoop', 'dataCollection', 'imageInToolResult', 'arabic', 'cheap', 'cache'];
for (const t of which === 'all' ? order : [which]) {
  try { await tests[t](); } catch (e: any) { console.log(`FAIL ${t} ${modelId} ERROR ${String(e.message).slice(0, 300)} ${meta ? `tokens=${tok.in}in/${tok.out}out` : `spendUsd=${getSpend().toFixed(4)}`}`); tok.in = tok.out = 0; lastToks = []; }
}

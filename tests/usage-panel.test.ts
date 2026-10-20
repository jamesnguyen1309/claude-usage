import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { importNote } from '../hooks/context'

const PANE = { plugin: 'usage-panel', component: 'Pane', requestId: 'usage-panel' } as const
const paneProps = { title: 'Usage', isFocused: false, bodyColumns: 100, placement: 'dock' } as never
const BAND = { plugin: 'usage-panel', component: 'AbovePrompt', requestId: 'above-prompt' } as const
const bandProps = { hasSurvey: false, isWorking: true, maxRows: 3, bodyColumns: 120 } as never
const COMPOSER = { kind: 'composer' } as const

// The engine's answers beneath the plugin: a main loop on Opus, subagents on Haiku.
function engine(on: On) {
  mock.clock(on)
  mock.store(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  on('agent.spawn', async (_$, e) => ({ model: 'claude-haiku-5-5', agentId: e.description === 'Find files' ? 'a1' : 'a2' }))
  on('turn.step', async function* (_$, e) {
    const isAgent = Boolean(e.agentId)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: isAgent ? 'claude-haiku-5-5' : 'claude-opus-5-5',
        input_tokens: isAgent ? 100 : 1000,
        output_tokens: isAgent ? 50 : 500,
        cache_read_input_tokens: isAgent ? 0 : 20000,
        cache_creation_input_tokens: 0,
      },
    } as never
  })
}

type Found = { key?: string; text?: string; props: Record<string, unknown> }

// An Svg carries no key: it is found by what its alt text says.
const svgProps = async (ui: { findAll: (q: object) => Promise<Found[]> }, alt: RegExp) =>
  (await ui.findAll({ type: 'Svg' })).map(x => x.props as { alt: string; source: string }).find(p => alt.test(p.alt))

test('a prompt lists the subagents it started, nested, with their status', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'Plan the AWS deploy', turnId: 't1' })
  await $.agent.spawn({ tool_use_id: 'u1', prompt: 'p', description: 'Find files', subagentType: 'Explore' } as never)
  await $.agent.spawn({ tool_use_id: 'u2', prompt: 'p', description: 'Check prices', subagentType: 'general-purpose', parentAgentId: 'a1' } as never)
  await $.turn.complete({ turnId: 'r1', agentId: 'a2', reason: 'answer', isAborted: false, answer: '' } as never)

  const term = await $.ui.mount({ ...PANE, surface: 'terminal', props: paneProps })
  expect(await term.find({ type: 'Text', text: /Plan the AWS deploy/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /Subagents · 2/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /Find files/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /Check prices/ })).toBeDefined()
  await term.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop', props: paneProps })
  expect(await desk.find({ type: 'Text', text: /Subagents · 2 \(1 running\)/ })).toBeDefined()
  expect(await svgProps(desk, /^Find files: Explore, Haiku 5\.5, running/)).toBeDefined()
  expect(await svgProps(desk, /^Check prices: general-purpose, Haiku 5\.5, done/)).toBeDefined()
  expect(await svgProps(desk, /^Working on: Plan the AWS deploy/)).toBeDefined()
  await desk.unmount()
})

test('the prompt totals tokens over the main loop and its subagents, by model', async ($, on) => {
  engine(on)
  const step = async (e: object) => {
    for await (const _ of $.turn.step({ messageCount: 1, ...e } as never)) void _
  }
  await $.session.append({ uuid: 'u1', door: 'prompt', origin: COMPOSER, message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'Count my tokens' }] } } as never)
  await $.turn.start({ text: 'Count my tokens', turnId: 't1' })
  await step({ turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  await $.agent.spawn({ tool_use_id: 'u1', prompt: 'p', description: 'Find files', subagentType: 'Explore' } as never)
  await step({ turnId: 'r1', index: 0, model: 'claude-haiku-5-5', agentId: 'a1' })
  await step({ turnId: 'r1', index: 1, model: 'claude-haiku-5-5', agentId: 'a1' })

  // 21,500 on main + 2 × 150 in the subagent
  const term = await $.ui.mount({ ...PANE, surface: 'terminal', props: paneProps })
  expect(await term.find({ type: 'Text', text: /Tokens 22k/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /Opus 5\.5 claude-opus-5-5 · main · 1 calls · 22k tok/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /Haiku 5\.5 claude-haiku-5-5 · 1 subagent · 2 calls · 300 tok/ })).toBeDefined()
  await term.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop', props: paneProps })
  const card = await svgProps(desk, /^Working on: Count my tokens/)
  expect(card?.alt).toMatch(/22k tokens \(in 1k, out 600, cache read 20k, cache write 0\)/)
  expect(card?.alt).toMatch(/Opus 5\.5 \(claude-opus-5-5\) main 22k; Haiku 5\.5 \(claude-haiku-5-5\) 1 subagent 300/)
  expect(card?.source).toMatch(/^<svg /)
  // The count and its label share one <text>, so a wide number never runs into "tokens".
  expect(card?.source).toMatch(/<text [^>]*><tspan [^>]*>22k<\/tspan><tspan dx="7"[^>]*>tokens<\/tspan><\/text>/)
  // Claude at work: the running mark is the animated crab, not a dot.
  expect(card?.source).toMatch(/<g class="crab">/)
  await desk.unmount()
})

test('the band above the prompt shows the prompt’s tokens and model id', async ($, on) => {
  engine(on)
  // Another plugin's row beneath this one in the shared band.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'beneath' }, 'beneath') as never
  })
  await $.turn.start({ text: 'Count my tokens', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) void _

  const term = await $.ui.mount({ ...BAND, surface: 'terminal', props: bandProps })
  expect(await term.find({ type: 'Text', text: /claude-opus-5-5/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /22k tokens/ })).toBeDefined()
  expect(await term.find({ text: 'beneath' })).toBeDefined()
  await term.unmount()

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop', props: bandProps })
  const band = await svgProps(desk, /claude-opus-5-5/)
  expect(band?.alt).toMatch(/^claude-opus-5-5: 22k tokens \(500 out\)/)
  expect(band?.source).toMatch(/claude-opus-5-5/)
  expect(band?.source).toMatch(/<text [^>]*text-anchor="end"><tspan [^>]*>22k<\/tspan><tspan dx="5"[^>]*>tokens<\/tspan>/)
  expect(await desk.find({ type: 'Button', key: 'usage-open' })).toBeDefined()
  expect(await desk.find({ text: 'beneath' })).toBeDefined()
  await desk.unmount()
})

test('the statistics show when tokens reload and every model and tool call', async ($, on) => {
  const start = Date.parse('2026-10-18T10:00:00Z')
  mock.clock(on, { now: start })
  mock.store(on)
  on('session.measure', async () => ({ changed: [] }) as never)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  // Main-loop calls ask for one tool each; the subagent's ask for none.
  on('turn.step', async function* (_$, e) {
    const isAgent = Boolean(e.agentId)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: isAgent ? [] : [{ id: `tool-${e.turnId}`, name: 'Read', input: {} }],
      stopReason: 'end_turn',
      usage: {
        model: isAgent ? 'claude-haiku-5-5' : 'claude-opus-5-5',
        input_tokens: isAgent ? 100 : 1000,
        output_tokens: isAgent ? 50 : 500,
        cache_read_input_tokens: isAgent ? 0 : 20000,
        cache_creation_input_tokens: 0,
      },
    } as never
  })
  const step = async (e: object) => {
    for await (const _ of $.turn.step({ messageCount: 1, ...e } as never)) void _
  }
  const send = (uuid: string, text: string) =>
    $.session.append({ uuid, door: 'prompt', origin: COMPOSER, message: { type: 'user', role: 'user', content: [{ type: 'text', text }] } } as never)

  await $.session.measure({
    context: { tokens: 50_000, window: 200_000, percent: 25 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-22T09:00:00Z' },
      { kind: 'five_hour', percentUsed: 62, resetsAt: '2026-10-18T12:14:00Z' },
    ],
    cost: { usd: 1.25 },
  } as never)

  await send('u1', 'First prompt')
  await $.turn.start({ text: 'First prompt', turnId: 't1' })
  await step({ turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  await $.agent.spawn({ tool_use_id: 'x1', prompt: 'p', description: 'Look around', subagentType: 'Explore' } as never)
  await step({ turnId: 'r1', index: 0, model: 'claude-haiku-5-5', agentId: 'a1' })
  await step({ turnId: 'r1', index: 1, model: 'claude-haiku-5-5', agentId: 'a1' })
  await send('u2', 'Second prompt')
  await $.turn.start({ text: 'Second prompt', turnId: 't2' })
  await step({ turnId: 't2', index: 0, model: 'claude-opus-5-5' })

  // The 5-hour window resets first: 2h 14m away. 2 main calls + 2 subagent calls; a tool per main call.
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop', props: paneProps })
  const tiles = await svgProps(desk, /^Tokens reload in /)
  expect(tiles?.alt).toMatch(/^Tokens reload in 2h 14m \(5-hour · \d\d:\d\d\), Model calls 4, Tool calls 2, Prompts sent 2, Session cost \$1\.25/)
  expect(tiles?.alt).toMatch(/7-day limit 40% \(resets \w{3} \d\d:\d\d\)/)
  // The conversation card is gone, and the prompt card shows figures, not a bar.
  expect(await svgProps(desk, /^This conversation: /)).toBeUndefined()
  const card = await svgProps(desk, /^Working on: Second prompt/)
  expect(card?.source).not.toMatch(/clip-path/)
  expect(card?.source).toMatch(/cache hit/)
  await desk.unmount()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal', props: paneProps })
  expect(await term.find({ type: 'Text', text: /^  Tokens reload in 2h 14m · 5-hour limit · \d\d:\d\d$/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /^  4 model calls · 2 tool calls · 2 prompts$/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /This conversation/ })).toBeUndefined()
  await term.unmount()
})

test('the burn rate reads each window’s pace and forecasts where it ends', async ($, on) => {
  const start = Date.parse('2026-10-18T10:00:00Z')
  const clock = mock.clock(on, { now: start })
  mock.store(on)
  on('session.measure', async () => ({ changed: [] }) as never)
  const measure = (fiveHour: number) =>
    $.session.measure({
      context: { tokens: 1000, window: 200_000, percent: 1 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: fiveHour, resetsAt: '2026-10-18T13:00:00Z' },
        { kind: 'seven_day', percentUsed: 30, resetsAt: '2026-10-22T09:00:00Z' },
      ],
      changed: ['rateLimits'],
    } as never)
  const burn = async (surface: 'desktop' | 'terminal') => {
    const ui = await $.ui.mount({ ...PANE, surface, props: paneProps })
    const found = surface === 'desktop' ? (await svgProps(ui, /^5-hour limit: /))?.alt : (await ui.find({ type: 'Text', text: /^  5-hour +(\d|measuring)/ }))?.text
    await ui.unmount()
    return found
  }

  // One reading: too soon to tell.
  await measure(20)
  expect(await burn('desktop')).toMatch(/measuring…/)

  // 20% → 50% in an hour, 2h from the reload: at 30% an hour it runs out 20 minutes early.
  await clock.advance(30 * 60_000)
  await measure(35)
  await clock.advance(30 * 60_000)
  await measure(50)
  expect(await burn('desktop')).toMatch(/^5-hour limit: 50% used, 30% \/ hour\. Hits 100% at \d\d:\d\d, 20m before it reloads$/)
  expect(await burn('terminal')).toMatch(/30%\/hour · hits 100% at \d\d:\d\d, 20m before reload$/)

  // An idle hour: no rise over the lookback, so it stays put.
  await clock.advance(60 * 60_000)
  await measure(50)
  expect(await burn('desktop')).toMatch(/No use lately: stays at 50% until it reloads \d\d:\d\d$/)

  // A slower pace that lasts to the reload: 50% → 55% over 75 minutes, 45 left: 58% at the reload.
  await clock.advance(15 * 60_000)
  await measure(55)
  expect(await burn('desktop')).toMatch(/4\.0% \/ hour\. On pace for 58% when it reloads \d\d:\d\d$/)

  // The 7-day window has one reading: still measuring.
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop', props: paneProps })
  expect((await svgProps(desk, /^7-day limit: /))?.alt).toMatch(/measuring…/)
  await desk.unmount()
})

test('the context section exports the conversation and imports an export back in', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-18T09:41:00Z') })
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  const session = mock.session(on)
  // A small disk, and the session beneath the plugin.
  const disk = new Map<string, { text: string; mtimeMs: number }>()
  const value = <T,>(v: T) => ({ value: v }) as never
  on('fs.write', async (_$, e) => (disk.set(e.path, { text: e.text, mtimeMs: disk.size + 1 }), value(undefined)))
  on('fs.read', async (_$, e) => value(disk.get(e.path)?.text ?? ''))
  on('fs.exists', async (_$, e) => value([...disk.keys()].some(k => k === e.path || k.startsWith(`${e.path}/`))))
  on('fs.list', async (_$, e) =>
    value([...disk].filter(([k]) => k.startsWith(`${e.path}/`)).map(([k, v]) => ({ name: k.slice(e.path.length + 1), kind: 'file', size: v.text.length, mtimeMs: v.mtimeMs, isLink: false }))),
  )
  on('session.root', async () => value('/work/my-app'))
  on('session.id', async () => value('sess-1'))
  on('session.model', async () => value('claude-opus-5-5'))
  on('session.usage', async () => value({ startedAt: 0, context: { tokens: 20_000, window: 200_000, percent: 10 }, rateLimits: [] }))
  on('session.messages', async () =>
    value([
      { role: 'user', text: 'Add a login page', toolUses: [] },
      { role: 'assistant', text: 'Reading the router first.', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'src/routes.ts' }, text: 'export const routes = []' }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'export const routes = []' }] },
      { role: 'assistant', text: 'Done: /login added.', toolUses: [] },
    ]),
  )

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: paneProps })
  expect(await ui.find({ type: 'Text', text: /^No exports yet/ })).toBeDefined()

  await ui.press({ key: 'context-export' })
  const [path, file] = [...disk][0] ?? []
  expect(path).toBe('/home/me/.claude/context-exports/work-my-app/context-2026-10-18T09-41-00Z.md')
  expect(file?.text).toMatch(/^# Context export\n/)
  expect(file?.text).toMatch(/## User\n\nAdd a login page\n\n## Claude\n\nReading the router first\.\n\n\*\*Tool: Read\*\*\n\n```\n\{\n  "file_path": "src\/routes\.ts"\n\}\n```\n\nResult:\n\n```\nexport const routes = \[\]\n```\n\n## Claude\n\nDone: \/login added\./)
  expect(await ui.find({ type: 'Text', text: /^Exported 4 messages, ≈\d+ tokens, to \/home\/me\// })).toBeDefined()

  await ui.press({ key: 'import:context-2026-10-18T09-41-00Z.md' })
  const rows = session.appended()
  const note = rows.at(-1)?.message.content[0] as { type: string; text: string } | undefined
  expect(note?.text).toMatch(/^<imported-context source="context-2026-10-18T09-41-00Z\.md">\n/)
  expect(note?.text).toMatch(/Done: \/login added\.\n<\/imported-context>$/)
  expect(await ui.find({ type: 'Text', text: /^Imported context-2026-10-18T09-41-00Z\.md, ≈\d+ tokens\. Claude reads it with your next prompt\.$/ })).toBeDefined()
  await ui.unmount()
})

test('an import too big for the context window keeps its newest part', async () => {
  const file = ['# Context export', '', '## User', '', 'old '.repeat(4000), '## Claude', '', 'newest answer'].join('\n')
  const note = importNote(file, 'x.md', 1000)
  expect(note.isCut).toBe(true)
  expect(note.text).toMatch(/truncated=/)
  expect(note.text).toMatch(/## Claude\n\nnewest answer/)
  expect(note.text).not.toMatch(/^## User/m)
})

test('the strip names the main conversation’s model, not a subagent’s or a side call’s', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  // Each step answers on the model it names.
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as never
  })
  const step = async (e: object) => {
    for await (const _ of $.turn.step({ messageCount: 1, ...e } as never)) void _
  }
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'beneath' }, '') as never
  })
  await $.turn.start({ text: 'Plan and build it', turnId: 't1' })
  // A subagent on Haiku is the first model seen; the main loop runs on Opus; the turn ends with
  // a small side call on Haiku in the main loop.
  await $.agent.spawn({ tool_use_id: 'x1', prompt: 'p', description: 'Plan', subagentType: 'Plan' } as never)
  await step({ turnId: 'r1', index: 0, model: 'claude-haiku-5-5', agentId: 'a1' })
  await step({ turnId: 't1', index: 0, model: 'claude-opus-5-5' })
  await step({ turnId: 't1', index: 1, model: 'claude-opus-5-5' })
  await step({ turnId: 't1', index: 2, model: 'claude-haiku-5-5' })

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop', props: bandProps })
  const band = await svgProps(desk, /claude-opus-5-5|claude-haiku-5-5/)
  expect(band?.alt).toMatch(/^claude-opus-5-5 \+ Haiku 5\.5: /)
  expect(band?.source).toMatch(/>Opus 5\.5</)
  await desk.unmount()
  const term = await $.ui.mount({ ...BAND, surface: 'terminal', props: bandProps })
  expect(await term.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
  await term.unmount()
})

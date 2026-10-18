import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = { plugin: 'usage-panel', component: 'Pane', requestId: 'usage-panel' } as const
const paneProps = { title: 'Usage', isFocused: false, bodyColumns: 100, placement: 'dock' } as never
const BAND = { plugin: 'usage-panel', component: 'AbovePrompt', requestId: 'above-prompt' } as const
const bandProps = { hasSurvey: false, isWorking: true, maxRows: 3, bodyColumns: 120 } as never
const COMPOSER = { kind: 'composer' } as const

// The engine's answers beneath the plugin: a main loop on Opus, subagents on Haiku.
function engine(on: On) {
  mock.clock(on)
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

// A prompt record is three lines (Boxes line:<id>, line:<id>:prompt, line:<id>:done): the
// records in order, and one record's lines joined.
const recordIds = async (ui: { findAll: (q: object) => Promise<Found[]> }) =>
  (await ui.findAll({ type: 'Box' })).map(b => b.key ?? '').filter(k => /^line:[^:]+$/.test(k))
const recordText = async (ui: { find: (q: object) => Promise<Found | undefined> }, id: string) =>
  (await Promise.all(['', ':prompt', ':done'].map(async s => (await ui.find({ type: 'Box', key: `line:${id}${s}` }))?.text ?? '?'))).join('\n')
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
  // Its record's last line, drawn like the counter: status, a pill per model, the tokens; no bar.
  const recordLine = await svgProps(desk, /^Running 0s · Opus 5\.5, Haiku 5\.5 · 22k tokens$/)
  expect(recordLine).toBeDefined()
  expect(recordLine?.source).not.toMatch(/class="track"|clip-path/)
  await desk.unmount()
  const listed = await $.ui.mount({ ...PANE, surface: 'terminal', props: paneProps })
  expect(await recordText(listed, 'u1')).toMatch(/\nCount my tokens\nRunning 0s  ·  Opus 5\.5, Haiku 5\.5  ·  22k tokens$/)
  await listed.unmount()
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

test('every prompt of the session is listed once, newest first, with when it was sent and done', async ($, on) => {
  const clock = mock.clock(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  // The engine's own drawing of a conversation row.
  on('ui.render', { component: 'UserMessage' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, e.props.text)
  })
  const append = (uuid: string, text: string, origin: object = COMPOSER) =>
    $.session.append({ uuid, door: 'prompt', origin, message: { type: 'user', role: 'user', content: [{ type: 'text', text }] } } as never)

  await append('u1', 'First prompt')
  await $.turn.start({ text: 'First prompt', turnId: 't1' })
  await clock.advance(65_000)
  await $.turn.complete({ turnId: 't1', reason: 'answer', isAborted: false, answer: '' } as never)
  await append('u2', 'Second prompt')
  // A notification is not one of your prompts.
  await append('n1', 'agent done', { kind: 'task-notification' })

  // Your prompt's row keeps the engine's drawing; the mod only notes the id it is drawn under.
  const row = await $.ui.mount({
    plugin: 'usage-panel',
    surface: 'desktop',
    component: 'UserMessage',
    requestId: 'u1',
    props: { text: 'First prompt', origin: COMPOSER, isExpanded: false } as never,
  })
  expect(((await row.drawn()) as { type: string }).type).toBe('Text')
  await row.unmount()
  // A prompt from before the mod loaded: known only from its drawn row.
  const old = await $.ui.mount({
    plugin: 'usage-panel',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'm0',
    props: { text: 'Prompt from before', origin: COMPOSER, isExpanded: false } as never,
  })
  await old.unmount()
  // Drawn rows are saved on the next event (or the ticker): here, the next prompt's turn.
  await $.turn.start({ text: 'Second prompt', turnId: 't2' })

  // Newest first, three lines each: number and sent time; the prompt; done time, models, tokens.
  const term = await $.ui.mount({ ...PANE, surface: 'terminal', props: paneProps })
  expect(await term.find({ type: 'Button', text: /Prompts in this session · 3/ })).toBeDefined()
  expect(await recordIds(term)).toEqual(['line:u2', 'line:u1', 'line:m0'])
  expect(await recordText(term, 'u2')).toMatch(/^#3  ·  Sent \d\d:\d\d:\d\d\nSecond prompt\nRunning 0s  ·  no model yet  ·  0 tokens$/)
  expect(await recordText(term, 'u1')).toMatch(/^#2  ·  Sent \d\d:\d\d:\d\d\nFirst prompt\nDone \d\d:\d\d:\d\d · 1m 05s  ·  no model yet  ·  0 tokens$/)
  expect(await recordText(term, 'm0')).toBe('#1  ·  Sent before the panel was watching\nPrompt from before\nNo figures: sent before the panel was watching')
  await term.unmount()

  // On the desktop: cards a blank row apart that tint on hover, the newest outlined; the running
  // one has the crab. They only show: nothing in the list is a button but its own controls.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: paneProps })
  const cards = (await ui.findAll({ type: 'Box' })).filter(b => b.props.borderStyle === 'round')
  expect(cards.map(c => c.props.borderColor)).toEqual(['claude', 'subtle', 'subtle'])
  expect(cards.every(c => c.props.height === 5 && c.props.marginTop === 1 && c.props.alignItems === 'flex-start')).toBe(true)
  // Each card's mark sits at its top left, not centred on its lines.
  const marks = (await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('mark:'))
  expect(marks.map(m => [m.key, m.props.alignSelf])).toEqual([['mark:u2', 'flex-start'], ['mark:u1', 'flex-start'], ['mark:m0', 'flex-start']])
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['list-toggle'])
  const tree = JSON.stringify(await ui.drawn())
  for (const id of ['u2', 'u1', 'm0']) {
    expect(tree).toMatch(new RegExp(`"key":"card:${id}"[^}]*\\},"hover":\\{"borderColor":"claude","backgroundColor":"#8080802a"\\}`))
  }
  // Claude marks the running prompt (walking) and the finished one (cheering); a prompt with no
  // figures keeps a grey dot.
  expect(await svgProps(ui, /^Claude at work$/)).toBeDefined()
  const cheering = await svgProps(ui, /^Completed$/)
  expect(cheering?.source).not.toMatch(/class="crab"/)
  const dots = (await ui.findAll({ type: 'Text' })).filter(x => x.text === '●')
  expect(dots.map(d => d.props.color)).toEqual(['inactive'])
  expect(await svgProps(ui, /^Working on: Second prompt/)).toBeDefined()

  await ui.unmount()
})

test('the prompt list keeps a fixed height and scrolls inside, by wheel or ▲ ▼', async ($, on) => {
  mock.clock(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  // The engine's own scrolling of the pane, beneath the mod.
  const paneMoves: number[] = []
  on('ui.scroll', async (_$, e) => {
    paneMoves.push(e.by)
    return {}
  })
  for (let i = 1; i <= 7; i++) {
    await $.session.append({ uuid: `p${i}`, door: 'prompt', origin: COMPOSER, message: { type: 'user', role: 'user', content: [{ type: 'text', text: `Prompt ${i}` }] } } as never)
  }
  const shown = async () => (await recordIds(ui)).map(k => k.slice('line:'.length))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: paneProps })
  const list = (await ui.findAll({ type: 'Box' })).find(b => b.key === 'prompt-list')
  expect(list?.props.height).toBe(25)
  expect(await shown()).toEqual(['p7', 'p6', 'p5', 'p4'])
  expect(await ui.find({ type: 'Text', text: '1–4 of 7' })).toBeDefined()

  // A wheel tick over the list (its rows are the pane's last 25) moves the list a card, not the pane.
  const tick = (by: number, row: number) =>
    $.ui.scroll({ component: 'Pane', requestId: 'usage-panel', offset: 10 + by, by, bodyRows: 30, contentRows: 60, origin: { kind: 'person' }, pointer: { row, column: 4 } } as never)
  await tick(1, 45) // tree row 55: in the list
  expect(await shown()).toEqual(['p6', 'p5', 'p4', 'p3'])
  expect(paneMoves).toEqual([])
  await tick(1, 5) // tree row 15: above the list, so the pane scrolls
  expect(paneMoves).toEqual([1])
  expect(await shown()).toEqual(['p6', 'p5', 'p4', 'p3'])

  // ▼ pages to the oldest, ▲ back to the newest.
  await ui.press({ key: 'list-older' })
  expect(await shown()).toEqual(['p4', 'p3', 'p2', 'p1'])
  await ui.press({ key: 'list-newer' })
  expect(await shown()).toEqual(['p7', 'p6', 'p5', 'p4'])
  await ui.unmount()
})

test('the statistics show when tokens reload and every model and tool call', async ($, on) => {
  const start = Date.parse('2026-10-18T10:00:00Z')
  mock.clock(on, { now: start })
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

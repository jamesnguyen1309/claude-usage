import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, Register, SessionUsage, SvgProps, TurnUsage } from 'claude-code'

import type { AgentRun, ConversationTotals, ModelUse, PromptRow, PromptRun, RunStatus, SessionFigures, Tokens } from '../types'
import {
  agentRow,
  bandRow,
  cacheHit,
  crabDoneIcon,
  crabIcon,
  fmtResetAt,
  fmtTime,
  fmtTokens,
  fmtUntil,
  fmtUsd,
  limitName,
  modelName,
  nextReset,
  PARTS,
  modelColor,
  promptCard,
  recordMeta,
  sessionTiles,
  total,
  whereOf,
} from './draw'

const PANE = 'usage-panel'
const TITLE = 'Usage'
const KEEP = 50

const prompts = atom({ plugin: 'usage-panel', key: 'prompts' } as const, [])
const session = atom({ plugin: 'usage-panel', key: 'session' } as const, {
  costUsd: 0,
  contextWindow: 0,
  rateLimits: [],
})
const rows = atom({ plugin: 'usage-panel', key: 'rows' } as const, [])
const listStart = atom({ plugin: 'usage-panel', key: 'listStart' } as const, 0)
const totals = atom({ plugin: 'usage-panel', key: 'totals' } as const, null as ConversationTotals | null)

// The prompt list is the pane's last section, a fixed window: its header, then PAGE cards of
// CARD_ROWS rows (a border and three lines), each after a blank row. A wheel over it scrolls it.
const PAGE = 4
const CARD_ROWS = 5
const GAP_ROWS = 1
const LIST_ROWS = 1 + PAGE * (GAP_ROWS + CARD_ROWS)
const CRAB = crabIcon(16)
const CRAB_DONE = crabDoneIcon(16)
const isListOpen = atom({ plugin: 'usage-panel', key: 'isListOpen' } as const, true)
const now = atom({ plugin: 'usage-panel', key: 'now' } as const, 0)

// ---- bookkeeping ------------------------------------------------------------------

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

const add = (t: Tokens, u: TurnUsage): Tokens => ({
  input: t.input + (u.input_tokens || 0),
  output: t.output + (u.output_tokens || 0),
  cacheRead: t.cacheRead + (u.cache_read_input_tokens || 0),
  cacheWrite: t.cacheWrite + (u.cache_creation_input_tokens || 0),
})

const sum = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

/** The prompt's tokens: its main loop and every subagent. */
const promptTokens = (p: PromptRun): Tokens => p.agents.reduce((t, a) => sum(t, a.tokens), p.tokens)

// The conversation's totals before this mod counted them itself: what its prompts hold.
const seedTotals = (list: PromptRun[]): ConversationTotals => ({
  modelCalls: list.reduce((n, p) => n + p.calls + p.agents.reduce((m, a) => m + a.calls, 0), 0),
  toolCalls: list.reduce((n, p) => n + p.tools + p.agents.reduce((m, a) => m + a.tools, 0), 0),
  tokens: list.reduce((t, p) => sum(t, promptTokens(p)), zero()),
})

// Credits one model call to its model in the prompt's breakdown.
const useModel = (models: ModelUse[], model: string, usage: TurnUsage | null, agentId?: string): ModelUse[] => {
  if (!model) return models
  const one = models.find(m => m.model === model) ?? { model, mainCalls: 0, agentCalls: 0, agentIds: [], tokens: zero() }
  const next: ModelUse = {
    ...one,
    mainCalls: one.mainCalls + (agentId ? 0 : 1),
    agentCalls: one.agentCalls + (agentId ? 1 : 0),
    agentIds: agentId && !one.agentIds.includes(agentId) ? [...one.agentIds, agentId] : one.agentIds,
    tokens: usage ? add(one.tokens, usage) : one.tokens,
  }
  return models.some(m => m.model === model) ? models.map(m => (m.model === model ? next : m)) : [...models, next]
}

const figures = (u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): SessionFigures => ({
  costUsd: u.cost?.usd ?? 0,
  contextTokens: u.context.tokens,
  contextWindow: u.context.window,
  contextPercent: u.context.percent,
  rateLimits: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
})

// Subagents are filed under the prompt that was running when they started.
const withCurrent = (list: PromptRun[], fn: (p: PromptRun) => PromptRun): PromptRun[] => {
  const i = list.findLastIndex(p => p.status === 'running')
  return i < 0 ? list : list.map((p, j) => (j === i ? fn(p) : p))
}

const withAgent = (list: PromptRun[], id: string, fn: (a: AgentRun) => AgentRun): PromptRun[] =>
  list.map(p => (p.agents.some(a => a.id === id) ? { ...p, agents: p.agents.map(a => (a.id === id ? fn(a) : a)) } : p))

const statusOf = (reason: string): RunStatus => (reason === 'answer' ? 'done' : reason === 'aborted' ? 'aborted' : 'failed')

// Prompts kept by an earlier version of this mod may lack newer fields.
const normalize = (p: PromptRun): PromptRun => ({ ...p, models: p.models ?? [] })

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

// Your own prompts: typed here or sent from the Remote Control bridge.
const isPersons = (origin: { kind: string } | undefined): boolean => origin?.kind === 'composer' || origin?.kind === 'bridge'

// Records a prompt row once, by its id or, for a row first seen drawn, by its text.
const addRow = (list: PromptRow[], row: { id: string; text: string; isDrawn: boolean; sentAt?: number }): PromptRow[] => {
  const text = norm(row.text)
  if (!text || list.some(r => r.id === row.id || r.renderId === row.id)) return list
  if (row.isDrawn) {
    // The row was appended earlier under its uuid: remember the id it is drawn under.
    const i = list.findIndex(r => !r.renderId && r.text === text)
    if (i >= 0) return list.map((r, j) => (j === i ? { ...r, renderId: row.id } : r))
  }
  if (!row.isDrawn) return [...list, { id: row.id, text, sentAt: row.sentAt }]
  // Known only from its drawn row: sent before this mod was watching, so older than every
  // appended row; it goes after the other rows like it, in the order they are drawn.
  const at = list.findIndex(r => r.renderId !== r.id)
  const drawnRow = { id: row.id, renderId: row.id, text }
  return at < 0 ? [...list, drawnRow] : [...list.slice(0, at), drawnRow, ...list.slice(at)]
}

// The usage record of a prompt row: the latest run with its text.
const runOf = (list: PromptRun[], row: PromptRow): PromptRun | undefined => list.findLast(p => norm(p.text) === row.text)

const oneLine = (s: string, max: number): string => {
  const flat = norm(s)
  return flat.length > max ? flat.slice(0, Math.max(1, max - 1)) + '…' : flat
}

// 14:32:05 today; Oct 10, 14:32 on another day.
const fmtClock = (ms: number, today: number): string => {
  const d = new Date(ms)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  return d.toDateString() === new Date(today || ms).toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time.slice(0, 5)}`
}

// A translucent grey: a hover tint that reads on light and dark alike (no theme key is one).
const HOVER_BG = '#8080802a'

const STATUS_TEXT: Record<RunStatus, string> = { running: 'suggestion', done: 'success', aborted: 'warning', failed: 'error' }

const GLYPH: Record<RunStatus, string> = { running: '●', done: '✓', aborted: '◼', failed: '✗' }
const COLOR: Record<RunStatus, string> = { running: 'cyan', done: 'green', aborted: 'yellow', failed: 'red' }

const pctColor = (pct: number): string => (pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green')

const bar = (pct: number, width: number): string => {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const LIMIT_NAME: Record<string, string> = { five_hour: '5-hour', seven_day: '7-day', spend_limit: 'spend' }

async function togglePane($: EngineInterface): Promise<boolean> {
  if ((await $.ui.panes()).some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await $.ui.open({ id: PANE, title: TITLE })
  return true
}

// Prompt rows seen drawn, waiting to be saved: a render hook may not write state, so the
// next event or the ticker saves them (within a second). Module scope: a reload redraws.
let drawn: { id: string; text: string }[] = []

async function saveDrawn($: EngineInterface): Promise<void> {
  if (!drawn.length) return
  const batch = drawn
  drawn = []
  await update($, rows, list => batch.reduce((l, r) => addRow(l, { ...r, isDrawn: true }), list))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'usage-panel',
      description: 'Show or hide the live Usage pane: session cost, context, rate limits, this prompt, and every prompt of the session',
    })
    try {
      const usage = await $.session.usage()
      await update($, session, () => figures(usage))
      const at = await $.clock.now()
      await update($, now, () => at)
    } catch {
      // No figures yet: the first session.measure fills them.
    }
    // Once a second: saves rows seen drawn, and ticks running clocks; when nothing runs, once a
    // minute, for the reload countdown.
    $.clock.every(1000, () => {
      void (async () => {
        await saveDrawn($)
        const at = await $.clock.now()
        const isRunning = (await read($, prompts)).some(p => p.status === 'running' || p.agents.some(a => a.status === 'running'))
        if (!isRunning && Math.floor(at / 60_000) === Math.floor((await read($, now)) / 60_000)) return
        await update($, now, () => at)
      })()
    })
    void $.ui.open({ id: PANE, title: TITLE })
    return started
  })

  on('command.run', { command: 'usage-panel' }, async $ => ({
    text: (await togglePane($)) ? 'Usage pane opened.' : 'Usage pane closed.',
  }))

  // /clear starts the session over.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, prompts, () => [])
      await update($, rows, () => [])
      await update($, totals, () => null)
      await update($, session, s => ({ ...s, costUsd: 0 }))
    }
    return next(e)
  })

  // Cost, context and rate limits, as the status line and /cost see them.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await update($, session, () => figures(e))
    return result
  })

  // Your prompts as the conversation keeps them, by row id: the prompt list.
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const result = await next(e)
    await saveDrawn($)
    if (!e.agentId && isPersons(e.origin)) {
      const text = e.message.content.map(b => (b.type === 'text' ? b.text : '')).join('\n')
      const sentAt = await $.clock.now()
      await update($, rows, list => addRow(list, { id: e.uuid, text, isDrawn: false, sentAt }))
    }
    return result
  })

  // Your prompts' rows in the conversation, as drawn: prompts sent before this mod loaded,
  // and the id each is drawn under (so it is listed once). The drawing is the engine's.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (isPersons(e.props.origin)) {
      const id = e.requestId
      const known = await read($, rows)
      if (!known.some(r => r.id === id || r.renderId === id) && !drawn.some(r => r.id === id)) {
        drawn.push({ id, text: e.props.text })
      }
    }
    return next(e)
  })

  // The wheel over the prompt list scrolls the list, a card a tick; the pane stays put. The
  // list is the pane's last LIST_ROWS rows, so the pointer's row in the tree says which.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person' || !e.pointer || !(await read($, isListOpen))) return next(e)
    const count = (await read($, rows)).length
    const treeRow = e.offset - e.by + e.pointer.row
    if (count <= PAGE || treeRow < e.contentRows - LIST_ROWS || treeRow >= e.contentRows) return next(e)
    await update($, listStart, v => Math.max(0, Math.min(count - PAGE, Math.min(v, count - PAGE) + Math.sign(e.by))))
    return {}
  })

  // A main-loop turn: one per prompt (a subagent's run raises none).
  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    await saveDrawn($)
    const at = await $.clock.now()
    const { costUsd } = await read($, session)
    const run: PromptRun = {
      turnId: result.turnId ?? e.turnId,
      text: e.text,
      status: 'running',
      startedAt: at,
      model: '',
      calls: 0,
      tools: 0,
      tokens: zero(),
      costAtStart: costUsd,
      agents: [],
      models: [],
    }
    // A turn that never completed (the session was killed mid-turn) is closed here.
    await update($, prompts, list =>
      [...list.map(p => (p.status === 'running' ? { ...p, status: 'aborted' as const, endedAt: p.endedAt ?? at } : p)), run].slice(-KEEP),
    )
    await update($, now, () => at)
    return result
  })

  // Every model call, main loop or subagent: tokens, model and the tools it asked for.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    const tools = result.toolUses.length
    const model = usage?.model || e.model
    // The conversation's running totals: every call, main loop and subagents alike.
    const held = await read($, prompts)
    await update($, totals, c => {
      const base = c ?? seedTotals(held.map(normalize))
      return { modelCalls: base.modelCalls + 1, toolCalls: base.toolCalls + tools, tokens: usage ? add(base.tokens, usage) : base.tokens }
    })
    if (e.agentId) {
      const id = e.agentId
      await update($, prompts, list =>
        withAgent(list, id, a => ({
          ...a,
          model: model || a.model,
          calls: a.calls + 1,
          tools: a.tools + tools,
          tokens: usage ? add(a.tokens, usage) : a.tokens,
        })).map(p => (p.agents.some(a => a.id === id) ? { ...p, models: useModel(p.models ?? [], model, usage, id) } : p)),
      )
    } else {
      await update($, prompts, list =>
        list.map(p =>
          p.turnId !== e.turnId
            ? p
            : {
                ...p,
                model: model || p.model,
                calls: p.calls + 1,
                tools: p.tools + tools,
                tokens: usage ? add(p.tokens, usage) : p.tokens,
                models: useModel(p.models ?? [], model, usage),
              },
        ),
      )
    }
    return result
  })

  // A subagent started: filed under the running prompt, nested under its parent.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started
    const at = await $.clock.now()
    const run: AgentRun = {
      id: started.agentId ?? e.tool_use_id,
      parentId: e.parentAgentId,
      type: e.subagentType,
      description: e.description,
      model: started.model,
      status: 'running',
      startedAt: at,
      calls: 0,
      tools: 0,
      tokens: zero(),
    }
    await update($, prompts, list => withCurrent(list, p => ({ ...p, agents: [...p.agents.filter(a => a.id !== run.id), run] })))
    await update($, now, () => at)
    return started
  }).catch(($, e, next) => next(e)) // bookkeeping only: never stand in a spawn's way

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const at = await $.clock.now()
    const status = statusOf(e.reason)
    if (e.agentId) {
      const id = e.agentId
      await update($, prompts, list => withAgent(list, id, a => ({ ...a, status, endedAt: at })))
    } else {
      const { costUsd } = await read($, session)
      await update($, prompts, list =>
        list.map(p => (p.turnId === e.turnId ? { ...p, status, endedAt: at, costAtEnd: costUsd } : p)),
      )
    }
    await update($, now, () => at)
    return result
  })

  // ---- the pane -------------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = (await read($, prompts)).map(normalize)
    const s = await read($, session)
    const promptRows = await read($, rows)
    const isOpen = await read($, isListOpen)
    const convo = (await read($, totals)) ?? seedTotals(list)
    const at = Math.max(await read($, now), ...list.map(p => p.startedAt), 0)

    const costOf = (p: PromptRun): number =>
      Math.max(0, (p.costAtEnd ?? (p.status === 'running' ? s.costUsd : p.costAtStart)) - p.costAtStart)
    const elapsed = (r: { startedAt: number; endedAt?: number }) => (r.endedAt ?? at) - r.startedAt
    const calls = (p: PromptRun) => p.calls + p.agents.reduce((n, a) => n + a.calls, 0)
    const tools = (p: PromptRun) => p.tools + p.agents.reduce((n, a) => n + a.tools, 0)

    // Agents in spawn order, each child right under its parent.
    const ordered = (agents: AgentRun[]): { a: AgentRun; depth: number }[] => {
      const ids = new Set(agents.map(a => a.id))
      const out: { a: AgentRun; depth: number }[] = []
      const walk = (parent: string | undefined, depth: number) => {
        for (const a of agents) {
          const isChild = parent === undefined ? !a.parentId || !ids.has(a.parentId) : a.parentId === parent
          if (isChild) {
            out.push({ a, depth })
            walk(a.id, depth + 1)
          }
        }
      }
      walk(undefined, 0)
      return out
    }

    const latest = list.at(-1)
    // The prompt card and subagents show the latest prompt.
    const focus = latest
    const agents = focus ? ordered(focus.agents) : []

    // Every prompt of the session, newest first, in a fixed window of PAGE cards that the wheel
    // (or ▲ ▼) moves through. A card: a status dot, then its number and when it was sent; the
    // prompt; when it finished, its models and tokens (drawn like the token counter on the
    // desktop). Cards only show: a mod can't scroll the desktop app's conversation to a prompt.
    const firstShown = await read($, listStart)
    const promptList = (desk?: { W: number; Svg: ElementConstructor<SvgProps> }) => {
      const cols = Math.max(24, (e.props.bodyColumns || 60) - 8)
      const items = promptRows.map((row, i) => ({ row, run: runOf(list, row), n: i + 1 })).reverse()
      const start = Math.max(0, Math.min(firstShown, items.length - PAGE))
      const page = items.slice(start, start + PAGE)
      const canScroll = items.length > PAGE
      const move = (by: number) => update($, listStart, v => Math.max(0, Math.min(items.length - PAGE, Math.min(v, items.length - PAGE) + by)))

      const card = ({ row, run, n }: (typeof items)[number]) => {
        const isLatest = n === items.length
        const t = run ? promptTokens(run) : undefined
        const sent = run?.startedAt ?? row.sentAt
        const status = run?.status
        const done = run && status
          ? status === 'running'
            ? `Running ${fmtTime(at - run.startedAt)}`
            : `${status === 'done' ? 'Done' : status === 'aborted' ? 'Stopped' : 'Failed'} ${fmtClock(run.endedAt ?? at, at)} · ${fmtTime((run.endedAt ?? at) - run.startedAt)}`
          : ''
        const line = (suffix: string, ...children: (string | ReturnType<typeof h>)[]) => (
          <Box key={`line:${row.id}${suffix}`}>{h(Text, { wrap: 'truncate-end' }, ...children)}</Box>
        )
        const head = line(
          '',
          <Text key="index" color={isLatest ? 'claude' : 'subtle'} bold>
            {`#${n}`}
          </Text>,
          <Text key="sent" dimColor>
            {sent !== undefined ? `  ·  Sent ${fmtClock(sent, at)}` : '  ·  Sent before the panel was watching'}
          </Text>,
        )
        const text = line(
          ':prompt',
          <Text key="text" bold>
            {oneLine(row.text, cols)}
          </Text>,
        )
        let meta
        if (desk) {
          const m = recordMeta(desk.W - 52, run, t, done)
          meta = <desk.Svg key={`meta:${row.id}`} source={m.source} alt={m.alt} width={desk.W - 52} height={m.height} />
        } else {
          meta = line(
            ':done',
            ...(run && status
              ? [
                  <Text key="done" color={STATUS_TEXT[status]}>
                    {done}
                  </Text>,
                  <Text key="models" dimColor>
                    {`  ·  ${run.models.map(m => modelName(m.model)).join(', ') || 'no model yet'}`}
                  </Text>,
                  <Text key="tokens" bold>
                    {`  ·  ${t && total(t) > 0 ? fmtTokens(total(t)) : 0} tokens`}
                  </Text>,
                ]
              : [
                  <Text key="none" dimColor>
                    No figures: sent before the panel was watching
                  </Text>,
                ]),
          )
        }
        return (
          <Box
            key={`card:${row.id}`}
            flexDirection="row"
            alignItems="flex-start"
            gap={1}
            height={CARD_ROWS}
            borderStyle="round"
            borderColor={isLatest ? 'claude' : 'subtle'}
            hover={{ borderColor: 'claude', backgroundColor: HOVER_BG }}
            paddingX={1}
            marginTop={GAP_ROWS}
          >
            {/* The mark sits at the card's top left, beside its first line. On the desktop, Claude
                marks a running prompt (walking) and a finished one (cheering). */}
            <Box key={`mark:${row.id}`} alignSelf="flex-start" flexShrink={0}>
              {desk && status === 'running' ? (
                <desk.Svg key={`crab:${row.id}`} source={CRAB.source} alt="Claude at work" width={CRAB.width} height={CRAB.height} />
              ) : desk && status === 'done' ? (
                <desk.Svg key={`crab:${row.id}`} source={CRAB_DONE.source} alt="Completed" width={CRAB_DONE.width} height={CRAB_DONE.height} />
              ) : (
                <Text key={`dot:${row.id}`} color={status ? STATUS_TEXT[status] : 'inactive'}>
                  ●
                </Text>
              )}
            </Box>
            <Box key={`lines:${row.id}`} flexDirection="column" flexGrow={1}>
              {head}
              {text}
              {meta}
            </Box>
          </Box>
        )
      }

      return (
        <Box key="prompt-list" flexDirection="column" height={isOpen ? LIST_ROWS : 1} overflow="hidden" marginTop={1}>
          <Box key="list-head" flexDirection="row" justifyContent="space-between">
            <Button key="list-toggle" plain onPress={() => update($, isListOpen, v => !v)}>
              <Text bold>{isOpen ? '▾' : '▸'} Prompts in this session</Text>
              <Text dimColor> · {items.length}</Text>
            </Button>
            {isOpen && canScroll && (
              <Box key="list-nav" flexDirection="row" gap={1}>
                <Button key="list-newer" plain onPress={() => move(-PAGE)}>
                  <Text color={start > 0 ? 'claude' : 'inactive'}>▲</Text>
                </Button>
                <Text dimColor>{`${start + 1}–${start + page.length} of ${items.length}`}</Text>
                <Button key="list-older" plain onPress={() => move(PAGE)}>
                  <Text color={start + PAGE < items.length ? 'claude' : 'inactive'}>▼</Text>
                </Button>
              </Box>
            )}
          </Box>
          {isOpen && page.map(card)}
        </Box>
      )
    }

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(260, Math.min(900, (e.props.bodyColumns || 48) * 8 - 8))
      const tiles = sessionTiles(W, s, { now: at, prompts: promptRows.length, calls: convo })
      const card = focus
        ? promptCard(W, focus, promptTokens(focus), {
            costUsd: costOf(focus),
            elapsedMs: elapsed(focus),
            calls: calls(focus),
            tools: tools(focus),
          })
        : null
      return (
        <Box flexDirection="column" gap={1}>
          <Svg key="tiles" source={tiles.source} alt={tiles.alt} width={W} height={tiles.height} />
          {card ? (
            <Svg key="prompt" source={card.source} alt={card.alt} width={W} height={card.height} />
          ) : (
            <Text dimColor>Send a prompt to see its tokens, models and subagents.</Text>
          )}
          {agents.length > 0 && (
            <Box flexDirection="column">
              <Text bold>
                Subagents · {agents.length}
                {focus && focus.agents.some(a => a.status === 'running') ? ` (${focus.agents.filter(a => a.status === 'running').length} running)` : ''}
              </Text>
              {agents.map(({ a, depth }) => {
                const r = agentRow(W, a, depth, elapsed(a))
                return (
                  <Svg
                    key={`agent:${a.id}`}
                    source={r.source}
                    alt={`${a.description || a.type}: ${a.type}, ${modelName(a.model)}, ${a.status}, ${fmtTokens(total(a.tokens))} tokens`}
                    width={W}
                    height={r.height}
                  />
                )
              })}
            </Box>
          )}
          {promptList({ W, Svg })}
        </Box>
      )
    }

    // Terminal (and the editor and phone): the same content as text.
    const cols = Math.max(30, e.props.bodyColumns || 60)
    const barW = Math.max(8, Math.min(24, cols - 30))
    const ctxPct = s.contextPercent ?? (s.contextTokens && s.contextWindow ? (s.contextTokens / s.contextWindow) * 100 : undefined)
    const t = focus ? promptTokens(focus) : zero()
    const reload = nextReset(s, at)
    const resetOf = (iso?: string) => {
      const ms = iso ? Date.parse(iso) : NaN
      return Number.isFinite(ms) ? ` · resets ${fmtResetAt(ms, at)}` : ''
    }
    const hit = cacheHit(t)

    return (
      <Box flexDirection="column">
        <Text bold>Statistics</Text>
        {reload && (
          <Text wrap="truncate-end">
            {'  '}Tokens reload in <Text bold color="claude">{fmtUntil(reload.at - at)}</Text>
            <Text dimColor>
              {' '}
              · {limitName(reload.kind)} · {fmtResetAt(reload.at, at)}
            </Text>
          </Text>
        )}
        <Text wrap="truncate-end">
          {'  '}
          <Text bold>{convo.modelCalls}</Text> model calls · <Text bold>{convo.toolCalls}</Text> tool calls ·{' '}
          <Text bold>{promptRows.length}</Text> prompts
        </Text>
        <Text>
          {'  '}Cost <Text bold>{fmtUsd(s.costUsd)}</Text>
        </Text>
        {ctxPct !== undefined && (
          <Text wrap="truncate-end">
            {'  '}Context <Text color={pctColor(ctxPct)}>{bar(ctxPct, barW)}</Text> {Math.round(ctxPct)}%
            <Text dimColor>{s.contextTokens !== undefined ? ` · ${fmtTokens(s.contextTokens)} / ${fmtTokens(s.contextWindow)}` : ''}</Text>
          </Text>
        )}
        {s.rateLimits.map(r => (
          <Text key={r.kind} wrap="truncate-end">
            {'  '}
            {(LIMIT_NAME[r.kind] ?? r.kind).padEnd(7)} <Text color={pctColor(r.percentUsed)}>{bar(r.percentUsed, barW)}</Text> {Math.round(r.percentUsed)}%
            <Text dimColor>{resetOf(r.resetsAt)}</Text>
          </Text>
        ))}

        <Box marginTop={1} flexDirection="column">
          <Text bold>This prompt</Text>
          {focus ? (
            <Box flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={COLOR[focus.status]}>{GLYPH[focus.status]}</Text> “{oneLine(focus.text, cols - 6) || '(no text)'}”
              </Text>
              <Text dimColor wrap="truncate-end">
                {'  '}≈{fmtUsd(costOf(focus))} · {fmtTime(elapsed(focus))} · {calls(focus)} calls · {tools(focus)} tools
              </Text>
              <Text wrap="truncate-end">
                {'  '}Tokens <Text bold>{fmtTokens(total(t))}</Text>
                <Text dimColor> · {PARTS.map(p => `${p.label} ${fmtTokens(t[p.key])}`).join(' · ')}</Text>
              </Text>
              <Text dimColor wrap="truncate-end">
                {'  '}cache hit {hit === undefined ? '—' : `${Math.round(hit)}%`} · {calls(focus) ? fmtTokens(total(t) / calls(focus)) : '—'} per call
              </Text>
              <Text>{'  '}Models</Text>
              {focus.models.length ? (
                focus.models.map(m => (
                  <Text key={m.model} wrap="truncate-end">
                    {'    '}
                    <Text bold>{modelName(m.model)}</Text>
                    <Text dimColor>
                      {' '}
                      {m.model} · {whereOf(m)} · {m.mainCalls + m.agentCalls} calls · {fmtTokens(total(m.tokens))} tok
                    </Text>
                  </Text>
                ))
              ) : (
                <Text dimColor>{'    '}waiting for the first model call…</Text>
              )}
              {agents.length > 0 && <Text>{'  '}Subagents · {agents.length}</Text>}
              {agents.map(({ a, depth }) => (
                <Box key={a.id} flexDirection="column">
                  <Text wrap="truncate-end">
                    {'    '}
                    {'  '.repeat(depth)}
                    <Text color={COLOR[a.status]}>{GLYPH[a.status]}</Text> <Text bold>{a.description || a.type}</Text>
                    <Text dimColor> · {a.type}</Text>
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    {'      '}
                    {'  '.repeat(depth)}
                    {modelName(a.model)} · {fmtTime(elapsed(a))} · {a.calls} calls · {a.tools} tools · {fmtTokens(total(a.tokens))} tok
                  </Text>
                </Box>
              ))}
            </Box>
          ) : (
            <Text dimColor>{'  '}Send a prompt to see its tokens, models and subagents.</Text>
          )}
        </Box>
        {promptList()}
      </Box>
    )
  })

  // ---- the band above the prompt: this prompt's tokens and model ------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, prompts)
    const last = list.at(-1)
    if (!last || e.props.hasSurvey) return next(e)
    // The band is shared: what the plugins beneath draw there stays, below this row.
    const below = await next(e)
    const p = normalize(last)
    const s = await read($, session)
    const at = Math.max(await read($, now), p.startedAt)
    const t = promptTokens(p)
    const elapsedMs = (p.endedAt ?? at) - p.startedAt
    const cost = Math.max(0, (p.costAtEnd ?? (p.status === 'running' ? s.costUsd : p.costAtStart)) - p.costAtStart)
    const mainModel = p.model || p.models[0]?.model || ''
    const others = p.models.filter(m => m.model !== mainModel).map(m => modelName(m.model))
    const alt = `${mainModel || 'no model yet'}${others.length ? ` + ${others.join(', ')}` : ''}: ${fmtTokens(total(t))} tokens (${fmtTokens(t.output)} out), ${fmtTime(elapsedMs)}, ≈${fmtUsd(cost)}`

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const open = <Button key="usage-open" label="Usage" plain onPress={() => void togglePane($)} />

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(220, Math.min(1400, (e.props.bodyColumns || 100) * 8 - 72))
      const row = bandRow(W, p, t, elapsedMs, cost)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg key="usage-band" source={row.source} alt={alt} width={W} height={row.height} />
            {open}
          </Box>
          {below}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={COLOR[p.status]}>{GLYPH[p.status]}</Text>
          <Text bold>{mainModel ? modelName(mainModel) : '—'}</Text>
          <Text dimColor wrap="truncate-end">
            {mainModel}
            {others.length ? ` +${others.join(', +')}` : ''}
          </Text>
          <Text>│</Text>
          <Text bold>{fmtTokens(total(t))} tokens</Text>
          <Text dimColor>({fmtTokens(t.output)} out)</Text>
          <Text>│</Text>
          <Text dimColor>
            {fmtTime(elapsedMs)} · ≈{fmtUsd(cost)}
          </Text>
          {open}
        </Box>
        {below}
      </Box>
    )
  })
}

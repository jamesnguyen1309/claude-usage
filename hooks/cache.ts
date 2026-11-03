// The prompt cache, the context window's growth and the costliest prompts: pure functions over
// the prompts the mod keeps; the drawing is in draw.ts and register.tsx.
import type { CacheTtl, PromptRun, Tokens } from '../types'

const MIN = 60_000

export const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * MIN, '1h': 60 * MIN }

/** A cache write this small is new content, not a rewrite of the conversation. */
const MIN_REWRITE = 1024

/**
 * Whether a prompt's first main-loop call rewrote the cache: it wrote more than it read, so the
 * conversation so far was no longer cached (it lapsed, was compacted, or the model changed).
 */
export const isRewrite = (t: { cacheRead: number; cacheWrite: number }): boolean =>
  t.cacheWrite >= MIN_REWRITE && t.cacheRead < t.cacheWrite

/**
 * What a gap between two calls says about the cache's lifetime. A hit after more than 5 minutes
 * means it lasts an hour; a rewrite after 5 minutes to an hour means it lasts 5.
 */
export const learnTtl = (ttl: CacheTtl, gapMs: number, isHit: boolean): CacheTtl => {
  if (isHit && gapMs > TTL_MS['5m']) return '1h'
  if (!isHit && gapMs > TTL_MS['5m'] && gapMs < TTL_MS['1h']) return '5m'
  return ttl
}

/** When the main conversation last called the model. */
export const lastCallOf = (list: PromptRun[]): number | undefined => list.findLast(p => p.lastCallAt !== undefined)?.lastCallAt

/** How long the cache stays warm from now: negative once it lapsed, undefined before any call. */
export const warmFor = (list: PromptRun[], ttl: CacheTtl, now: number): number | undefined => {
  const last = lastCallOf(list)
  return last === undefined ? undefined : last + TTL_MS[ttl] - now
}

// Each kind of token's price relative to fresh input, the same on every Claude model: output
// costs 5 times as much, a cache read a tenth, a cache write 1.25 times (5-minute) or twice (1-hour).
const weightOf = (ttl: CacheTtl) => ({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: ttl === '1h' ? 2 : 1.25 })

/** The rewrite's share of what the prompt cost, in USD: its tokens weighted by price, of the prompt's. */
export const rewriteUsd = (rewritten: number, ttl: CacheTtl, t: Tokens, costUsd: number): number => {
  const w = weightOf(ttl)
  const all = t.input * w.input + t.output * w.output + t.cacheRead * w.cacheRead + t.cacheWrite * w.cacheWrite
  return all > 0 ? (costUsd * rewritten * w.cacheWrite) / all : 0
}

/** Prompts read to find the context's growth per prompt. */
const GROWTH_PROMPTS = 6

/**
 * How many more prompts until the context reaches `limit`, at the growth of the last few
 * prompts since the context last shrank (a compaction or /clear starts it over).
 */
export function promptsUntil(list: PromptRun[], current: number, limit: number): { prompts: number; perPrompt: number } | undefined {
  const sizes = list.filter(p => p.status !== 'running' && p.contextAfter !== undefined).map(p => p.contextAfter as number)
  const drop = sizes.findLastIndex((n, i) => i > 0 && n < (sizes[i - 1] ?? 0))
  const run = sizes.slice(Math.max(0, drop)).slice(-GROWTH_PROMPTS)
  const first = run[0]
  const last = run.at(-1)
  if (run.length < 2 || first === undefined || last === undefined || last <= first) return undefined
  const perPrompt = (last - first) / (run.length - 1)
  return { prompts: Math.max(0, Math.ceil((limit - current) / perPrompt)), perPrompt }
}

/** The finished prompts that cost the most, costliest first. */
export const costliest = <P extends PromptRun>(list: P[], costOf: (p: P) => number, n: number): { p: P; usd: number }[] =>
  list
    .filter(p => p.status !== 'running' && p.costAtEnd !== undefined)
    .map(p => ({ p, usd: costOf(p) }))
    .filter(r => r.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, n)

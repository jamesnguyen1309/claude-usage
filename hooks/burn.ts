// Burn rate: how fast each rate-limit window is being used, and where that pace leads before
// it reloads. Pure functions over the readings kept in the store (account-wide, so they span
// sessions); the drawing is in draw.ts.
import type { BurnSample, RateLimit } from '../types'

const MIN = 60_000
const HOUR = 60 * MIN

/** How long each window runs, and how far back its pace is read. */
const WINDOW: Record<string, { length: number; lookback: number; per: number; perLabel: string }> = {
  five_hour: { length: 5 * HOUR, lookback: HOUR, per: HOUR, perLabel: 'hour' },
  seven_day: { length: 7 * 24 * HOUR, lookback: 24 * HOUR, per: 24 * HOUR, perLabel: 'day' },
}
const DEFAULT_WINDOW = { length: 5 * HOUR, lookback: HOUR, per: HOUR, perLabel: 'hour' }
export const windowOf = (kind: string) => WINDOW[kind] ?? DEFAULT_WINDOW

/** Readings older than this are dropped: past the longest window. */
const KEEP_MS = 8 * 24 * HOUR
const KEEP_COUNT = 3000
/** A pace read over less than this is too coarse to forecast from (the limits move a point at a time). */
const MIN_SPAN = 10 * MIN

/** Adds the readings that moved since the last one of their kind; drops the stale. */
export const addSamples = (list: BurnSample[], limits: RateLimit[], at: number): BurnSample[] => {
  let out = list.filter(s => at - s.at < KEEP_MS)
  for (const r of limits) {
    const last = out.findLast(s => s.kind === r.kind)
    if (last && last.pct === r.percentUsed && last.resetsAt === r.resetsAt) continue
    out = [...out, { at, kind: r.kind, pct: r.percentUsed, resetsAt: r.resetsAt }]
  }
  return out.slice(-KEEP_COUNT)
}

export type Forecast =
  | { kind: 'measuring' }
  | { kind: 'idle' }
  | { kind: 'hits'; at: number }
  | { kind: 'makes'; atReset: number }

export type Burn = {
  kind: string
  pct: number
  resetAt?: number
  /** Points of the window per `per` ms, over the lookback; undefined while measuring. */
  rate?: number
  per: number
  perLabel: string
  /** This window's readings, oldest first, the last at now. */
  series: { at: number; pct: number }[]
  start: number
  forecast: Forecast
}

export function burnOf(limit: RateLimit, samples: BurnSample[], now: number): Burn {
  const w = windowOf(limit.kind)
  const resetAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  const hasReset = Number.isFinite(resetAt)
  // This window's readings: same reset time, and after the last drop (a reset seen early).
  let mine = samples.filter(s => s.kind === limit.kind && s.resetsAt === limit.resetsAt && s.at <= now)
  const drop = mine.findLastIndex((s, i) => i > 0 && s.pct < (mine[i - 1]?.pct ?? 0))
  if (drop > 0) mine = mine.slice(drop)
  const series = [...mine.map(s => ({ at: s.at, pct: s.pct })), { at: now, pct: limit.percentUsed }]
  const start = hasReset ? resetAt - w.length : (series[0]?.at ?? now)
  const base = { kind: limit.kind, pct: limit.percentUsed, resetAt: hasReset ? resetAt : undefined, per: w.per, perLabel: w.perLabel, series, start }

  // The pace: from the last reading at or before the lookback (else the first), to now. Idle
  // time counts, so a quiet stretch slows it.
  const from = mine.findLast(s => s.at <= now - w.lookback) ?? mine[0]
  if (!from || now - from.at < MIN_SPAN) return { ...base, forecast: { kind: 'measuring' } }
  const perMs = Math.max(0, limit.percentUsed - from.pct) / (now - from.at)
  const rate = perMs * w.per
  // Flat: idle only once flat for the whole lookback; before that, a point may just not have ticked.
  if (perMs <= 0) return now - from.at >= w.lookback ? { ...base, rate, forecast: { kind: 'idle' } } : { ...base, forecast: { kind: 'measuring' } }
  const fullAt = now + Math.max(0, 100 - limit.percentUsed) / perMs
  if (hasReset && fullAt >= resetAt) return { ...base, rate, forecast: { kind: 'makes', atReset: limit.percentUsed + perMs * (resetAt - now) } }
  return { ...base, rate, forecast: { kind: 'hits', at: fullAt } }
}

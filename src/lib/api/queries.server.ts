import type { Database } from "better-sqlite3"
import { AGENTS, AGENT_IDS, isAgentId } from "../agents/registry"
import type { AgentId } from "../agents/registry"
import { ADAPTERS } from "../agents"
import { canonicalProject, displayProject } from "../usage/project.server"
import { getDb } from "../db/client.server"
import type {
  AgentPoint,
  AgentStatus,
  BreakdownDimension,
  BreakdownRow,
  OverviewStats,
  SessionPage,
  SessionSummary,
  StatsFilter,
  TimeRange,
  TimeSeries,
  TokenTotals,
} from "./types"

const IDLE_GAP_MS = 30 * 60 * 1000

const RANGE_MS: Record<Exclude<TimeRange, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
}

interface Interval {
  from: number | null
  to: number | null
}

/** Explicit from/to dates override the named range. */
function intervalOf(filter: StatsFilter): Interval {
  if (filter.from || filter.to) {
    const from = filter.from ? Date.parse(filter.from) : NaN
    const to = filter.to ? Date.parse(filter.to) + 24 * 60 * 60 * 1000 : NaN
    return {
      from: Number.isNaN(from) ? null : from,
      to: Number.isNaN(to) ? null : to,
    }
  }
  if (filter.range === "all") return { from: null, to: null }
  return { from: Date.now() - RANGE_MS[filter.range], to: null }
}

interface WhereClause {
  sql: string
  params: (string | number)[]
}

function whereOf(
  filter: StatsFilter,
  interval: Interval = intervalOf(filter)
): WhereClause {
  const clauses: string[] = []
  const params: (string | number)[] = []
  const { from, to } = interval
  if (from !== null) {
    clauses.push("timestamp >= ?")
    params.push(from)
  }
  if (to !== null) {
    clauses.push("timestamp < ?")
    params.push(to)
  }
  if (filter.models?.length) {
    clauses.push(`model IN (${filter.models.map(() => "?").join(", ")})`)
    params.push(...filter.models)
  }
  if (filter.projects?.length) {
    clauses.push(`project IN (${filter.projects.map(() => "?").join(", ")})`)
    params.push(...filter.projects)
  }
  if (filter.agents?.length) {
    clauses.push(`agent IN (${filter.agents.map(() => "?").join(", ")})`)
    params.push(...filter.agents)
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params }
}

const TOKEN_SUMS = `
  SUM(input_tokens) AS input,
  SUM(output_tokens) AS output,
  SUM(cache_read_tokens) AS cacheRead,
  SUM(cache_write_tokens) AS cacheWrite,
  SUM(reasoning_tokens) AS reasoning`

interface TokenSumRow {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  reasoning: number | null
}

function tokenTotalsOf(row: TokenSumRow): TokenTotals {
  const input = row.input ?? 0
  const output = row.output ?? 0
  const cacheRead = row.cacheRead ?? 0
  const cacheWrite = row.cacheWrite ?? 0
  const reasoning = row.reasoning ?? 0
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    total: input + output + cacheRead + cacheWrite + reasoning,
  }
}

export function getOverview(filter: StatsFilter): OverviewStats {
  const db = getDb()
  const where = whereOf(filter)
  const row = db
    .prepare(
      `SELECT ${TOKEN_SUMS},
        COUNT(*) AS events,
        COUNT(DISTINCT session_id) AS sessions,
        COUNT(DISTINCT local_date) AS activeDays,
        SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd ELSE 0 END) AS pricedCost,
        SUM(CASE WHEN cost_source = 'reported' THEN cost_usd ELSE 0 END) AS reportedCost,
        SUM(CASE WHEN cost_source = 'estimated' THEN cost_usd ELSE 0 END) AS estimatedCost,
        SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpricedEvents,
        SUM(CASE WHEN cost_usd IS NULL THEN input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens ELSE 0 END) AS unpricedTokens,
        MAX(estimated_tokens) AS hasEstimated,
        MIN(timestamp) AS first,
        MAX(timestamp) AS last
       FROM usage_events ${where.sql}`
    )
    .get(...where.params) as TokenSumRow & {
    events: number
    sessions: number
    activeDays: number
    pricedCost: number | null
    reportedCost: number | null
    estimatedCost: number | null
    unpricedEvents: number | null
    unpricedTokens: number | null
    hasEstimated: number | null
    first: number | null
    last: number | null
  }
  const previous = previousOverview(db, filter)
  const tokens = tokenTotalsOf(row)
  return {
    tokens,
    pricedCostUsd: row.pricedCost ?? 0,
    reportedCostUsd: row.reportedCost ?? 0,
    estimatedCostUsd: row.estimatedCost ?? 0,
    unpricedEventCount: row.unpricedEvents ?? 0,
    unpricedTokens: row.unpricedTokens ?? 0,
    events: row.events,
    sessions: row.sessions,
    activeDays: row.activeDays,
    activeTimeMs: activeTime(db, where),
    cacheReadShare:
      tokens.input + tokens.cacheRead > 0
        ? tokens.cacheRead / (tokens.input + tokens.cacheRead)
        : 0,
    hasEstimatedTokens: (row.hasEstimated ?? 0) > 0,
    firstTimestamp: row.first,
    lastTimestamp: row.last,
    previous,
  }
}

/** Aggregates for the same-length window immediately before the filter range. */
function previousOverview(
  db: Database,
  filter: StatsFilter
): OverviewStats["previous"] {
  const { from, to } = intervalOf(filter)
  if (from === null) return null
  const length = (to ?? Date.now()) - from
  const where = whereOf(filter, { from: from - length, to: from })
  const row = db
    .prepare(
      `SELECT ${TOKEN_SUMS},
        COUNT(*) AS events,
        COUNT(DISTINCT session_id) AS sessions,
        SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd ELSE 0 END) AS pricedCost
       FROM usage_events ${where.sql}`
    )
    .get(...where.params) as TokenSumRow & {
    events: number
    sessions: number
    pricedCost: number | null
  }
  if (row.events === 0) return null
  const tokens = tokenTotalsOf(row)
  return {
    tokens,
    pricedCostUsd: row.pricedCost ?? 0,
    sessions: row.sessions,
    activeTimeMs: activeTime(db, where),
    cacheReadShare:
      tokens.input + tokens.cacheRead > 0
        ? tokens.cacheRead / (tokens.input + tokens.cacheRead)
        : 0,
  }
}

/** Sum of gaps under 30 minutes between consecutive events, plus a minimum minute per isolated event. */
function activeTime(db: Database, where: WhereClause): number {
  const rows = db
    .prepare(
      `SELECT timestamp FROM usage_events ${where.sql} ORDER BY timestamp`
    )
    .all(...where.params) as { timestamp: number }[]
  let active = 0
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].timestamp - rows[i - 1].timestamp
    if (gap > 0 && gap < IDLE_GAP_MS) active += gap
  }
  return active
}

export function getTimeSeries(filter: StatsFilter): TimeSeries {
  const db = getDb()
  const where = whereOf(filter)
  const { from, to } = intervalOf(filter)
  const bucketMs =
    filter.range === "24h" && !filter.from
      ? 5 * 60 * 1000
      : filter.range === "7d" && !filter.from
        ? 60 * 60 * 1000
        : 24 * 60 * 60 * 1000
  const rows = db
    .prepare(
      `SELECT
         (timestamp / ${bucketMs}) * ${bucketMs} AS bucket,
         agent,
         SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens) AS tokens,
         SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd ELSE 0 END) AS cost,
         COUNT(*) AS events
       FROM usage_events ${where.sql}
       GROUP BY bucket, agent ORDER BY bucket`
    )
    .all(...where.params) as {
    bucket: number
    agent: string
    tokens: number
    cost: number
    events: number
  }[]

  const first = rows.length ? rows[0].bucket : null
  const last = rows.length ? rows[rows.length - 1].bucket : null
  const start = from !== null ? Math.trunc(from / bucketMs) * bucketMs : first
  const end =
    to !== null
      ? Math.trunc((to - 1) / bucketMs) * bucketMs
      : Math.max(last ?? 0, Math.trunc(Date.now() / bucketMs) * bucketMs)
  if (start === null || rows.length === 0) return { bucketMs, points: [] }

  const byBucket = new Map<number, (typeof rows)[number][]>()
  for (const row of rows) {
    const bucket = byBucket.get(row.bucket)
    if (bucket) bucket.push(row)
    else byBucket.set(row.bucket, [row])
  }
  const points = []
  for (let t = start; t <= end; t += bucketMs) {
    const bucketRows = byBucket.get(t) ?? []
    const byAgent: Partial<Record<AgentId, AgentPoint>> = {}
    let tokens = 0
    let costUsd = 0
    let events = 0
    for (const row of bucketRows) {
      tokens += row.tokens
      costUsd += row.cost
      events += row.events
      if (isAgentId(row.agent)) {
        const slice = (byAgent[row.agent] ??= {
          tokens: 0,
          costUsd: 0,
          events: 0,
        })
        slice.tokens += row.tokens
        slice.costUsd += row.cost
        slice.events += row.events
      }
    }
    points.push({ t, tokens, costUsd, events, byAgent })
  }
  return { bucketMs, points }
}

const DIMENSION_COLUMN: Record<BreakdownDimension, string> = {
  agent: "agent",
  provider: "provider",
  model: "model",
  project: "project",
}

export function getBreakdown(
  filter: StatsFilter,
  dimension: BreakdownDimension
): BreakdownRow[] {
  const db = getDb()
  const where = whereOf(filter)
  const column = DIMENSION_COLUMN[dimension]
  const rows = db
    .prepare(
      `SELECT COALESCE(${column}, '(unknown)') AS key, ${TOKEN_SUMS},
        SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd ELSE 0 END) AS pricedCost,
        SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpricedEvents,
        COUNT(*) AS events,
        COUNT(DISTINCT session_id) AS sessions,
        MIN(timestamp) AS first,
        MAX(timestamp) AS last,
        MAX(estimated_tokens) AS hasEstimated
       FROM usage_events ${where.sql}
       GROUP BY key ORDER BY (SUM(input_tokens) + SUM(output_tokens) + SUM(cache_read_tokens) + SUM(cache_write_tokens) + SUM(reasoning_tokens)) DESC`
    )
    .all(...where.params) as BreakdownSumRow[]
  const merged = dimension === "project" ? mergeProjectRows(rows) : rows
  const grandTotal = merged.reduce(
    (sum, row) => sum + tokenTotalsOf(row).total,
    0
  )
  return merged.map((row) => {
    const tokens = tokenTotalsOf(row)
    return {
      key: row.key,
      label: labelOf(dimension, row.key),
      tokens,
      pricedCostUsd: row.pricedCost ?? 0,
      unpricedEventCount: row.unpricedEvents ?? 0,
      events: row.events,
      sessions: row.sessions,
      firstTimestamp: row.first,
      lastTimestamp: row.last,
      tokenShare: grandTotal > 0 ? tokens.total / grandTotal : 0,
      cacheReadShare:
        tokens.input + tokens.cacheRead > 0
          ? tokens.cacheRead / (tokens.input + tokens.cacheRead)
          : 0,
      hasEstimatedTokens: (row.hasEstimated ?? 0) > 0,
    }
  })
}

interface BreakdownSumRow extends TokenSumRow {
  key: string
  pricedCost: number | null
  unpricedEvents: number | null
  events: number
  sessions: number
  first: number
  last: number
  hasEstimated: number | null
}

function labelOf(dimension: BreakdownDimension, key: string): string {
  if (dimension === "agent" && isAgentId(key)) return AGENTS[key].label
  if (dimension === "project") return displayProject(key) ?? key
  return key
}

/**
 * Agents record the same working directory in different shapes, so the SQL
 * GROUP BY can split one project across rows. Re-group by canonical path.
 * Session ids never span two shapes of one project, so counts add up.
 */
function mergeProjectRows(rows: BreakdownSumRow[]): BreakdownSumRow[] {
  const merged = new Map<string, BreakdownSumRow>()
  for (const row of rows) {
    const key =
      row.key === "(unknown)"
        ? row.key
        : (canonicalProject(row.key) ?? "(unknown)")
    const prev = merged.get(key)
    if (!prev) {
      merged.set(key, { ...row, key })
      continue
    }
    prev.input = (prev.input ?? 0) + (row.input ?? 0)
    prev.output = (prev.output ?? 0) + (row.output ?? 0)
    prev.cacheRead = (prev.cacheRead ?? 0) + (row.cacheRead ?? 0)
    prev.cacheWrite = (prev.cacheWrite ?? 0) + (row.cacheWrite ?? 0)
    prev.reasoning = (prev.reasoning ?? 0) + (row.reasoning ?? 0)
    prev.pricedCost = (prev.pricedCost ?? 0) + (row.pricedCost ?? 0)
    prev.unpricedEvents = (prev.unpricedEvents ?? 0) + (row.unpricedEvents ?? 0)
    prev.events += row.events
    prev.sessions += row.sessions
    prev.first = Math.min(prev.first, row.first)
    prev.last = Math.max(prev.last, row.last)
    prev.hasEstimated = Math.max(prev.hasEstimated ?? 0, row.hasEstimated ?? 0)
  }
  return [...merged.values()].sort(
    (a, b) => tokenTotalsOf(b).total - tokenTotalsOf(a).total
  )
}

export function getSessions(
  filter: StatsFilter,
  page: number,
  pageSize: number
): SessionPage {
  const db = getDb()
  const where = whereOf(filter)
  const total = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT session_id) AS n FROM usage_events ${where.sql}`
      )
      .get(...where.params) as { n: number }
  ).n
  const rows = db
    .prepare(
      `SELECT session_id AS sessionId, agent, project, ${TOKEN_SUMS},
        SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd ELSE 0 END) AS pricedCost,
        SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpricedEvents,
        COUNT(*) AS events,
        MIN(timestamp) AS first,
        MAX(timestamp) AS last,
        MAX(estimated_tokens) AS hasEstimated,
        GROUP_CONCAT(DISTINCT model) AS models
       FROM usage_events ${where.sql}
       GROUP BY session_id, agent ORDER BY last DESC LIMIT ? OFFSET ?`
    )
    .all(...where.params, pageSize, (page - 1) * pageSize) as (TokenSumRow & {
    sessionId: string
    agent: string
    project: string | null
    pricedCost: number | null
    unpricedEvents: number | null
    events: number
    first: number
    last: number
    hasEstimated: number | null
    models: string | null
  })[]
  const sessions: SessionSummary[] = rows
    .filter((row) => isAgentId(row.agent))
    .map((row) => ({
      sessionId: row.sessionId,
      // filter above guarantees this; TS cannot see across the two callbacks
      agent: row.agent as AgentId,
      project: displayProject(canonicalProject(row.project)),
      models: row.models ? row.models.split(",").filter(Boolean) : [],
      tokens: tokenTotalsOf(row),
      pricedCostUsd: row.pricedCost ?? 0,
      unpricedEventCount: row.unpricedEvents ?? 0,
      events: row.events,
      firstTimestamp: row.first,
      lastTimestamp: row.last,
      hasEstimatedTokens: (row.hasEstimated ?? 0) > 0,
    }))
  return { sessions, total, page, pageSize }
}

export function getAgentStatuses(): AgentStatus[] {
  const db = getDb()
  const sourceRows = db
    .prepare(
      `SELECT agent,
        COUNT(*) AS sources,
        SUM(warnings) AS warnings,
        MAX(last_synced_at) AS lastSynced,
        MAX(CASE WHEN error IS NOT NULL THEN error END) AS error
       FROM sources GROUP BY agent`
    )
    .all() as {
    agent: string
    sources: number
    warnings: number | null
    lastSynced: number | null
    error: string | null
  }[]
  const eventRows = db
    .prepare(
      "SELECT agent, COUNT(*) AS events FROM usage_events GROUP BY agent"
    )
    .all() as { agent: string; events: number }[]
  const eventsByAgent: Partial<Record<string, number>> = {}
  for (const row of eventRows) eventsByAgent[row.agent] = row.events
  const sourcesByAgent: Partial<Record<string, (typeof sourceRows)[number]>> =
    {}
  for (const row of sourceRows) sourcesByAgent[row.agent] = row

  const cacheBacked: Partial<Record<string, boolean>> = {}
  for (const adapter of ADAPTERS)
    cacheBacked[adapter.id] = adapter.cacheBacked ?? false

  return AGENT_IDS.map((id) => {
    const meta = AGENTS[id]
    const source = sourcesByAgent[id]
    const events = eventsByAgent[id] ?? 0
    let state: AgentStatus["state"] = "not-found"
    if (source?.error) state = "error"
    else if (source || events > 0) state = "ok"
    else if (meta.kind === "cache") state = "sync-required"
    return {
      id,
      label: meta.label,
      kind: meta.kind,
      state,
      sourceCount: source?.sources ?? 0,
      warnings: source?.warnings ?? 0,
      error: source?.error ?? null,
      lastSyncedAt: source?.lastSynced ?? null,
      events,
    }
  })
}

import type { AgentId } from "../agents/registry"

export type TimeRange = "24h" | "7d" | "30d" | "90d" | "year" | "all"

export const TIME_RANGES: TimeRange[] = [
  "24h",
  "7d",
  "30d",
  "90d",
  "year",
  "all",
]

/** Filters shared by every analytic endpoint, carried in the URL. */
export interface StatsFilter {
  range: TimeRange
  agents?: AgentId[]
  /** Exact model names as stored (breakdown row keys). */
  models?: string[]
  /** Canonical project paths as stored (breakdown row keys). */
  projects?: string[]
  /** ISO dates; when present they override range. */
  from?: string
  to?: string
}

export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  total: number
}

export interface OverviewStats {
  tokens: TokenTotals
  /** Sum of costUsd over priced events (reported + estimated). */
  pricedCostUsd: number
  reportedCostUsd: number
  estimatedCostUsd: number
  unpricedEventCount: number
  unpricedTokens: number
  events: number
  sessions: number
  activeDays: number
  /** Sum of active time, sessions split at 30-minute idle gaps. */
  activeTimeMs: number
  cacheReadShare: number
  hasEstimatedTokens: boolean
  firstTimestamp: number | null
  lastTimestamp: number | null
  /** Same-length window immediately before the range; null for "all" or an empty previous window. */
  previous: {
    tokens: TokenTotals
    pricedCostUsd: number
    sessions: number
    activeTimeMs: number
    cacheReadShare: number
  } | null
}

export interface AgentPoint {
  tokens: number
  costUsd: number
  events: number
}

export interface TimeSeriesPoint {
  /** Bucket start, epoch ms. */
  t: number
  tokens: number
  costUsd: number
  events: number
  /** Per-agent slice of the bucket. */
  byAgent: Partial<Record<AgentId, AgentPoint>>
}

export interface TimeSeries {
  bucketMs: number
  points: TimeSeriesPoint[]
}

export type BreakdownDimension = "agent" | "provider" | "model" | "project"

export interface BreakdownRow {
  key: string
  label: string
  tokens: TokenTotals
  pricedCostUsd: number
  unpricedEventCount: number
  events: number
  sessions: number
  firstTimestamp: number
  lastTimestamp: number
  /** Share of total tokens, 0..1. */
  tokenShare: number
  /** Cache reads as a share of input plus cache-read tokens, 0..1. */
  cacheReadShare: number
  hasEstimatedTokens: boolean
}

export interface SessionSummary {
  sessionId: string
  agent: AgentId
  project: string | null
  models: string[]
  tokens: TokenTotals
  pricedCostUsd: number
  unpricedEventCount: number
  events: number
  firstTimestamp: number
  lastTimestamp: number
  hasEstimatedTokens: boolean
}

export interface SessionPage {
  sessions: SessionSummary[]
  total: number
  page: number
  pageSize: number
}

export type AgentSourceState = "ok" | "sync-required" | "error" | "not-found"

export interface AgentStatus {
  id: AgentId
  label: string
  kind: "local" | "cache" | "attributed"
  state: AgentSourceState
  sourceCount: number
  warnings: number
  error: string | null
  lastSyncedAt: number | null
  events: number
}

export interface SyncStatus {
  running: boolean
  lastRun: {
    startedAt: number
    finishedAt: number | null
    discovered: number
    processed: number
    skipped: number
    inserted: number
    warnings: number
  } | null
}

export interface DailyActivity {
  date: string
  tokens: number
  costUsd: number
  events: number
}

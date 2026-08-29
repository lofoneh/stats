import Database from "better-sqlite3"
import type { AgentId } from "../../registry"
import type { ParseContext, ParseOutput, UsageSource } from "../../types"
import { eventId, localDateOf, timestampOf, tokenCount } from "../../../usage/parse"
import type { UsageEvent } from "../../../usage/types"

export interface SqliteUsageRow {
  id: string | number
  session_id: string | number
  timestamp: unknown
  provider?: unknown
  model?: unknown
  project?: unknown
  input_tokens?: unknown
  output_tokens?: unknown
  cache_read_tokens?: unknown
  cache_write_tokens?: unknown
  reasoning_tokens?: unknown
  cost_usd?: unknown
  duration_ms?: unknown
  dedup_key?: unknown
}

export interface SqliteSpec {
  agent: AgentId
  query: string
  map?: (row: Record<string, unknown>) => SqliteUsageRow | null
  attribute?: (row: SqliteUsageRow) => AgentId
  /** Empty parse when `usage_events` is absent. Off by default so schema mismatches stay errors. */
  allowMissingUsageEvents?: boolean
}

export async function parseSqliteUsage(
  source: UsageSource,
  context: ParseContext,
  spec: SqliteSpec,
): Promise<ParseOutput> {
  const db = new Database(source.path, { readonly: true, fileMustExist: true })
  try {
    let rows: Record<string, unknown>[]
    try {
      rows = db.prepare(spec.query).all() as Record<string, unknown>[]
    } catch (error) {
      if (
        spec.allowMissingUsageEvents &&
        error instanceof Error &&
        /^no such table: usage_events$/i.test(error.message)
      ) {
        return { events: [] }
      }
      throw error
    }
    const events: UsageEvent[] = []
    for (const value of rows) {
      const row = spec.map ? spec.map(value) : (value as unknown as SqliteUsageRow)
      if (!row) {
        context.warn(`Skipped malformed ${spec.agent} SQLite row in ${source.path}`)
        continue
      }
      const timestamp = timestampOf(row.timestamp)
      const sessionId = String(row.session_id ?? "")
      if (timestamp === null || !sessionId || row.id === undefined) {
        context.warn(`Skipped malformed ${spec.agent} SQLite row in ${source.path}`)
        continue
      }
      const agent = spec.attribute?.(row) ?? spec.agent
      const costValue = typeof row.cost_usd === "string" ? Number(row.cost_usd) : row.cost_usd
      const cost = typeof costValue === "number" && Number.isFinite(costValue) ? costValue : null
      const durationValue =
        typeof row.duration_ms === "string" ? Number(row.duration_ms) : row.duration_ms
      const duration =
        typeof durationValue === "number" && Number.isFinite(durationValue) ? durationValue : null
      events.push({
        id: eventId(agent, source.path, String(row.id)),
        agent,
        provider: typeof row.provider === "string" && row.provider.trim() ? row.provider : null,
        model: typeof row.model === "string" && row.model.trim() ? row.model : null,
        sessionId,
        project: typeof row.project === "string" && row.project.trim() ? row.project : null,
        timestamp,
        localDate: localDateOf(timestamp, context.timezone),
        tokens: {
          input: tokenCount(row.input_tokens),
          output: tokenCount(row.output_tokens),
          cacheRead: tokenCount(row.cache_read_tokens),
          cacheWrite: tokenCount(row.cache_write_tokens),
          reasoning: tokenCount(row.reasoning_tokens),
        },
        costUsd: cost,
        costSource: cost === null ? "unpriced" : "reported",
        durationMs: duration,
        dedupKey:
          typeof row.dedup_key === "string" && row.dedup_key.trim() ? row.dedup_key : null,
        sourcePath: source.path,
      })
    }
    return { events }
  } finally {
    db.close()
  }
}

export function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

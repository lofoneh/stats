import { join } from "node:path"
import type { TokenBreakdown } from "../../usage/types"
import { tokenCount } from "../../usage/parse"
import { envPath } from "../types"
import { fileAdapter } from "./shared/factory"
import type { EventFields, JsonRecord } from "./shared/json"
import {
  encodedProject,
  hasTokens,
  nested,
  number,
  object,
  parseJsonl,
  string,
  timestamp,
  usage,
} from "./shared/json"

/** xAI reports cost in ticks: 1 USD = 10^10 ticks. */
const USD_TICKS_PER_DOLLAR = 10_000_000_000

export const grokBuildAdapter = fileAdapter({
  id: "grok-build",
  label: "Grok Build",
  version: 4,
  roots: (context) => [
    join(
      envPath(context.env, "GROK_HOME") ?? join(context.home, ".grok"),
      "sessions"
    ),
  ],
  file: (name) => name === "updates.jsonl",
  parse: async (source, context) => {
    let priorTotal = 0
    const project = encodedProject(source.path, "sessions", true)
    return parseJsonl({
      agent: "grok-build",
      source,
      context,
      record(row, index, state) {
        const update = nested(row, "params", "update") ?? row
        if (string(update.sessionUpdate) !== "turn_completed") return null
        const raw = nested(update, "usage") ?? nested(row, "usage")
        if (!raw) return null
        const meta = nested(row, "params", "_meta") ?? nested(row, "_meta")
        const at = timestamp(
          meta ?? {},
          meta?.agentTimestampMs ?? update.timestamp ?? row.timestamp
        )
        if (at === null) return null
        const identity =
          string(update.prompt_id) ??
          string(meta?.eventId) ??
          string(update.id) ??
          string(row.id) ??
          `${at}:${index}`
        const events: EventFields[] = []
        const entries = grokUsageEntries(update, row, raw)
        for (const entry of entries) {
          if (!hasTokens(entry.tokens)) {
            if (entries.length !== 1) continue
            const total = number(raw.totalTokens ?? raw.total_tokens)
            if (total === null) continue
            entry.tokens.input = Math.max(0, Math.round(total) - priorTotal)
            priorTotal = Math.max(priorTotal, Math.round(total))
          }
          if (!hasTokens(entry.tokens)) continue
          const scoped = `${identity}:${entry.model ?? "unknown"}`
          events.push({
            identity: scoped,
            sessionId: state.sessionId,
            project,
            timestamp: at,
            tokens: entry.tokens,
            model: entry.model,
            provider: "xai",
            costUsd:
              entry.ticks !== null && entry.ticks >= 0
                ? entry.ticks / USD_TICKS_PER_DOLLAR
                : null,
            durationMs: entry.durationMs,
            dedupKey: `${state.sessionId}:${scoped}`,
          })
        }
        return events
      },
    })
  },
})

/**
 * Grok's inputTokens include cache, and reasoningTokens are already inside
 * outputTokens. Split those buckets so totals and catalog fallbacks do not
 * double-count. `cachedReadTokens` is Grok-specific; the shared helper
 * does not map it.
 */
function grokTokens(raw: JsonRecord): TokenBreakdown {
  const tokens = usage(raw)
  const cacheRead =
    tokenCount(raw.cachedReadTokens ?? raw.cached_read_tokens) ||
    tokens.cacheRead
  const cacheWrite = tokens.cacheWrite
  const reasoning = tokens.reasoning
  if (cacheRead > 0) tokens.input = Math.max(0, tokens.input - cacheRead)
  if (cacheWrite > 0) tokens.input = Math.max(0, tokens.input - cacheWrite)
  if (reasoning > 0) tokens.output = Math.max(0, tokens.output - reasoning)
  tokens.cacheRead = cacheRead
  return tokens
}

function grokUsageEntries(
  update: JsonRecord,
  row: JsonRecord,
  raw: JsonRecord,
): { model: string | null; tokens: TokenBreakdown; ticks: number | null; durationMs: number | null }[] {
  const models = object(raw.modelUsage)
  const named = models
    ? Object.entries(models).flatMap(([id, value]) => {
        const rec = object(value)
        if (!rec) return []
        return [
          {
            model: stripBuildSuffix(id),
            tokens: grokTokens(rec),
            ticks: number(rec.costUsdTicks ?? rec.cost_in_usd_ticks),
            durationMs: number(rec.apiDurationMs ?? raw.apiDurationMs ?? update.elapsed_ms),
          },
        ]
      })
    : []
  if (named.length > 0) return named
  const explicit = string(update.model) ?? string(row.model)
  return [
    {
      model: explicit ? stripBuildSuffix(explicit) : null,
      tokens: grokTokens(raw),
      ticks: number(raw.costUsdTicks ?? raw.cost_in_usd_ticks),
      durationMs: number(raw.apiDurationMs ?? update.elapsed_ms),
    },
  ]
}

/** CLI SKUs are `grok-4.6-build`; models.dev lists `grok-4.6`. */
function stripBuildSuffix(id: string): string {
  return id.replace(/-build$/u, "")
}

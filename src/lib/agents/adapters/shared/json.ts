import { basename, dirname } from "node:path"
import type { AgentId } from "../../registry"
import type { ParseContext, ParseOutput, UsageSource } from "../../types"
import type { TokenBreakdown, UsageEvent } from "../../../usage/types"
import {
  eventId,
  localDateOf,
  readJsonFile,
  readJsonl,
  timestampOf,
  tokenCount,
} from "../../../usage/parse"

export type JsonRecord = Record<string, unknown>

export interface EventFields {
  identity?: string | number
  provider?: string | null
  model?: string | null
  sessionId?: string
  project?: string | null
  timestamp: number
  tokens: TokenBreakdown
  costUsd?: number | null
  durationMs?: number | null
  dedupKey?: string | null
  estimatedTokens?: boolean
}

export interface JsonState {
  sessionId: string
  project: string | null
  provider: string | null
  model: string | null
}

interface JsonOptions {
  agent: AgentId
  source: UsageSource
  context: ParseContext
  record: (value: JsonRecord, index: number, state: JsonState) => EventFields | EventFields[] | null
}

export async function parseJsonl(options: JsonOptions): Promise<ParseOutput> {
  const read = await readJsonl(options.source.path, options.context.resumeOffset)
  if (read.malformed) options.context.warn(`${read.malformed} malformed JSONL record(s) skipped`)
  const state = initialState(options.source.path)
  const events: UsageEvent[] = []
  for (const [index, line] of read.lines.entries()) {
    const row = object(line.value)
    if (!row) {
      options.context.warn("non-object JSONL record skipped")
      continue
    }
    const fields = options.record(row, index, state)
    appendEvents(options, fields, index, events)
  }
  return { events, cursor: read.cursor }
}

export async function parseJson(
  options: JsonOptions & { values: (root: unknown) => unknown[] },
): Promise<ParseOutput> {
  const root = await readJsonFile(options.source.path)
  if (root === undefined) {
    options.context.warn("malformed JSON file skipped")
    return { events: [] }
  }
  const state = initialState(options.source.path)
  const events: UsageEvent[] = []
  for (const [index, value] of options.values(root).entries()) {
    const row = object(value)
    if (!row) continue
    const fields = options.record(row, index, state)
    appendEvents(options, fields, index, events)
  }
  return { events }
}

function fieldList(fields: EventFields | EventFields[] | null): EventFields[] {
  if (fields == null) return []
  return Array.isArray(fields) ? fields : [fields]
}

function appendEvents(
  options: JsonOptions,
  fields: EventFields | EventFields[] | null,
  index: number,
  events: UsageEvent[],
): void {
  const list = fieldList(fields)
  const multi = Array.isArray(fields)
  for (const [itemIndex, item] of list.entries()) {
    events.push(
      makeUsageEvent(
        options.agent,
        options.source,
        options.context,
        item,
        multi ? `${index}:${itemIndex}` : index,
      ),
    )
  }
}

export function object(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

export function nested(value: unknown, ...keys: string[]): JsonRecord | null {
  let current = object(value)
  for (const key of keys) current = current ? object(current[key]) : null
  return current
}

export function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

export function usage(value: unknown): TokenBreakdown {
  const row = object(value) ?? {}
  return {
    input: tokenCount(row.input ?? row.input_tokens ?? row.inputTokens ?? row.inputOther ?? row.input_other ?? row.prompt_tokens),
    output: tokenCount(row.output ?? row.output_tokens ?? row.outputTokens ?? row.completion_tokens),
    cacheRead: tokenCount(
      row.cacheRead ?? row.cache_read ?? row.cache_read_input_tokens ?? row.cacheReadTokens ?? row.cacheReadInputTokens ?? row.cached_tokens ?? row.cached,
    ),
    cacheWrite: tokenCount(
      row.cacheWrite ?? row.cache_write ?? row.cache_creation_input_tokens ?? row.cacheWriteTokens ?? row.cacheCreationInputTokens ?? row.cacheCreationTokens,
    ),
    reasoning: tokenCount(
      row.reasoning ?? row.reasoning_tokens ?? row.reasoningTokens ?? row.reasoning_output_tokens ?? row.thoughts ?? row.thinkingTokens,
    ),
  }
}

export function hasTokens(tokens: TokenBreakdown): boolean {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning > 0
}

export function timestamp(value: JsonRecord, fallback?: unknown): number | null {
  return timestampOf(value.timestamp ?? value.timestampMs ?? value.time ?? value.createdAt ?? fallback)
}

export function sessionFromPath(path: string): string {
  const name = basename(path).replace(/\.(jsonl(?:\.zstd)?|json)$/u, "")
  return name === "events" || name === "updates" || name === "session" ? basename(dirname(path)) : name
}

function initialState(path: string): JsonState {
  return { sessionId: sessionFromPath(path), project: null, provider: null, model: null }
}

export function makeUsageEvent(
  agent: AgentId,
  source: UsageSource,
  context: ParseContext,
  fields: EventFields,
  index: string | number,
): UsageEvent {
  const identity = fields.identity ?? `${fields.sessionId ?? sessionFromPath(source.path)}:${fields.timestamp}:${index}`
  const costUsd = fields.costUsd ?? null
  return {
    id: eventId(agent, source.path, identity),
    agent,
    provider: fields.provider ?? null,
    model: fields.model ?? null,
    sessionId: fields.sessionId ?? sessionFromPath(source.path),
    project: fields.project ?? null,
    timestamp: fields.timestamp,
    localDate: localDateOf(fields.timestamp, context.timezone),
    tokens: fields.tokens,
    costUsd,
    costSource: costUsd === null ? "unpriced" : "reported",
    durationMs: fields.durationMs ?? null,
    dedupKey: fields.dedupKey ?? null,
    sourcePath: source.path,
    ...(fields.estimatedTokens ? { estimatedTokens: true } : {}),
  }
}

export const recordOf = object
export const textOf = string
export const numberOf = number
export const fileSession = sessionFromPath
export const standardTokens = usage

export function encodedProject(
  path: string,
  rootName: string,
  decodePercent = false,
): string | null {
  const parts = path.split(/[\\/]/u)
  const root = parts.lastIndexOf(rootName)
  const encoded = root >= 0 ? parts[root + 1] : undefined
  if (!encoded || root + 1 >= parts.length - 1) return null
  if (encoded.startsWith("--") && encoded.endsWith("--")) {
    return `/${encoded.slice(2, -2).replaceAll("--", "/")}`
  }
  if (decodePercent && encoded.includes("%")) {
    try {
      return decodeURIComponent(encoded)
    } catch {
      return encoded
    }
  }
  return encoded.startsWith("-") ? encoded.replaceAll("-", "/") : encoded
}

interface UsageEventInput {
  agent: AgentId
  path: string
  identity: string | number
  provider: string | null
  model: string | null
  sessionId: string
  project: string | null
  timestamp: unknown
  timezone: string
  tokens: TokenBreakdown
  cost?: unknown
  durationMs?: number | null
  dedupKey?: string | null
  estimatedTokens?: boolean
}

export function usageEvent(input: UsageEventInput): UsageEvent | null {
  const time = timestampOf(input.timestamp)
  if (time === null) return null
  const cost = number(input.cost)
  return {
    id: eventId(input.agent, input.path, input.identity),
    agent: input.agent,
    provider: input.provider,
    model: input.model,
    sessionId: input.sessionId,
    project: input.project,
    timestamp: time,
    localDate: localDateOf(time, input.timezone),
    tokens: input.tokens,
    costUsd: cost === null || cost < 0 ? null : cost,
    costSource: cost === null || cost < 0 ? "unpriced" : "reported",
    durationMs: input.durationMs ?? null,
    dedupKey: input.dedupKey ?? null,
    sourcePath: input.path,
    ...(input.estimatedTokens ? { estimatedTokens: true } : {}),
  }
}

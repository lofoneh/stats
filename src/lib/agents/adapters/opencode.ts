import { basename, join } from "node:path"
import Database from "better-sqlite3"
import type { AgentAdapter, ParseContext, UsageSource } from "../types"
import { readJsonFile, walkFiles } from "../../usage/parse"
import { fileSession, numberOf, recordOf, standardTokens, textOf, usageEvent } from "./shared/json"

interface MessageRow {
  id: string
  session_id: string
  session_directory: string | null
  data: string
}

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  label: "OpenCode",
  version: 4,
  async *discover(context) {
    const data = context.env.XDG_DATA_HOME?.trim() || join(context.home, ".local", "share")
    const root = join(data, "opencode")
    for (const path of await walkFiles(root, (name) => name === "opencode.db" || /^opencode-.*\.db$/.test(name))) {
      yield { agent: "opencode", path, kind: "sqlite" }
    }
    for (const path of await walkFiles(join(root, "storage", "message"), (name) => name.endsWith(".json"))) {
      yield { agent: "opencode", path, kind: "legacy" }
    }
  },
  async parse(source, context) {
    return source.kind === "sqlite" ? parseDatabase(source, context) : parseLegacy(source, context)
  },
}

async function parseLegacy(source: UsageSource, context: ParseContext) {
  const message = recordOf(await readJsonFile(source.path))
  if (!message) {
    context.warn("malformed legacy message JSON")
    return { events: [] }
  }
  const event = makeEvent(message, source, context, textOf(message.id) ?? basename(source.path, ".json"), textOf(message.sessionID) ?? fileSession(source.path))
  return { events: event ? [event] : [] }
}

async function parseDatabase(source: UsageSource, context: ParseContext) {
  const db = new Database(source.path, { readonly: true, fileMustExist: true })
  try {
    // Modern databases carry a `session` table whose rows hold the workspace
    // directory; older databases only have `message`. Query accordingly.
    const hasSession = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session'").get()
    const rows = (
      hasSession
        ? db.prepare("SELECT m.id, m.session_id, s.directory AS session_directory, m.data FROM message m LEFT JOIN session s ON s.id = m.session_id")
        : db.prepare("SELECT id, session_id, NULL AS session_directory, data FROM message")
    ).all() as MessageRow[]
    const events = []
    for (const row of rows) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.data)
      } catch {
        context.warn("malformed message payload")
        continue
      }
      const message = recordOf(parsed)
      const event = message ? makeEvent(message, source, context, row.id, row.session_id, row.session_directory) : null
      if (event) events.push(event)
    }
    return { events }
  } finally {
    db.close()
  }
}

function makeEvent(
  message: Record<string, unknown>,
  source: UsageSource,
  context: ParseContext,
  identity: string,
  sessionId: string,
  sessionDirectory?: string | null,
) {
  const tokens = recordOf(message.tokens)
  const time = recordOf(message.time)
  if (message.role !== "assistant" || !tokens || !time) return null
  return usageEvent({
    agent: "opencode",
    path: source.path,
    identity,
    provider: textOf(message.providerID),
    model: normalizeModel(textOf(message.modelID)),
    sessionId,
    // Issue #6: opencode stores the workspace directory on the session row
    // (and historically in message.path.cwd), not on the message payload.
    project:
      textOf(sessionDirectory) ??
      textOf(recordOf(message.path)?.cwd) ??
      textOf(message.project),
    timestamp: time.created,
    timezone: context.timezone,
    tokens: standardTokens({
      ...tokens,
      cacheRead: numberOf(recordOf(tokens.cache)?.read),
      cacheWrite: numberOf(recordOf(tokens.cache)?.write),
    }),
    // OpenCode reports cost 0 when it had no pricing for the model
    // (subscription models included); only a positive cost is authoritative.
    cost: (numberOf(message.cost) ?? 0) > 0 ? message.cost : null,
    durationMs: numberOf(time.completed) === null || numberOf(time.created) === null ? null : Math.max((numberOf(time.completed) ?? 0) - (numberOf(time.created) ?? 0), 0),
    dedupKey: identity,
  })
}

/**
 * OpenCode's Antigravity routing prefixes the underlying Gemini model id and
 * may append a reasoning tier ("antigravity-gemini-3-pro-high"); the pricing
 * catalog only knows the base id.
 */
function normalizeModel(model: string | null): string | null {
  if (!model?.startsWith("antigravity-")) return model
  return model.slice("antigravity-".length).replace(/-(?:low|medium|high|xhigh)$/u, "")
}

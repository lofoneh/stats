import { access } from "node:fs/promises"
import { join } from "node:path"
import type { AgentAdapter, UsageSource } from "../types"
import { envPath } from "../types"
import { walkFiles } from "../../usage/parse"
import { parseSqliteUsage } from "./shared/sqlite"

export const antigravityCliAdapter: AgentAdapter = {
  id: "antigravity-cli",
  label: "Antigravity CLI",
  version: 1,
  async *discover(context) {
    const gemini = envPath(context.env, "GEMINI_CLI_HOME") ?? join(context.home, ".gemini")
    const roots = [join(gemini, "antigravity-cli", "conversations"), ...context.extraRoots]
    for (const root of roots) {
      for (const path of await walkFiles(root, (name) => name.endsWith(".db"))) {
        try {
          await access(path)
          yield { agent: "antigravity-cli", path, kind: "sqlite" } satisfies UsageSource
        } catch {
          // Files can disappear while discovery runs.
        }
      }
    }
  },
  parse(source, context) {
    return parseSqliteUsage(source, context, {
      agent: "antigravity-cli",
      allowMissingUsageEvents: true,
      query: `
        SELECT id, conversation_id AS session_id, timestamp, provider, model,
          project, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, reasoning_tokens, cost_usd, duration_ms,
          id AS dedup_key
        FROM usage_events
      `,
    })
  },
}

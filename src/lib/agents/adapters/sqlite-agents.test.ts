import Database from "better-sqlite3"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import type { AgentAdapter, DiscoveryContext, UsageSource } from "../types"
import { antigravityCliAdapter } from "./antigravity-cli"
import { crushAdapter } from "./crush"
import { gooseAdapter } from "./goose"
import { hermesAdapter } from "./hermes"
import { kiroAdapter } from "./kiro"
import { devinCliAdapter, kiloCliAdapter, mimoCodeAdapter, octofriendAdapter, zedAdapter } from "./sqlite-agents"
import { zcodeAdapter } from "./zcode"
import { parseSqliteUsage } from "./shared/sqlite"

const context = (home: string, env: Record<string, string | undefined> = {}): DiscoveryContext => ({ platform: "linux", home, env, extraRoots: [] })
const parseContext = { timezone: "UTC", warn: (_message: string) => {} }

async function sources(adapter: AgentAdapter, discovery: DiscoveryContext): Promise<UsageSource[]> {
  const found: UsageSource[] = []
  for await (const source of adapter.discover(discovery)) found.push(source)
  return found
}

async function makeUsageDb(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const db = new Database(path)
  db.exec(`CREATE TABLE usage_events (id TEXT, session_id TEXT, timestamp TEXT, provider TEXT, model TEXT, project TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, cost_usd REAL, duration_ms INTEGER, dedup_key TEXT)`)
  db.prepare("INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("m1", "s1", "2026-08-01T12:00:00Z", "anthropic", "claude", "/work", 10, 20, 3, 4, 5, 0.25, 600, "stable")
  db.close()
}

describe("SQLite usage adapters", () => {
  it.each([
    [kiloCliAdapter, [".local", "share", "kilo", "kilo.db"]],
    [zedAdapter, [".local", "share", "zed", "threads", "threads.db"]],
    [devinCliAdapter, [".local", "share", "devin", "cli", "sessions.db"]],
    [octofriendAdapter, [".local", "share", "octofriend", "sqlite.db"]],
  ] as const)("normalizes token and cost columns", async (adapter, parts) => {
    const home = await mkdtemp(join(tmpdir(), "stats-sqlite-"))
    const path = join(home, ...parts)
    await makeUsageDb(path)
    const [source] = await sources(adapter, context(home))
    const output = await adapter.parse(source!, parseContext)
    expect(output.events[0]).toMatchObject({ tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, reasoning: 5 }, costUsd: 0.25, costSource: "reported", dedupKey: "stable" })
  })

  it("re-attributes Synthetic Octofriend rows", async () => {
    const home = await mkdtemp(join(tmpdir(), "stats-octo-"))
    const path = join(home, ".local", "share", "octofriend", "sqlite.db")
    await makeUsageDb(path)
    const db = new Database(path)
    db.prepare("UPDATE usage_events SET provider = ?, model = ?").run("synthetic", "hf:model")
    db.close()
    const [source] = await sources(octofriendAdapter, context(home))
    expect((await octofriendAdapter.parse(source!, parseContext)).events[0]?.agent).toBe("synthetic")
  })

  it("prefers reported Hermes cost and discovers profiles", async () => {
    const home = await mkdtemp(join(tmpdir(), "stats-hermes-"))
    const root = join(home, "custom")
    for (const path of [join(root, "state.db"), join(root, "profiles", "work", "state.db")]) {
      await mkdir(dirname(path), { recursive: true })
      const db = new Database(path)
      db.exec(`CREATE TABLE sessions (id TEXT, started_at TEXT, provider TEXT, model TEXT, project TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, actual_cost_usd REAL, estimated_cost_usd REAL, duration_ms INTEGER)`)
      db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s1", "2026-08-01T00:00:00Z", "anthropic", "claude", "/work", 10, 2, 1, 1, 0, 0.2, 0.5, 100)
      db.close()
    }
    const found = await sources(hermesAdapter, context(home, { HERMES_HOME: root }))
    expect(found).toHaveLength(2)
    expect((await hermesAdapter.parse(found[0]!, parseContext)).events[0]?.costUsd).toBe(0.2)
  })

  it("extracts Goose model configuration", async () => {
    const home = await mkdtemp(join(tmpdir(), "stats-goose-"))
    const root = join(home, "goose")
    const path = join(root, "sessions.db")
    await mkdir(root, { recursive: true })
    const db = new Database(path)
    db.exec(`CREATE TABLE sessions (id TEXT, created_at TEXT, provider_name TEXT, model_config_json TEXT, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, total_cost REAL, duration_ms INTEGER)`)
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s1", "2026-08-01T00:00:00Z", "openai", '{"model":"gpt-5"}', 11, 7, 2, 0.1, 50)
    db.close()
    const [source] = await sources(gooseAdapter, context(home, { GOOSE_PATH_ROOT: root }))
    expect((await gooseAdapter.parse(source!, parseContext)).events[0]).toMatchObject({ model: "gpt-5", tokens: { input: 11, output: 7, reasoning: 2 } })
  })

  it("extracts MiMo JSON token data", async () => {
    const home = await mkdtemp(join(tmpdir(), "stats-mimo-"))
    const path = join(home, ".local", "share", "mimocode", "mimocode.db")
    await mkdir(dirname(path), { recursive: true })
    const db = new Database(path)
    db.exec("CREATE TABLE session (id TEXT, directory TEXT); CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)")
    db.prepare("INSERT INTO session VALUES (?, ?)").run("s1", "/work")
    db.prepare("INSERT INTO message VALUES (?, ?, ?)").run("m1", "s1", JSON.stringify({ role: "assistant", modelID: "mimo", providerID: "xiaomi", cost: 0.02, tokens: { input: 8, output: 4, reasoning: 2, cache: { read: 3, write: 1 } }, time: { created: 1780410897000, completed: 1780410898000 }, agent: "micode" }))
    db.close()
    const [source] = await sources(mimoCodeAdapter, context(home))
    expect((await mimoCodeAdapter.parse(source!, parseContext)).events[0]).toMatchObject({ project: "/work", durationMs: 1000, tokens: { input: 8, output: 4, cacheRead: 3, cacheWrite: 1, reasoning: 2 } })
  })

  it("skips Antigravity conversation databases that have no usage table", async () => {
    const home = await mkdtemp(join(tmpdir(), "stats-ag-"))
    const path = join(home, "gem", "antigravity-cli", "conversations", "one.db")
    await mkdir(dirname(path), { recursive: true })
    const db = new Database(path)
    db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY)")
    db.close()
    const [source] = await sources(antigravityCliAdapter, context(home, { GEMINI_CLI_HOME: join(home, "gem") }))
    const output = await antigravityCliAdapter.parse(source, parseContext)
    expect(output.events).toEqual([])
    await expect(
      parseSqliteUsage(source, parseContext, {
        agent: "kilo-cli",
        query: "SELECT * FROM usage_events",
      }),
    ).rejects.toThrow("no such table: usage_events")
  })

  it("discovers Antigravity, Kiro, and ZCode sources", async () => {
    const home = await mkdtemp(join(tmpdir(), "stats-mixed-"))
    const antigravity = join(home, "gem", "antigravity-cli", "conversations", "one.db")
    await makeUsageDb(antigravity)
    expect((await sources(antigravityCliAdapter, context(home, { GEMINI_CLI_HOME: join(home, "gem") })))[0]?.path).toBe(antigravity)
    const kiro = join(home, ".kiro", "sessions", "cli", "one.jsonl")
    await mkdir(dirname(kiro), { recursive: true })
    await writeFile(kiro, '{"id":"s1","timestamp":"2026-08-01T00:00:00Z","usage":{"input":3}}\n')
    expect((await sources(kiroAdapter, context(home)))[0]?.kind).toBe("jsonl")
    const zcode = join(home, ".zcode", "projects", "one.jsonl")
    await mkdir(dirname(zcode), { recursive: true })
    await writeFile(zcode, '{"id":"s1","timestamp":"2026-08-01T00:00:00Z","tokens":{"input":4}}\n')
    expect((await sources(zcodeAdapter, context(home)))[0]?.kind).toBe("jsonl")
  })

  it("loads root Crush costs with zero tokens", async () => {
    const home = await mkdtemp(join(tmpdir(), "stats-crush-"))
    const root = join(home, ".local", "share", "crush")
    const project = join(root, "project")
    await mkdir(project, { recursive: true })
    await writeFile(join(root, "projects.json"), JSON.stringify([project]))
    const db = new Database(join(project, "crush.db"))
    db.exec("CREATE TABLE sessions (id TEXT, created_at TEXT, project TEXT, total_cost REAL, duration_ms INTEGER, parent_id TEXT)")
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)").run("s1", "2026-08-01T00:00:00Z", "/work", 1.5, 50, null)
    db.close()
    const [source] = await sources(crushAdapter, context(home))
    expect((await crushAdapter.parse(source!, parseContext)).events[0]).toMatchObject({ model: "session-total", costUsd: 1.5, tokens: { input: 0, output: 0 } })
  })
})

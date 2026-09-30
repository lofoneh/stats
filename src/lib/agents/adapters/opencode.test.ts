import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import Database from "better-sqlite3"
import { describe, expect, test, vi } from "vitest"
import type { DiscoveryContext, UsageSource } from "../types"
import { opencodeAdapter } from "./opencode"

async function discover(home: string, env: Record<string, string | undefined> = {}): Promise<UsageSource[]> {
  const context: DiscoveryContext = { platform: "darwin", home, env, extraRoots: [] }
  const sources = []
  for await (const source of opencodeAdapter.discover(context)) sources.push(source)
  return sources
}

const parseContext = () => ({ timezone: "UTC", warn: vi.fn() })
const message = { id: "msg-1", sessionID: "session", role: "assistant", modelID: "claude-sonnet", providerID: "anthropic", cost: 0.3, tokens: { input: 12, output: 5, reasoning: 2, cache: { read: 4, write: 1 } }, time: { created: 1767312000000, completed: 1767312001000 }, content: "secret transcript" }

describe("OpenCode", () => {
  test("reads channel databases and closes read-only handles", async () => {
    const home = await mkdtemp(join(tmpdir(), "stats-opencode-"))
    const data = join(home, "data")
    const path = join(data, "opencode", "opencode-beta.db")
    await mkdir(dirname(path), { recursive: true })
    const db = new Database(path)
    db.exec("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)")
    db.prepare("INSERT INTO message VALUES (?, ?, ?)").run("msg-1", "session", JSON.stringify(message))
    db.prepare("INSERT INTO message VALUES (?, ?, ?)").run("bad", "session", "{")
    db.close()

    const source = (await discover(home, { XDG_DATA_HOME: data })).find((item) => item.kind === "sqlite")!
    const ctx = parseContext()
    const result = await opencodeAdapter.parse(source, ctx)
    expect(result.events[0]).toMatchObject({ tokens: { input: 12, output: 5, cacheRead: 4, cacheWrite: 1, reasoning: 2 }, costUsd: 0.3, costSource: "reported", dedupKey: "msg-1", durationMs: 1000 })
    expect(JSON.stringify(result.events)).not.toContain("secret transcript")
    expect(ctx.warn).toHaveBeenCalledOnce()
    new Database(path).close()
  })

  test("resolves project from the session row directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "stats-opencode-project-"))
    const path = join(home, ".local", "share", "opencode", "opencode.db")
    await mkdir(dirname(path), { recursive: true })
    const db = new Database(path)
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)")
    db.exec("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)")
    db.prepare("INSERT INTO session VALUES (?, ?)").run("ses-1", "/home/dev/app")
    db.prepare("INSERT INTO message VALUES (?, ?, ?)").run(
      "msg-1",
      "ses-1",
      JSON.stringify({ ...message, path: { cwd: "/elsewhere" }, cost: 0 }),
    )
    db.close()

    const data = join(home, ".local", "share")
    const source = (await discover(home, { XDG_DATA_HOME: data })).find((item) => item.kind === "sqlite")!
    const event = (await opencodeAdapter.parse(source, parseContext())).events[0]
    expect(event?.project).toBe("/home/dev/app")
  })

  test("falls back to message cwd when the session row is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "stats-opencode-cwd-"))
    const path = join(home, ".local", "share", "opencode", "opencode.db")
    await mkdir(dirname(path), { recursive: true })
    const db = new Database(path)
    db.exec("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)")
    db.prepare("INSERT INTO message VALUES (?, ?, ?)").run("msg-1", "session", JSON.stringify({ ...message, path: { cwd: "/work/stuff" } }))
    db.close()

    const data = join(home, ".local", "share")
    const source = (await discover(home, { XDG_DATA_HOME: data })).find((item) => item.kind === "sqlite")!
    const event = (await opencodeAdapter.parse(source, parseContext())).events[0]
    expect(event?.project).toBe("/work/stuff")
  })

  test("legacy JSON uses the same stable message dedup key", async () => {
    const home = await mkdtemp(join(tmpdir(), "stats-opencode-legacy-"))
    const path = join(home, ".local", "share", "opencode", "storage", "message", "session", "msg-1.json")
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(message))
    const source = (await discover(home)).find((item) => item.kind === "legacy")!
    const event = (await opencodeAdapter.parse(source, parseContext())).events[0]
    expect(event?.dedupKey).toBe("msg-1")
    expect(event?.id).toHaveLength(32)
  })

  test("treats a reported zero cost as unpriced and reduces antigravity ids", async () => {
    const home = await mkdtemp(join(tmpdir(), "stats-opencode-free-"))
    const path = join(home, ".local", "share", "opencode", "storage", "message", "session", "msg-0.json")
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ ...message, id: "msg-0", cost: 0, modelID: "antigravity-gemini-3-pro-high" }))
    const source = (await discover(home)).find((item) => item.kind === "legacy")!
    const event = (await opencodeAdapter.parse(source, parseContext())).events[0]
    expect(event).toMatchObject({ costUsd: null, costSource: "unpriced", model: "gemini-3-pro" })
  })
})

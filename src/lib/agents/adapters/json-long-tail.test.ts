import { promises as fs } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import type { AgentAdapter, DiscoveryContext, UsageSource } from "../types"
import { grokBuildAdapter } from "./grok-build"
import { commandCodeAdapter } from "./command-code"
import { kimiAdapter } from "./kimi"
import { senpiAdapter } from "./senpi"

async function tempHome(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "telemetry-adapter-"))
}

function discovery(home: string, env: Record<string, string | undefined> = {}): DiscoveryContext {
  return { platform: "linux", home, env, extraRoots: [] }
}

async function paths(adapter: AgentAdapter, context: DiscoveryContext): Promise<UsageSource[]> {
  const found: UsageSource[] = []
  for await (const source of adapter.discover(context)) found.push(source)
  return found
}

const parseContext = { timezone: "UTC", warn: (_message: string) => undefined }

describe("JSON long-tail adapters", () => {
  it("parses pi-format usage and skips malformed lines", async () => {
    const home = await tempHome()
    const root = join(home, ".senpi", "agent", "sessions")
    await fs.mkdir(root, { recursive: true })
    const path = join(root, "session.jsonl")
    await fs.writeFile(path, [
      JSON.stringify({ type: "session", id: "session-1", cwd: "/repo" }),
      "not json",
      JSON.stringify({ type: "message", id: "msg-1", timestamp: "2026-08-01T00:00:00Z", message: { role: "assistant", model: "kimi", provider: "senpi", usage: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2 } } }),
      "",
    ].join("\n"))
    const warnings: string[] = []
    const result = await senpiAdapter.parse((await paths(senpiAdapter, discovery(home)))[0]!, { timezone: "UTC", warn: (message) => warnings.push(message) })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.tokens).toEqual({ input: 10, output: 4, cacheRead: 3, cacheWrite: 2, reasoning: 0 })
    expect(result.events[0]?.dedupKey).toBe("session-1:msg-1")
    expect(warnings).toHaveLength(1)
  })

  it("converts Grok cumulative totals to positive deltas", async () => {
    const home = await tempHome()
    const root = join(home, ".grok", "sessions", "work", "session")
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(join(root, "updates.jsonl"), [
      JSON.stringify({ id: "one", timestamp: 1785542400000, params: { update: { sessionUpdate: "turn_completed", usage: { totalTokens: 100 } } } }),
      JSON.stringify({ id: "two", timestamp: 1785542401000, params: { update: { sessionUpdate: "turn_completed", usage: { totalTokens: 145 } } } }),
      JSON.stringify({ id: "three", timestamp: 1785542402000, params: { update: { sessionUpdate: "turn_completed", usage: { totalTokens: 120 } } } }),
      "",
    ].join("\n"))
    expect(grokBuildAdapter.version).toBe(4)
    const result = await grokBuildAdapter.parse((await paths(grokBuildAdapter, discovery(home)))[0], parseContext)
    expect(result.events.map((event) => event.tokens.input)).toEqual([100, 45])
  })

  it("reads Grok turn_completed model, cache, reasoning, and billed ticks", async () => {
    const home = await tempHome()
    const root = join(home, ".grok", "sessions", encodeURIComponent("/work/app"), "session")
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(
      join(root, "updates.jsonl"),
      `${JSON.stringify({
        timestamp: 1787942522,
        method: "_x.ai/session/update",
        params: {
          sessionId: "session",
          update: {
            sessionUpdate: "turn_completed",
            prompt_id: "prompt-1",
            usage: {
              inputTokens: 1000,
              outputTokens: 250,
              totalTokens: 1250,
              cachedReadTokens: 400,
              cacheCreationTokens: 50,
              reasoningTokens: 80,
              apiDurationMs: 1200,
              costUsdTicks: 1_286_002_400,
              modelUsage: {
                "grok-4.6-build": {
                  inputTokens: 1000,
                  outputTokens: 250,
                  totalTokens: 1250,
                  cachedReadTokens: 400,
                  cacheCreationTokens: 50,
                  reasoningTokens: 80,
                  costUsdTicks: 1_286_002_400,
                },
              },
            },
          },
          _meta: { eventId: "event-1", agentTimestampMs: 1787942522235 },
        },
      })}\n`,
    )
    const result = await grokBuildAdapter.parse((await paths(grokBuildAdapter, discovery(home)))[0], parseContext)
    expect(result.events).toHaveLength(1)
    const event = result.events[0]
    expect(event.model).toBe("grok-4.6")
    expect(event.project).toBe("/work/app")
    expect(event.provider).toBe("xai")
    expect(event.tokens).toEqual({ input: 550, output: 170, cacheRead: 400, cacheWrite: 50, reasoning: 80 })
    expect(event.costUsd).toBeCloseTo(0.12860024)
    expect(event.costSource).toBe("reported")
    expect(event.durationMs).toBe(1200)
    expect(event.timestamp).toBe(1787942522235)
    expect(event.dedupKey).toBe("session:prompt-1:grok-4.6")
  })

  it("keeps only turn_completed when an earlier update shares prompt_id", async () => {
    const home = await tempHome()
    const root = join(home, ".grok", "sessions", "work", "session")
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(join(root, "updates.jsonl"), [
      JSON.stringify({
        timestamp: 1785542400000,
        params: {
          update: {
            sessionUpdate: "agent_thought_chunk",
            prompt_id: "prompt-1",
            usage: { inputTokens: 10, outputTokens: 1, costUsdTicks: 100 },
          },
        },
      }),
      JSON.stringify({
        timestamp: 1785542401000,
        params: {
          update: {
            sessionUpdate: "turn_completed",
            prompt_id: "prompt-1",
            usage: {
              inputTokens: 1000,
              outputTokens: 20,
              costUsdTicks: 1_000_000_000,
              modelUsage: { "grok-4.6-build": { inputTokens: 1000, outputTokens: 20, costUsdTicks: 1_000_000_000 } },
            },
          },
        },
      }),
      "",
    ].join("\n"))
    const result = await grokBuildAdapter.parse((await paths(grokBuildAdapter, discovery(home)))[0], parseContext)
    expect(result.events).toHaveLength(1)
    expect(result.events[0].tokens).toEqual({ input: 1000, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
    expect(result.events[0].costUsd).toBeCloseTo(0.1)
  })

  it("emits one Grok event per modelUsage entry", async () => {
    const home = await tempHome()
    const root = join(home, ".grok", "sessions", "work", "session")
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(
      join(root, "updates.jsonl"),
      `${JSON.stringify({
        timestamp: 1785542400000,
        params: {
          update: {
            sessionUpdate: "turn_completed",
            prompt_id: "prompt-2",
            usage: {
              inputTokens: 30,
              outputTokens: 12,
              costUsdTicks: 3_000_000_000,
              modelUsage: {
                "grok-4.5-build": { inputTokens: 10, outputTokens: 4, costUsdTicks: 1_000_000_000 },
                "grok-4.6-build": { inputTokens: 20, outputTokens: 8, costUsdTicks: 2_000_000_000 },
              },
            },
          },
        },
      })}\n`,
    )
    const result = await grokBuildAdapter.parse((await paths(grokBuildAdapter, discovery(home)))[0], parseContext)
    expect(result.events.map((event) => ({ model: event.model, tokens: event.tokens.input, cost: event.costUsd, key: event.dedupKey }))).toEqual([
      { model: "grok-4.5", tokens: 10, cost: 0.1, key: "session:prompt-2:grok-4.5" },
      { model: "grok-4.6", tokens: 20, cost: 0.2, key: "session:prompt-2:grok-4.6" },
    ])
  })

  it("marks Command Code message-length estimates", async () => {
    const home = await tempHome()
    const root = join(home, ".commandcode", "projects", "repo")
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(join(root, "session.jsonl"), `${JSON.stringify({ id: "a", role: "assistant", timestamp: 1785542400000, messageLength: 17 })}\n`)
    const result = await commandCodeAdapter.parse((await paths(commandCodeAdapter, discovery(home)))[0]!, parseContext)
    expect(result.events[0]?.tokens.output).toBe(5)
    expect(result.events[0]?.estimatedTokens).toBe(true)
    expect(result.events[0]?.costSource).toBe("unpriced")
  })

  it("uses KIMI_CODE_HOME and keeps stable dedup identity", async () => {
    const home = await tempHome()
    const override = join(home, "kimi-home")
    const root = join(override, "sessions")
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(join(root, "wire.jsonl"), `${JSON.stringify({ type: "usage.record", id: "usage-1", timestamp: 1785542400000, usage: { inputOther: 8, output: 2, inputCacheRead: 4 } })}\n`)
    const source = (await paths(kimiAdapter, discovery(home, { KIMI_CODE_HOME: override })))[0]!
    const first = await kimiAdapter.parse(source, parseContext)
    const second = await kimiAdapter.parse(source, parseContext)
    expect(first.events[0]?.tokens).toEqual({ input: 8, output: 2, cacheRead: 4, cacheWrite: 0, reasoning: 0 })
    expect(first.events[0]?.dedupKey).toBe(second.events[0]?.dedupKey)
  })
})

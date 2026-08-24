import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { closeDb, getDb, insertEvents } from "../db/client.server"
import type { UsageEvent } from "../usage/types"
import { filterFromUrl } from "./filter.server"
import {
  getBreakdown,
  getOverview,
  getSessions,
  getTimeSeries,
} from "./queries.server"

let dataDir: string

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()

function event(overrides: Partial<UsageEvent> & { id: string }): UsageEvent {
  return {
    agent: "claude-code",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    sessionId: "sess-a",
    project: "proj",
    timestamp: NOW - DAY,
    localDate: "2026-08-18",
    tokens: {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    },
    costUsd: 0.5,
    costSource: "reported",
    durationMs: null,
    dedupKey: null,
    sourcePath: "/tmp/fixture",
    ...overrides,
  }
}

describe("analytics queries", () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "ts-queries-"))
    process.env.TELEMETRY_STATS_DATA_DIR = dataDir
    insertEvents(getDb(), [
      event({ id: "e1" }),
      event({
        id: "e2",
        agent: "codex",
        provider: "openai",
        model: "gpt-5",
        sessionId: "sess-b",
        costUsd: null,
        costSource: "unpriced",
      }),
      event({
        id: "e3",
        agent: "freebuff",
        sessionId: "sess-c",
        estimatedTokens: true,
        costUsd: null,
        costSource: "unpriced",
        timestamp: NOW - 100 * DAY,
        localDate: "2026-05-10",
      }),
    ])
  })

  afterEach(() => {
    closeDb()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it("computes overview totals with unpriced and estimated separation", () => {
    const overview = getOverview({ range: "all" })
    expect(overview.events).toBe(3)
    expect(overview.sessions).toBe(3)
    expect(overview.tokens.total).toBe(450)
    expect(overview.pricedCostUsd).toBeCloseTo(0.5)
    expect(overview.unpricedEventCount).toBe(2)
    expect(overview.unpricedTokens).toBe(300)
    expect(overview.hasEstimatedTokens).toBe(true)
  })

  it("applies range and agent filters", () => {
    const recent = getOverview({ range: "30d" })
    expect(recent.events).toBe(2)
    const codexOnly = getOverview({ range: "all", agents: ["codex"] })
    expect(codexOnly.events).toBe(1)
    expect(codexOnly.pricedCostUsd).toBe(0)
  })

  it("zero-fills time series buckets between events", () => {
    const series = getTimeSeries({ range: "7d" })
    // 7d uses hourly buckets per the API contract.
    expect(series.bucketMs).toBe(60 * 60 * 1000)
    // Buckets span from the event a day ago to now, all hours present.
    expect(series.points.length).toBeGreaterThanOrEqual(24)
    const active = series.points.filter((point) => point.tokens > 0)
    expect(active).toHaveLength(1)
    expect(active[0].byAgent["claude-code"]?.tokens).toBe(150)
    expect(active[0].byAgent.codex?.tokens).toBe(150)
  })

  it("breaks down by agent with share and estimation flags", () => {
    const rows = getBreakdown({ range: "all" }, "agent")
    expect(rows).toHaveLength(3)
    expect(rows[0].tokenShare).toBeCloseTo(1 / 3)
    const freebuff = rows.find((row) => row.key === "freebuff")
    expect(freebuff?.hasEstimatedTokens).toBe(true)
    expect(freebuff?.label).toBe("Freebuff")
  })

  it("aggregates project request and cache metrics", () => {
    insertEvents(getDb(), [
      event({
        id: "project-1",
        project: "/work/project",
        tokens: {
          input: 100,
          output: 50,
          cacheRead: 300,
          cacheWrite: 0,
          reasoning: 0,
        },
      }),
      event({
        id: "project-2",
        project: "/work/project",
        tokens: {
          input: 100,
          output: 50,
          cacheRead: 100,
          cacheWrite: 0,
          reasoning: 0,
        },
      }),
      event({
        id: "project-3",
        project: "/work/project",
        tokens: {
          input: 0,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
        },
      }),
    ])

    const project = getBreakdown({ range: "all" }, "project").find(
      (row) => row.key === "/work/project"
    )
    expect(project).toMatchObject({ events: 3 })
    expect(project?.cacheReadShare).toBeCloseTo(2 / 3)
  })

  it("pages sessions newest first without content fields", () => {
    const page = getSessions({ range: "all" }, 1, 2)
    expect(page.total).toBe(3)
    expect(page.sessions).toHaveLength(2)
    expect(page.sessions[0].lastTimestamp).toBeGreaterThanOrEqual(
      page.sessions[1].lastTimestamp
    )
    for (const session of page.sessions) {
      expect(Object.keys(session)).not.toContain("text")
      expect(Object.keys(session)).not.toContain("content")
    }
  })

  it("parses URL filters with explicit dates overriding range", () => {
    const url = new URL(
      "http://localhost/api/overview?range=24h&agent=codex&agent=bogus&from=2026-05-01&to=2026-05-31"
    )
    const filter = filterFromUrl(url)
    expect(filter.agents).toEqual(["codex"])
    expect(filter.from).toBe("2026-05-01")
    const overview = getOverview({ ...filter, agents: undefined })
    // Only the May event falls inside the explicit window despite range=24h.
    expect(overview.events).toBe(1)
  })
})

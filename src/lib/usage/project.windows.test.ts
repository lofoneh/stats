import type * as fs from "node:fs"
import type * as os from "node:os"
import { describe, expect, it, vi } from "vitest"

// Windows project shapes, checked on every platform against a fake filesystem
// so the suite does not depend on the machine it runs on.
const existing = vi.hoisted(
  () =>
    new Map(
      [
        "C:/",
        "C:/Users",
        "C:/Users/me",
        "C:/Users/me/dev",
        "C:/Users/me/dev/telemetry.dev",
        "C:/collabs",
        "C:/collabs/oss",
        "C:/collabs/oss/telemetry",
        "C:/collabs/win-transport-services",
        "D:/",
        "D:/work",
        "D:/work/roadmap-sync",
        "C:/collabs/roadmap",
        "C:/collabs/roadmap-sync",
        "C:/collabs/roadmap-sync/app",
        "//file-server/team-share/",
        "//file-server/team-share/win-transport-services",
      ].map((path) => [path.toLowerCase(), path.replaceAll("/", "\\")])
    )
)

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: () => "C:\\Users\\me",
  platform: () => "win32",
}))

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  existsSync: (path: string) =>
    existing.has(path.replaceAll("\\", "/").toLowerCase()) ||
    path === "C:/collabs/file",
  statSync: (path: string) => {
    if (path.includes("denied")) throw new Error("EACCES")
    const directory = existing.has(path.replaceAll("\\", "/").toLowerCase())
    return directory || path === "C:/collabs/file"
      ? { isDirectory: () => directory }
      : undefined
  },
  realpathSync: {
    native: (path: string) => {
      const resolved = existing.get(path.replaceAll("\\", "/").toLowerCase())
      if (!resolved) throw new Error("ENOENT")
      return resolved
    },
  },
}))

const { canonicalProject, displayProject } = await import("./project.server")

describe("canonicalProject on Windows paths", () => {
  it("keeps a raw drive path that exists", () => {
    expect(canonicalProject("C:\\collabs\\oss\\telemetry")).toBe(
      "C:\\collabs\\oss\\telemetry"
    )
    expect(canonicalProject("C:/collabs/oss/telemetry")).toBe(
      "C:\\collabs\\oss\\telemetry"
    )
  })

  it("decodes a Claude Code project directory name", () => {
    expect(canonicalProject("C--collabs-oss-telemetry")).toBe(
      "C:\\collabs\\oss\\telemetry"
    )
  })

  it("decodes an Oh My Pi or Pi session directory name", () => {
    expect(canonicalProject("/C/collabs-win-transport-services")).toBe(
      "C:\\collabs\\win-transport-services"
    )
  })

  it("maps every agent's shape of one directory to the same project", () => {
    const shapes = [
      "C:\\collabs\\win-transport-services",
      "C--collabs-win-transport-services",
      "/C/collabs-win-transport-services",
    ]
    expect(new Set(shapes.map(canonicalProject))).toEqual(
      new Set(["C:\\collabs\\win-transport-services"])
    )
  })

  it("repairs dash-encoded names on other drives", () => {
    expect(canonicalProject("D--work-roadmap-sync")).toBe(
      "D:\\work\\roadmap-sync"
    )
  })

  it("deduplicates directory case and drive-letter variants", () => {
    expect(canonicalProject("c:\\COLLABS\\Win-Transport-Services")).toBe(
      canonicalProject("C--collabs-win-transport-services")
    )
  })

  it.each([
    "/dev/telemetry.dev",
    "~/dev/telemetry.dev",
    "~\\dev\\telemetry.dev",
  ])("resolves Windows home-relative path %s", (path) => {
    expect(canonicalProject(path)).toBe("C:\\Users\\me\\dev\\telemetry.dev")
  })

  it("backtracks when a valid prefix leads to a dead end", () => {
    expect(canonicalProject("C--collabs-roadmap-sync-app")).toBe(
      "C:\\collabs\\roadmap-sync\\app"
    )
  })

  it("preserves an existing raw path before decoding its dashes", () => {
    expect(canonicalProject("C:\\collabs\\roadmap-sync")).toBe(
      "C:\\collabs\\roadmap-sync"
    )
  })

  it("keeps drive roots absolute and validates that they exist", () => {
    expect(canonicalProject("C:/")).toBe("C:\\")
    expect(canonicalProject("C--")).toBe("C:\\")
    expect(canonicalProject("/C/")).toBe("C:\\")
    expect(canonicalProject("Z:/")).toBe("Z:/")
    expect(canonicalProject("C:collabs")).toBe("C:collabs")
  })

  it("deduplicates raw UNC paths without losing their share root", () => {
    const shapes = [
      "\\\\file-server\\team-share\\win-transport-services",
      "//file-server/team-share/win-transport-services",
    ]
    expect(new Set(shapes.map(canonicalProject))).toEqual(
      new Set(["\\\\file-server\\team-share\\win-transport-services"])
    )
    expect(canonicalProject("//file-server/team-share/")).toBe(
      "\\\\file-server\\team-share\\"
    )
  })

  it("rejects files and tolerates inaccessible directories", () => {
    expect(canonicalProject("C--collabs-file")).toBe("C--collabs-file")
    expect(canonicalProject("C--collabs-denied")).toBe("C--collabs-denied")
  })

  it("keeps an unresolvable drive path unchanged", () => {
    expect(canonicalProject("C--gone-project")).toBe("C--gone-project")
    expect(canonicalProject("E:\\missing\\dir")).toBe("E:\\missing\\dir")
  })
})

describe("displayProject on Windows paths", () => {
  it("shortens mixed separators and case with a directory boundary", () => {
    expect(displayProject("c:/users/ME/dev/telemetry.dev")).toBe(
      "~/dev/telemetry.dev"
    )
    expect(displayProject("C:\\Users\\ME-other\\dev")).toBe(
      "C:\\Users\\ME-other\\dev"
    )
  })

  it("shortens the home prefix to ~", () => {
    expect(displayProject("C:\\Users\\me\\dev\\telemetry.dev")).toBe(
      "~\\dev\\telemetry.dev"
    )
    expect(displayProject("C:\\collabs\\oss\\telemetry")).toBe(
      "C:\\collabs\\oss\\telemetry"
    )
  })
})

it("keeps historical Windows project aliases together in dashboard queries", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { closeDb, getDb, insertEvents } = await import("../db/client.server")
  const { getBreakdown, getOverview, getSessions, getTimeSeries } =
    await import("../api/queries.server")
  const dir = mkdtempSync(join(tmpdir(), "project-windows-db-"))
  vi.stubEnv("TELEMETRY_STATS_DATA_DIR", dir)
  try {
    const shapes = [
      "c:\\users\\ME\\DEV\\telemetry.dev",
      "C--Users-me-dev-telemetry.dev",
      "/C/Users-me-dev-telemetry.dev",
    ]
    const db = getDb()
    insertEvents(
      db,
      shapes.map((project, index) => ({
        id: `windows-${index}`,
        agent: "claude-code" as const,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        sessionId: `session-${index}`,
        project,
        timestamp: Date.now(),
        localDate: new Date().toISOString().slice(0, 10),
        tokens: {
          input: 100,
          output: 50,
          cacheRead: 200,
          cacheWrite: 0,
          reasoning: 0,
        },
        costUsd: index === 0 ? null : 0.5,
        costSource: index === 0 ? ("unpriced" as const) : ("reported" as const),
        durationMs: null,
        dedupKey: null,
        sourcePath: "fixture",
      }))
    )
    expect(
      db.prepare("SELECT DISTINCT project FROM usage_events").all()
    ).toEqual([{ project: "C:\\Users\\me\\dev\\telemetry.dev" }])
    // Simulate rows stored before Windows canonicalization was available.
    shapes.forEach((shape, index) => {
      db.prepare("UPDATE usage_events SET project = ? WHERE id = ?").run(
        shape,
        `windows-${index}`
      )
    })
    const rows = getBreakdown({ range: "all" }, "project")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      key: "C:\\Users\\me\\dev\\telemetry.dev",
      label: "~\\dev\\telemetry.dev",
      events: 3,
      sessions: 3,
      pricedCostUsd: 1,
      unpricedEventCount: 1,
      tokens: { total: 1050 },
    })
    expect(rows[0].cacheReadShare).toBeCloseTo(2 / 3)
    const filter = { range: "all" as const, projects: [rows[0].key] }
    expect(getOverview(filter).events).toBe(3)
    expect(
      getSessions(filter, 1, 10).sessions.map((session) => session.project)
    ).toEqual(Array(3).fill("~\\dev\\telemetry.dev"))
    expect(
      getTimeSeries(filter).points.reduce((sum, point) => sum + point.events, 0)
    ).toBe(3)
    expect(getOverview({ ...filter, agents: ["codex"] }).events).toBe(0)
    expect(getOverview({ ...filter, projects: ["C:\\missing"] }).events).toBe(0)
  } finally {
    closeDb()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  }
})

it("preserves POSIX precedence for drive-shaped paths and home-relative projects", async () => {
  vi.resetModules()
  vi.doMock("node:os", () => ({
    homedir: () => "/home/me",
    platform: () => "linux",
  }))
  const directories = new Set([
    "/C",
    "/C/collabs",
    "C:/",
    "C:/collabs",
    "/home",
    "/home/me",
    "/home/me/dev",
    "/home/me/dev/roadmap-sync",
    "/dev",
    "/dev/roadmap-sync",
  ])
  vi.doMock("node:fs", () => ({
    existsSync: (path: string) => directories.has(path),
    statSync: (path: string) =>
      directories.has(path) ? { isDirectory: () => true } : undefined,
    realpathSync: { native: (path: string) => path },
  }))
  try {
    const project = await import("./project.server")
    expect(project.canonicalProject("/C/collabs")).toBe("/C/collabs")
    expect(project.canonicalProject("C:/collabs")).toBe("C:/collabs")
    expect(project.canonicalProject("/dev/roadmap-sync")).toBe(
      "/home/me/dev/roadmap-sync"
    )
    expect(project.canonicalProject("-home-me-dev-roadmap-sync")).toBe(
      "/home/me/dev/roadmap-sync"
    )
    expect(project.displayProject("/home/me/dev/roadmap-sync")).toBe(
      "~/dev/roadmap-sync"
    )
    expect(project.displayProject("/HOME/me/dev/roadmap-sync")).toBe(
      "/HOME/me/dev/roadmap-sync"
    )
  } finally {
    vi.doUnmock("node:os")
    vi.doUnmock("node:fs")
    vi.resetModules()
  }
})

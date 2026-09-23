import type * as fs from "node:fs"
import type * as os from "node:os"
import { describe, expect, it, vi } from "vitest"

// Windows project shapes, checked on every platform against a fake filesystem
// so the suite does not depend on the machine it runs on.
const existing = vi.hoisted(
  () =>
    new Set(
      [
        "C:/Users/me",
        "C:/Users/me/dev",
        "C:/Users/me/dev/telemetry.dev",
        "C:/collabs",
        "C:/collabs/oss",
        "C:/collabs/oss/telemetry",
        "C:/collabs/win-transport-services",
        "D:/work",
        "D:/work/roadmap-sync",
      ].map((path) => path.toLowerCase())
    )
)

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: () => "C:\\Users\\me",
}))

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  existsSync: (path: string) =>
    existing.has(path.replaceAll("\\", "/").toLowerCase()),
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

  it("keeps an unresolvable drive path unchanged", () => {
    expect(canonicalProject("C--gone-project")).toBe("C--gone-project")
    expect(canonicalProject("E:\\missing\\dir")).toBe("E:\\missing\\dir")
  })
})

describe("displayProject on Windows paths", () => {
  it("shortens the home prefix to ~", () => {
    expect(displayProject("C:\\Users\\me\\dev\\telemetry.dev")).toBe(
      "~\\dev\\telemetry.dev"
    )
    expect(displayProject("C:\\collabs\\oss\\telemetry")).toBe(
      "C:\\collabs\\oss\\telemetry"
    )
  })
})

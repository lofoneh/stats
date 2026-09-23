import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

import { canonicalProject, displayProject } from "./project.server"

const base = mkdtempSync(join(tmpdir(), "project-test-"))
mkdirSync(join(base, "roadmap-sync"))
mkdirSync(join(base, "telemetry.dev"))

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe("canonicalProject", () => {
  it("keeps null, empty, and plain names", () => {
    expect(canonicalProject(null)).toBeNull()
    expect(canonicalProject("  ")).toBeNull()
    expect(canonicalProject("proj")).toBe("proj")
  })

  it("keeps an absolute path that exists", () => {
    const path = join(base, "telemetry.dev")
    expect(canonicalProject(path)).toBe(path)
  })

  it("repairs a dash-encoded name that was over-split on slashes", () => {
    expect(canonicalProject(join(base, "roadmap", "sync"))).toBe(
      join(base, "roadmap-sync"),
    )
  })

  it("decodes a dash-encoded directory name", () => {
    // Agents encode ":" and path separators as "-":
    // /a/b -> -a-b and C:\a\b -> C--a-b.
    const encoded = join(base, "telemetry.dev").replaceAll(/[:\\/]/gu, "-")
    expect(canonicalProject(encoded)).toBe(join(base, "telemetry.dev"))
  })

  it("keeps an unresolvable path unchanged", () => {
    const path = join(base, "deleted", "project")
    expect(canonicalProject(path)).toBe(path)
  })
})

describe("displayProject", () => {
  it("shortens the home prefix to ~", () => {
    expect(displayProject(join(homedir(), "dev", "x"))).toBe(
      join("~", "dev", "x")
    )
    expect(displayProject("/opt/x")).toBe("/opt/x")
    expect(displayProject(null)).toBeNull()
  })
})

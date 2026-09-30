import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, platform, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

import { canonicalProject, displayProject } from "./project.server"

let base = mkdtempSync(join(tmpdir(), "project-test-"))
if (platform() === "win32") base = realpathSync.native(base)
mkdirSync(join(base, "roadmap-sync"))
mkdirSync(join(base, "telemetry.dev"))
mkdirSync(join(base, "roadmap"))
mkdirSync(join(base, "roadmap-sync", "app"))
writeFileSync(join(base, "file"), "")

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
      join(base, "roadmap-sync")
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

  it("backtracks past an existing directory with no matching child", () => {
    expect(canonicalProject(join(base, "roadmap", "sync", "app"))).toBe(
      join(base, "roadmap-sync", "app")
    )
  })

  it("does not resolve an encoded project to a file", () => {
    const encoded = join(base, "file").replaceAll(/[:\\/]/gu, "-")
    expect(canonicalProject(encoded)).toBe(encoded)
  })

  it.skipIf(platform() !== "win32")(
    "deduplicates native Windows case variants",
    () => {
      const path = join(base, "telemetry.dev")
      expect(canonicalProject(path.toUpperCase())).toBe(path)
      expect(canonicalProject(path.replaceAll("\\", "/"))).toBe(path)
    }
  )

  it.skipIf(platform() !== "win32")(
    "keeps native Windows drive roots absolute",
    () => {
      const root = base.slice(0, 3)
      expect(canonicalProject(root)).toBe(root)
      expect(canonicalProject(`/${root[0]}/`)).toBe(root)
    }
  )

  it.skipIf(platform() === "win32")(
    "preserves an ambiguous POSIX /C/ path",
    () => {
      const path = join(base, "C", "collabs")
      mkdirSync(path, { recursive: true })
      expect(canonicalProject(path)).toBe(path)
      expect(canonicalProject("/C/does-not-exist-pr9")).toBe(
        "/C/does-not-exist-pr9"
      )
    }
  )
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

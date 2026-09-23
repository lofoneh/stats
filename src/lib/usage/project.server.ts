import { existsSync } from "node:fs"
import { homedir } from "node:os"

// Agents record the same working directory in different shapes:
//   /Users/ephraim/dev/telemetry.dev      raw cwd
//   /dev/telemetry.dev                    home-relative
//   -Users-ephraim-dev-telemetry.dev      dash-encoded log directory name
//   /dev/roadmap/sync                     dash-encoded name over-split on "-"
//   C:\Users\ephraim\dev\telemetry.dev    raw Windows cwd
//   C--Users-ephraim-dev-telemetry.dev    Claude Code log directory on Windows
//   /C/Users-ephraim-dev-telemetry.dev    Pi and Oh My Pi log directory on Windows
// canonicalProject maps all of them to one absolute path so the same project
// never appears twice in breakdowns, sessions, or top lists. Resolution is
// filesystem-backed: a candidate wins only when the directory exists.

const HOME = homedir()
const cache = new Map<string, string | null>()

export function canonicalProject(raw: string | null): string | null {
  if (raw === null) return null
  const trimmed = raw.trim()
  if (trimmed === "") return null
  const hit = cache.get(trimmed)
  if (hit !== undefined) return hit
  const result = resolveProject(trimmed)
  cache.set(trimmed, result)
  return result
}

/** Shortens a canonical path for display: /Users/me/dev/x -> ~/dev/x. */
export function displayProject(project: string | null): string | null {
  if (project === null) return null
  const underHome = project.startsWith(`${HOME}/`) || project.startsWith(`${HOME}\\`)
  return underHome ? `~${project.slice(HOME.length)}` : project
}

function resolveProject(raw: string): string {
  return resolvePosix(raw) ?? resolveDrive(raw) ?? raw
}

function resolvePosix(raw: string): string | null {
  const base = raw.startsWith("-")
    ? `/${raw.slice(1)}`
    : raw.startsWith("~")
      ? HOME + raw.slice(1)
      : raw
  if (!base.startsWith("/")) return null
  const decoded = base.replaceAll("-", "/")
  // Home-anchored candidates first: "/dev/x" almost always means "~/dev/x",
  // and system directories such as /dev exist and would win otherwise. A raw
  // absolute path is unaffected because HOME + "/Users/..." never exists.
  const candidates =
    decoded === base
      ? [HOME + base, base]
      : [HOME + base, HOME + decoded, base, decoded]
  for (const candidate of candidates) {
    const resolved = resolveSegments("", candidate.split("/").filter(Boolean), 0)
    if (resolved !== null) return resolved
  }
  return null
}

const DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/u
const DRIVE_ENCODED = [/^([A-Za-z])--(.*)$/u, /^\/([A-Za-z])\/(.*)$/u]

/**
 * Resolves a Windows drive path, raw or dash-encoded, to a native path such as
 * C:\dev\x. Encoded names turn ":" and "\" into "-", so they get the same
 * filesystem-backed segment repair as POSIX names.
 */
function resolveDrive(raw: string): string | null {
  const direct = DRIVE_PATH.exec(raw)
  const match = direct ?? DRIVE_ENCODED.map((pattern) => pattern.exec(raw)).find(Boolean)
  if (!match) return null
  const [, drive, rest] = match
  const segments = rest.split(direct ? /[\\/]/u : /[\\/-]/u).filter(Boolean)
  const resolved = resolveSegments(`${drive.toUpperCase()}:`, segments, 0)
  return resolved === null ? null : resolved.replaceAll("/", "\\")
}

/**
 * Rejoins slash-split segments against the filesystem. Dash-encoded names are
 * lossy ("roadmap-sync" encodes like "roadmap/sync"), so when a segment does
 * not exist as a directory the search merges it with the next segment using
 * "-" and tries again, backtracking across interpretations.
 */
function resolveSegments(current: string, segments: string[], index: number): string | null {
  if (index === segments.length) return current === "" ? null : current
  let name = segments[index]
  for (let next = index + 1; ; next++) {
    const candidate = `${current}/${name}`
    if (existsSync(candidate)) {
      const resolved = resolveSegments(candidate, segments, next)
      if (resolved !== null) return resolved
    }
    if (next === segments.length) return null
    name = `${name}-${segments[next]}`
  }
}

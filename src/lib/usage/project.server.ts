import { existsSync, realpathSync, statSync } from "node:fs"
import { homedir, platform } from "node:os"

// Agents record the same working directory in different shapes:
//   /Users/ephraim/dev/telemetry.dev      raw cwd
//   /dev/telemetry.dev                    home-relative
//   -Users-ephraim-dev-telemetry.dev      dash-encoded log directory name
//   /dev/roadmap/sync                     dash-encoded name over-split on "-"
//   C:\Users\ephraim\dev\telemetry.dev    raw Windows cwd
//   C--Users-ephraim-dev-telemetry.dev    Claude Code log directory on Windows
//   /C/Users-ephraim-dev-telemetry.dev    Pi and Oh My Pi log dir on Windows
// canonicalProject maps all of them to one absolute path so the same project
// never appears twice in breakdowns, sessions, or top lists. Resolution is
// filesystem-backed: a candidate wins only when the directory exists.

const HOME = homedir()
const WINDOWS = platform() === "win32"
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
  const home = WINDOWS ? HOME.replaceAll("\\", "/").toLowerCase() : HOME
  const path = WINDOWS ? project.replaceAll("\\", "/").toLowerCase() : project
  const underHome = path.startsWith(`${home}/`)
  return underHome ? `~${project.slice(HOME.length)}` : project
}

function resolveProject(raw: string): string {
  if (
    WINDOWS &&
    (DRIVE_PATH.test(raw) ||
      DRIVE_ENCODED.some((pattern) => pattern.test(raw)) ||
      /^[\\/]{2}/u.test(raw) ||
      raw.startsWith("~"))
  ) {
    return resolveDrive(raw) ?? raw
  }
  return resolvePosix(raw) ?? raw
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
    const resolved = WINDOWS
      ? resolveDrive(candidate)
      : resolveSegments("", candidate.split("/").filter(Boolean), 0)
    if (resolved !== null) return resolved
  }
  return null
}

const DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/u
const DRIVE_ENCODED = [/^([A-Za-z])--(.*)$/u, /^\/([A-Za-z])\/(.*)$/u]

/**
 * Resolves Windows drive and raw UNC paths to a native path. Encoded drive
 * names turn ":" and "\" into "-", so they get the same
 * filesystem-backed segment repair as POSIX names.
 */
function resolveDrive(raw: string): string | null {
  const base = raw.startsWith("~") ? HOME + raw.slice(1) : raw
  const direct = DRIVE_PATH.exec(base)
  const match =
    direct ?? DRIVE_ENCODED.map((pattern) => pattern.exec(base)).find(Boolean)
  const unc = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)[\\/]?(.*)$/u.exec(base)
  if (!match && !unc) return null
  const root = match
    ? `${match[1].toUpperCase()}:/`
    : `//${unc![1]}/${unc![2]}/`
  const rest = match ? match[2] : unc![3]
  const segments = rest
    .split(direct || unc ? /[\\/]/u : /[\\/-]/u)
    .filter(Boolean)
  if (!existsSync(root)) return null
  const resolved = resolveSegments(root, segments, 0)
  if (resolved === null) return null
  try {
    // The native Windows API returns the filesystem's spelling, so casing
    // variants deduplicate without folding case-sensitive directories.
    return realpathSync
      .native(resolved)
      .replace(/^[a-z]:/u, (drive) => drive.toUpperCase())
  } catch {
    return null
  }
}

/**
 * Rejoins slash-split segments against the filesystem. Dash-encoded names are
 * lossy ("roadmap-sync" encodes like "roadmap/sync"), so when a segment does
 * not exist as a directory the search merges it with the next segment using
 * "-" and tries again, backtracking across interpretations.
 */
function resolveSegments(
  current: string,
  segments: string[],
  index: number
): string | null {
  if (index === segments.length) return current === "" ? null : current
  let name = segments[index]
  for (let next = index + 1; ; next++) {
    const candidate = `${current}${current.endsWith("/") ? "" : "/"}${name}`
    let directory = false
    try {
      directory =
        statSync(candidate, { throwIfNoEntry: false })?.isDirectory() ?? false
    } catch {
      // A missing or inaccessible candidate must not abort backtracking.
    }
    if (directory) {
      const resolved = resolveSegments(candidate, segments, next)
      if (resolved !== null) return resolved
    }
    if (next === segments.length) return null
    name = `${name}-${segments[next]}`
  }
}

// What a file Claude is about to write or edit adds to Claude Code: only an
// MCP server, added or changed in `.mcp.json` or `.claude.json`, which is an
// install by another name. Judged by the path first, so any other file passes
// without anything read; then by the servers the file would hold. Also where
// a path really lands, and which prompt a path in a `.claude` folder is, for
// the skill gate.

import type { Host } from '../scan/host'
import { safeLine } from '../scan/safe-text'
import { mcpServerProblem } from './requests'
import { expandHome } from './resolve'

/** One MCP server a configuration file would hold: where it is kept, and its configuration. */
export type McpEntry = { name: string; scope: string; server: Record<string, unknown>; invalid?: boolean }

export type WriteReading = { kind: 'pass' } | { kind: 'mcp'; label: string; servers: McpEntry[] } | { kind: 'unreadable'; label: string; reason: string }

/** What Claude's Write and Edit tools are given. */
export type WriteInput =
  | { tool: 'Write'; file_path: string; content: string }
  | { tool: 'Edit'; file_path: string; old_string: string; new_string: string; replace_all?: boolean }

type Place = { kind: 'skill'; folder?: string; rel: string; name: string } | { kind: 'command' | 'agent' | 'output style'; rel: string } | { kind: 'mcp-project' } | { kind: 'mcp-user' }

const PASS: WriteReading = { kind: 'pass' }

/** A path as written, with `\` read as `/` and nothing resolved: what the system follows. */
export function slashed(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * A path with `.` and `..` removed as text and `\` read as `/`, for showing
 * and matching: `a/x/../skills` is `a/skills`. A Windows network path keeps
 * its leading `//`. Where a path really lands is `landsAt`'s, since the
 * system follows a link before the `..` after it.
 */
export function normalizePath(path: string): string {
  const raw = slashed(path)
  const parts: string[] = []
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${raw.startsWith('//') ? '//' : raw.startsWith('/') ? '/' : ''}${parts.join('/')}`
}

/**
 * What a path in a place Claude Code loads from is, by the path alone: a
 * skill's file, a command, agent or output style, or an MCP configuration;
 * undefined for any other file. Matched without regard to case, since a disk that ignores case loads
 * `.Claude/Skills` as `.claude/skills`. `configDir` is the folder
 * CLAUDE_CONFIG_DIR names, when it moves Claude's own from ~/.claude: a path
 * in it is read as one in ~/.claude.
 */
export function writePlace(rawPath: string, configDir?: string): Place | undefined {
  const path = normalizePath(rawPath)
  const lower = path.toLowerCase()
  if (configDir !== undefined) {
    const dir = normalizePath(configDir).replace(/\/+$/, '')
    if (dir !== '' && lower.startsWith(`${dir.toLowerCase()}/`)) {
      const place = writePlace(`/.claude${path.slice(dir.length)}`)
      // A skill's folder is the real one, not the ~/.claude it was read as.
      return place?.kind === 'skill' && place.folder !== undefined ? { ...place, folder: `${dir}${place.folder.slice('/.claude'.length)}` } : place
    }
  }
  const name = lower.slice(lower.lastIndexOf('/') + 1)
  // A file in a skill folder is that skill's, whatever it is named.
  const found = /(?:^|\/)\.claude\/(skills|commands|agents|output-styles)\//.exec(lower)
  if (found === null) {
    if (name === '.mcp.json') return { kind: 'mcp-project' }
    if (name === '.claude.json') return { kind: 'mcp-user' }
    return undefined
  }
  const area = found[1] as 'skills' | 'commands' | 'agents' | 'output-styles'
  const start = (found.index ?? 0) + found[0].length
  const rest = path.slice(start)
  if (area !== 'skills') return { kind: area === 'commands' ? 'command' : area === 'agents' ? 'agent' : 'output style', rel: `${area}/${rest}` }
  const slash = rest.indexOf('/')
  // A file straight in the skills folder is no skill's own: it is scanned on its own.
  if (slash === -1) return { kind: 'skill', rel: `skills/${rest}`, name: rest }
  return { kind: 'skill', folder: path.slice(0, start + slash), rel: rest.slice(slash + 1), name: rest.slice(0, slash) }
}

/**
 * The MCP servers a write Claude is about to make adds or changes, read from
 * its path and the configuration that would land: for Edit, the file as it is
 * now with the change made. Only a configuration Claude Code starts servers
 * from counts: the session folder's `.mcp.json` (`project`, undefined when it
 * is not known) and your own `.claude.json`; a fixture's or another folder's
 * passes with nothing read, as does any other file. What the guard cannot
 * read for certain there (a relative path, a write through a link, a file it
 * cannot read, an edit it cannot replay) is held, never passed.
 */
export async function readWrite(host: Host, input: WriteInput, where: { configDir?: string; project?: string } = {}): Promise<WriteReading> {
  const raw = slashed(input.file_path)
  const path = normalizePath(raw)
  const shown = safeLine(path)
  const held = (reason: string): WriteReading => ({ kind: 'unreadable', label: `a change to ${shown}`, reason })
  const named = writePlace(path, where.configDir)
  // A relative path lands in a folder the guard cannot see: only one that names a configuration by its file name is held.
  if (!/^(?:\/|[A-Za-z]:\/)/.test(raw)) return isConfig(named) ? held('it names a path relative to a folder the guard cannot see; give the full path') : PASS
  // Where it really lands counts first: a link on the way can lead to a configuration, and the system follows it before a `..` after it.
  const landed = await landsAt(host, raw)
  const there = writePlace(landed, where.configDir)
  const place = isConfig(there) && (await startsServers(host, landed, there, where)) ? there : isConfig(named) && (await startsServers(host, path, named, where)) ? named : undefined
  if (place === undefined) return PASS
  // A write to a link changes where the link leads, which the guard does not read.
  if ((await host.stat(raw).catch(() => undefined))?.isLink === true) return held('it writes through a link, and the guard reads files, not where links lead; write the file the link points to')
  // Read where it lands, the same file under every name a link gives it.
  const current = await readText(host, landed, MAX_CONFIG_BYTES)
  if ('tooLarge' in current) return held(`the file is ${current.tooLarge} bytes, more than the guard reads`)
  if ('unreadable' in current) return held('the guard could not read the file as it is now, so it cannot tell what the change makes')
  const before = current.text
  const after = input.tool === 'Write' ? input.content : edited(before, input)
  // Claude Code matches an edit more loosely than the guard can replay it, so one the guard cannot replay may still apply.
  if (after === undefined) return held('the guard could not make this edit to the file as it is now, so it cannot check what it makes; write the whole file instead')
  return mcpWrite(place.kind, shown, before, after, path.slice(0, path.lastIndexOf('/')) || '/')
}

function isConfig(place: Place | undefined): place is { kind: 'mcp-project' } | { kind: 'mcp-user' } {
  return place?.kind === 'mcp-project' || place?.kind === 'mcp-user'
}

/**
 * Whether Claude Code starts servers from the configuration at `path`: a
 * `.mcp.json` in the session's folder (by either name of it), or a
 * `.claude.json` in your home folder or the folder CLAUDE_CONFIG_DIR names.
 * Matched without regard to case; what cannot be looked up counts.
 */
async function startsServers(host: Host, path: string, place: { kind: 'mcp-project' } | { kind: 'mcp-user' }, where: { configDir?: string; project?: string }): Promise<boolean> {
  const folder = normalizePath(path.slice(0, path.lastIndexOf('/')) || '/').toLowerCase()
  // Normalized alike on both sides, so the root folder is `/` on both.
  const same = (dir: string | undefined): boolean => dir !== undefined && normalizePath(dir).toLowerCase() === folder
  if (place.kind === 'mcp-project') {
    if (where.project === undefined) return true
    return same(where.project) || same(await landsAt(host, slashed(where.project)).catch(() => undefined))
  }
  const home = await expandHome(host, '~').catch(() => undefined)
  if (home === undefined) return true
  return same(home) || same(await landsAt(host, slashed(home)).catch(() => undefined)) || same(where.configDir)
}

/**
 * Where a change written to `path` is kept, as the write gate keeps it: the
 * path followed through every link before any `..` after it, then shown
 * plainly. Undefined for a relative path, which the gate never keeps.
 */
export async function keptAt(host: Host, path: string): Promise<string | undefined> {
  const raw = slashed(path)
  if (!/^(?:\/|[A-Za-z]:\/)/.test(raw)) return undefined
  return normalizePath(await landsAt(host, raw))
}

/**
 * The folder CLAUDE_CONFIG_DIR names, where it is really, when it moves
 * Claude's own folder from ~/.claude; undefined when it is not set.
 */
export async function claudeConfigDir(host: Host): Promise<string | undefined> {
  const { exitCode, stdout } = await host.run(['printenv', 'CLAUDE_CONFIG_DIR'])
  const dir = stdout.trim()
  if (exitCode !== 0 || !/^(?:\/|[A-Za-z]:[\\/])/.test(dir)) return undefined
  return normalizePath(await landsAt(host, slashed(dir)))
}

/** The most of a skill or command file the guard reads, as the scan does. */
export const MAX_PROMPT_BYTES = 4 * 1024 * 1024
/** The most of an MCP configuration it reads: the user's own holds every project's settings. */
export const MAX_CONFIG_BYTES = 16 * 1024 * 1024

/** The file as it is now, as text (undefined when there is none), or its size when it is over `limit`, or that it is there but cannot be read. */
export async function readText(host: Host, path: string, limit: number): Promise<{ text: string | undefined } | { tooLarge: number } | { unreadable: true }> {
  const stat = await host.stat(path).catch(() => undefined)
  if (stat === undefined) return { text: undefined }
  if (stat.size > limit) return { tooLarge: stat.size }
  try {
    return { text: new TextDecoder().decode(await host.readBytes(path)) }
  } catch {
    return { unreadable: true }
  }
}

/**
 * Where a path really lands, every link on the way followed: the file's own
 * when it is there, else its nearest folder that is, with the rest of the way after it.
 */
export async function landsAt(host: Host, path: string): Promise<string> {
  let base = path
  let rest = ''
  while (base.length > 1) {
    const real = (await host.stat(base, { resolve: true }).catch(() => undefined))?.realPath
    if (real !== undefined) return `${real.replace(/\/+$/, '')}${rest}`
    rest = `${base.slice(base.lastIndexOf('/'))}${rest}`
    base = base.slice(0, base.lastIndexOf('/')) || '/'
  }
  return path
}

/** The file once the edit is made, or undefined when Claude Code would refuse the edit. */
function edited(before: string | undefined, input: Extract<WriteInput, { tool: 'Edit' }>): string | undefined {
  // An empty old_string on a file not there yet creates it.
  if (before === undefined) return input.old_string === '' ? input.new_string : undefined
  if (input.old_string === '' || input.old_string === input.new_string) return undefined
  const count = before.split(input.old_string).length - 1
  if (count === 0) return undefined
  if (input.replace_all === true) return before.split(input.old_string).join(input.new_string)
  if (count > 1) return undefined
  return before.replace(input.old_string, () => input.new_string)
}

/**
 * A configuration file's MCP servers before and after: every server added or
 * changed is checked, each as `claude mcp add` would have it. A file that does
 * not parse adds no server Claude Code could start.
 */
function mcpWrite(kind: 'mcp-project' | 'mcp-user', shown: string, before: string | undefined, after: string, folder: string): WriteReading {
  const now = serversIn(after, kind, folder)
  if (now === undefined) return PASS
  const was = new Map((serversIn(before ?? '', kind, folder) ?? []).map(entry => [keyOf(entry), stable(entry.server)]))
  const changed = now.filter(entry => entry.invalid === true || was.get(keyOf(entry)) !== stable(entry.server))
  if (changed.length === 0) return PASS
  const label = `${changed.length === 1 ? `the MCP server ${safeLine((changed[0] as McpEntry).name)}` : `${changed.length} MCP servers`} in ${shown}`
  for (const entry of changed) {
    const problem = entry.invalid === true ? 'its configuration is not a JSON object' : mcpServerProblem(entry.name, entry.server)
    if (problem !== undefined) return { kind: 'unreadable', label, reason: `${safeLine(entry.name)}: ${problem}` }
  }
  return { kind: 'mcp', label, servers: changed }
}

/**
 * The servers a configuration holds: a project's `.mcp.json` its own (kept
 * under that project's `folder`), and the user's `.claude.json` its own and each project's. Undefined when the text is
 * no JSON object; a server that is no object is kept as one to be refused.
 */
export function serversIn(text: string, kind: 'mcp-project' | 'mcp-user', folder: string): McpEntry[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text === '' ? '{}' : text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const out: McpEntry[] = []
  const add = (servers: unknown, scope: string): void => {
    if (!isRecord(servers)) return
    for (const [name, server] of Object.entries(servers)) out.push(isRecord(server) ? { name, scope, server } : { name, scope, server: {}, invalid: true })
  }
  // A project's servers are that project's: an approval in one folder is no approval in another.
  add(parsed.mcpServers, kind === 'mcp-project' ? `project ${folder}` : 'user')
  if (kind === 'mcp-user' && isRecord(parsed.projects)) {
    for (const [project, settings] of Object.entries(parsed.projects)) if (isRecord(settings)) add(settings.mcpServers, `local ${project}`)
  }
  return out
}

function keyOf(entry: McpEntry): string {
  return `${entry.scope}\u0000${entry.name}`
}

/** JSON with every object's keys in order, so the same configuration compares equal however it is written. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// What a file Claude is about to write or edit adds to Claude Code: a skill,
// command or agent it loads, an MCP server it starts, or a change to an
// installed plugin. Judged by the path first, so an ordinary file passes
// without anything read; then by the content that would land.

import type { Host } from '../scan/host'
import { safeLine } from '../scan/safe-text'
import { mcpServerProblem } from './requests'

/** One MCP server a configuration file would hold: where it is kept, and its configuration. */
export type McpEntry = { name: string; scope: string; server: Record<string, unknown>; invalid?: boolean }

export type WriteReading =
  | { kind: 'pass' }
  /**
   * A prompt Claude Code loads. A skill is scanned as its real `folder` with
   * `rel` holding the new content; a command or agent as the one file, at
   * `rel` in a folder of its own.
   */
  | { kind: 'prompt'; label: string; what: 'skill' | 'command' | 'agent'; content: string; folder?: string; rel: string }
  | { kind: 'mcp'; label: string; servers: McpEntry[] }
  | { kind: 'unreadable'; label: string; reason: string }

/** What Claude's Write and Edit tools are given. */
export type WriteInput =
  | { tool: 'Write'; file_path: string; content: string }
  | { tool: 'Edit'; file_path: string; old_string: string; new_string: string; replace_all?: boolean }

type Place =
  | { kind: 'skill'; folder?: string; rel: string; name: string }
  | { kind: 'command' | 'agent'; rel: string }
  | { kind: 'plugins' }
  | { kind: 'mcp-project' }
  | { kind: 'mcp-user' }

const PASS: WriteReading = { kind: 'pass' }

/** A path with `.` and `..` resolved and `\` read as `/`: `a/x/../skills` is `a/skills`. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith('/') || path.startsWith('\\')
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${absolute ? '/' : ''}${parts.join('/')}`
}

/**
 * Where a write lands, by its path alone, or undefined for any other file.
 * Matched without regard to case, since a disk that ignores case loads
 * `.Claude/Skills` as `.claude/skills`.
 */
export function writePlace(rawPath: string): Place | undefined {
  const path = normalizePath(rawPath)
  const lower = path.toLowerCase()
  const name = lower.slice(lower.lastIndexOf('/') + 1)
  if (name === '.mcp.json') return { kind: 'mcp-project' }
  if (name === '.claude.json') return { kind: 'mcp-user' }
  const found = /(?:^|\/)\.claude\/(skills|commands|agents|plugins)\//.exec(lower)
  if (found === null) return undefined
  const area = found[1] as 'skills' | 'commands' | 'agents' | 'plugins'
  if (area === 'plugins') return { kind: 'plugins' }
  const start = (found.index ?? 0) + found[0].length
  const rest = path.slice(start)
  if (area !== 'skills') return { kind: area === 'commands' ? 'command' : 'agent', rel: `${area}/${rest}` }
  const slash = rest.indexOf('/')
  // A file straight in the skills folder is no skill's own: it is scanned on its own.
  if (slash === -1) return { kind: 'skill', rel: `skills/${rest}`, name: rest }
  return { kind: 'skill', folder: path.slice(0, start + slash), rel: rest.slice(slash + 1), name: rest.slice(0, slash) }
}

/**
 * What a write Claude is about to make adds, read from its path and the
 * content that would land: for Edit, the file as it is now with the change
 * made. An edit that would not apply (its text is not there once) fails in
 * Claude Code anyway, so it passes.
 */
export async function readWrite(host: Host, input: WriteInput): Promise<WriteReading> {
  const path = normalizePath(input.file_path)
  const shown = safeLine(path)
  // A relative path lands where the shell's folder is, which the guard cannot see. `C:/…` is a full path on Windows.
  if (!/^(?:\/|[A-Za-z]:\/)/.test(path)) {
    return writePlace(path) === undefined ? PASS : { kind: 'unreadable', label: `a change to ${shown}`, reason: 'it names a path relative to a folder the guard cannot see; give the full path' }
  }
  // Where it really lands counts too: a link on the way can lead into .claude.
  const place = writePlace(path) ?? writePlace(await landsAt(host, path))
  if (place === undefined) return PASS
  if (place.kind === 'plugins') {
    return { kind: 'unreadable', label: `a change to ${shown}`, reason: 'it changes the files of a plugin Claude Code installed, outside any install, so what runs would no longer be what was approved' }
  }
  // The file as it is now is read only when it is needed: for an edit, or to compare a configuration's servers.
  const needed = input.tool === 'Edit' || place.kind === 'mcp-project' || place.kind === 'mcp-user'
  const limit = place.kind === 'mcp-project' || place.kind === 'mcp-user' ? MAX_CONFIG_BYTES : MAX_PROMPT_BYTES
  const current = needed ? await readText(host, path, limit) : { text: undefined }
  if ('tooLarge' in current) return { kind: 'unreadable', label: `a change to ${shown}`, reason: `the file is ${current.tooLarge} bytes, more than the guard reads` }
  const before = current.text
  const after = input.tool === 'Write' ? input.content : edited(before, input)
  if (after === undefined) return PASS
  if (place.kind === 'mcp-project' || place.kind === 'mcp-user') return mcpWrite(place.kind, shown, before, after)
  const what = place.kind
  const label = what === 'skill' ? `the skill ${safeLine(place.name)}` : `the ${what} ${safeLine(place.rel.slice(place.rel.indexOf('/') + 1))}`
  return { kind: 'prompt', label, what, content: after, ...(place.kind === 'skill' && place.folder !== undefined ? { folder: place.folder } : {}), rel: place.rel }
}

/** The most of a skill, command or agent file the guard reads, as the scan does. */
const MAX_PROMPT_BYTES = 4 * 1024 * 1024
/** The most of an MCP configuration it reads: the user's own holds every project's settings. */
const MAX_CONFIG_BYTES = 16 * 1024 * 1024

/** The file as it is now, as text (undefined when there is none), or its size when it is over `limit`. */
async function readText(host: Host, path: string, limit: number): Promise<{ text: string | undefined } | { tooLarge: number }> {
  const stat = await host.stat(path).catch(() => undefined)
  if (stat === undefined) return { text: undefined }
  if (stat.size > limit) return { tooLarge: stat.size }
  try {
    return { text: new TextDecoder().decode(await host.readBytes(path)) }
  } catch {
    return { text: undefined }
  }
}

/**
 * Where a path really lands, every link on the way followed: the file's own
 * when it is there, else its nearest folder that is, with the rest of the way after it.
 */
async function landsAt(host: Host, path: string): Promise<string> {
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
function mcpWrite(kind: 'mcp-project' | 'mcp-user', shown: string, before: string | undefined, after: string): WriteReading {
  const now = serversIn(after, kind)
  if (now === undefined) return PASS
  const was = new Map((serversIn(before ?? '', kind) ?? []).map(entry => [keyOf(entry), stable(entry.server)]))
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
 * The servers a configuration holds: a project's `.mcp.json` its own, and the
 * user's `.claude.json` its own and each project's. Undefined when the text is
 * no JSON object; a server that is no object is kept as one to be refused.
 */
function serversIn(text: string, kind: 'mcp-project' | 'mcp-user'): McpEntry[] | undefined {
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
  add(parsed.mcpServers, kind === 'mcp-project' ? 'project' : 'user')
  if (kind === 'mcp-user' && isRecord(parsed.projects)) {
    for (const [project, settings] of Object.entries(parsed.projects)) if (isRecord(settings)) add(settings.mcpServers, `local ${project}`)
  }
  return out
}

function keyOf(entry: McpEntry): string {
  return `${entry.scope}\u0000${entry.name}`
}

/** JSON with every object's keys in order, so the same configuration compares equal however it is written. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

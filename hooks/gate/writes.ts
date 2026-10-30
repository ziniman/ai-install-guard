// What a file Claude is about to write or edit adds to Claude Code: a skill,
// command or agent it loads, an MCP server it starts, or a change to an
// installed plugin. Judged by the path first, so an ordinary file passes
// without anything read; then by the content that would land.

import type { Host } from '../scan/host'
import { safeLine } from '../scan/safe-text'
import type { Evidence } from '../scan/checks/types'
import { mcpServerProblem } from './requests'
import { settingsChange } from './settings'

/** One MCP server a configuration file would hold: where it is kept, and its configuration. */
export type McpEntry = { name: string; scope: string; server: Record<string, unknown>; invalid?: boolean }

export type WriteReading =
  | { kind: 'pass' }
  /**
   * A prompt Claude Code loads. A skill is scanned as its real `folder` with
   * `rel` holding the new content; a command or agent as the one file, at
   * `rel` in a folder of its own.
   */
  | { kind: 'prompt'; label: string; what: 'skill' | 'command' | 'agent' | 'output style'; content: string; folder?: string; rel: string }
  | { kind: 'mcp'; label: string; servers: McpEntry[] }
  /** A settings change that widens what Claude may do: the file it makes, and what it widens or narrows. */
  | { kind: 'settings'; label: string; path: string; content: string; evidence: Evidence[] }
  | { kind: 'unreadable'; label: string; reason: string }

/** What Claude's Write and Edit tools are given. */
export type WriteInput =
  | { tool: 'Write'; file_path: string; content: string }
  | { tool: 'Edit'; file_path: string; old_string: string; new_string: string; replace_all?: boolean }

type Place =
  | { kind: 'skill'; folder?: string; rel: string; name: string }
  | { kind: 'command' | 'agent' | 'output style'; rel: string }
  | { kind: 'plugins' }
  | { kind: 'mcp-project' }
  | { kind: 'mcp-user' }
  | { kind: 'settings' }

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
 * Where a write lands, by its path alone, or undefined for any other file.
 * Matched without regard to case, since a disk that ignores case loads
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
  // A file in a plugin or a skill folder is that plugin's or skill's, whatever it is named.
  const found = /(?:^|\/)\.claude\/(skills|commands|agents|output-styles|plugins)\//.exec(lower)
  if (found === null) {
    if (name === '.mcp.json') return { kind: 'mcp-project' }
    if (name === '.claude.json') return { kind: 'mcp-user' }
    // A project's or the user's settings, beside .claude's other files, and an organization's.
    if (/(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(lower) || name === 'managed-settings.json') return { kind: 'settings' }
    return undefined
  }
  const area = found[1] as 'skills' | 'commands' | 'agents' | 'output-styles' | 'plugins'
  if (area === 'plugins') return { kind: 'plugins' }
  const start = (found.index ?? 0) + found[0].length
  const rest = path.slice(start)
  if (area !== 'skills') return { kind: area === 'commands' ? 'command' : area === 'agents' ? 'agent' : 'output style', rel: `${area}/${rest}` }
  const slash = rest.indexOf('/')
  // A file straight in the skills folder is no skill's own: it is scanned on its own.
  if (slash === -1) return { kind: 'skill', rel: `skills/${rest}`, name: rest }
  return { kind: 'skill', folder: path.slice(0, start + slash), rel: rest.slice(slash + 1), name: rest.slice(0, slash) }
}

/**
 * What a write Claude is about to make adds, read from its path and the
 * content that would land: for Edit, the file as it is now with the change
 * made. Whatever the guard cannot read for certain in a place Claude Code
 * loads from (a relative path, a write through a link, a file it cannot read,
 * an edit it cannot replay) is held, never passed.
 */
export async function readWrite(host: Host, input: WriteInput, configDir?: string): Promise<WriteReading> {
  const raw = slashed(input.file_path)
  const path = normalizePath(raw)
  const shown = safeLine(path)
  const held = (reason: string): WriteReading => ({ kind: 'unreadable', label: `a change to ${shown}`, reason })
  // A relative path lands in a folder the guard cannot see, so it cannot tell whether Claude Code loads from it.
  if (!/^(?:\/|[A-Za-z]:\/)/.test(raw)) return held('it names a path relative to a folder the guard cannot see; give the full path')
  // Where it really lands counts first: a link on the way can lead into .claude, and the system follows it before a `..` after it.
  const landed = await landsAt(host, raw)
  const place = writePlace(landed, configDir) ?? writePlace(path, configDir)
  if (place === undefined) return PASS
  if (place.kind === 'plugins') return held('it changes the files of a plugin Claude Code installed, outside any install, so what runs would no longer be what was approved')
  // A write to a link changes where the link leads, which a scan does not read.
  if ((await host.stat(raw).catch(() => undefined))?.isLink === true) return held('it writes through a link, and the guard reads files, not where links lead; write the file the link points to')
  // The file as it is now is read only when it is needed: for an edit, or to compare a configuration's servers.
  const config = place.kind === 'mcp-project' || place.kind === 'mcp-user' || place.kind === 'settings'
  // Read where it lands, the same file under every name a link gives it.
  const current = input.tool === 'Edit' || config ? await readText(host, landed, config ? MAX_CONFIG_BYTES : MAX_PROMPT_BYTES) : { text: undefined }
  if ('tooLarge' in current) return held(`the file is ${current.tooLarge} bytes, more than the guard reads`)
  if ('unreadable' in current) return held('the guard could not read the file as it is now, so it cannot tell what the change makes')
  const before = current.text
  const after = input.tool === 'Write' ? input.content : edited(before, input)
  // Claude Code matches an edit more loosely than the guard can replay it, so one the guard cannot replay may still apply.
  if (after === undefined) return held('the guard could not make this edit to the file as it is now, so it cannot check what it makes; write the whole file instead')
  // A settings file is kept under where it really is, so a link to it is the same file.
  if (place.kind === 'settings') return settingsWrite(safeLine(normalizePath(landed)), normalizePath(landed), before, after)
  if (config) return mcpWrite(place.kind, shown, before, after, path.slice(0, path.lastIndexOf('/')) || '/')
  const what = place.kind
  const label = what === 'skill' ? `the skill ${safeLine(place.name)}` : `the ${what} ${safeLine(place.rel.slice(place.rel.indexOf('/') + 1))}`
  return { kind: 'prompt', label, what, content: after, ...(place.kind === 'skill' && place.folder !== undefined ? { folder: place.folder } : {}), rel: place.rel }
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

/** The most of a skill, command or agent file the guard reads, as the scan does. */
export const MAX_PROMPT_BYTES = 4 * 1024 * 1024
/** The most of an MCP configuration it reads: the user's own holds every project's settings. */
const MAX_CONFIG_BYTES = 16 * 1024 * 1024

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
 * A settings file before and after: held when the change widens what Claude
 * may do or run; a change that only narrows it, or touches nothing that runs,
 * goes on. A file that does not parse is no settings Claude Code could use.
 */
function settingsWrite(shown: string, path: string, before: string | undefined, after: string): WriteReading {
  const now = parseObject(after)
  if (now === undefined) return PASS
  const evidence = settingsChange(parseObject(before ?? '') ?? {}, now, shown)
  if (!evidence.some(item => item.status === 'warn' || item.status === 'fail')) return PASS
  return { kind: 'settings', label: `the settings in ${shown}`, path, content: after, evidence }
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text.trim() === '' ? '{}' : text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
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
function serversIn(text: string, kind: 'mcp-project' | 'mcp-user', folder: string): McpEntry[] | undefined {
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
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

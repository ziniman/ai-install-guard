// The check of your configuration at the start of a session: each MCP server
// in your .claude.json and in this folder's .mcp.json, and what each settings
// file runs on its own (its hooks, status line, helper commands and the
// environment variables that change what runs), compared with what you
// approved. Claude Code reads these files as they are, so a change no gate
// saw (a git pull, another program's installer, an edit made in a terminal)
// starts its servers and runs its hooks before the guard can look. Like the
// plugins check, this one runs beside the session: a server with no red flags
// is named once, and anything else waits in the pane with Keep and Reject.
// The tools of a server you rejected are refused from then on; a settings
// file can only be named, as no one hook can be held back.

import type { EngineInterface } from 'claude-code'

import type { GuardRequest } from '../../types'
import { loadDecisions, noteChecked, wasChecked, type Decision } from '../guard/decisions'
import { scanOnly, showScan, showUnverified, type ScanHow } from '../guard/run'
import { modHost } from '../mod-host'
import { row } from '../scan/checks/types'
import type { Host } from '../scan/host'
import { safeLine } from '../scan/safe-text'
import type { ScanReport } from '../scan/scan'
import { laidHash, MCP_ROOT, mcpCandidate, settingsReport, settingsTree } from './gate'
import { day } from './load'
import { mcpServerProblem } from './requests'
import { expandHome } from './resolve'
import { runsOf, settingsChange, stable } from './settings'
import { landsAt, MAX_CONFIG_BYTES, normalizePath, parseObject, serversIn, slashed, type McpEntry } from './writes'

/** An MCP server or a settings file in your configuration that you have not approved. */
export type FoundConfig = {
  /** `mcp <scope> <name>`, `settings <path>` or `file <path>`: what it is, and how to remove it. */
  key: string
  label: string
  /** The tree hash the pane keeps its decision under; absent when it could not be read. */
  treeHash?: string
  /** Why it waits, in the guard's own words. */
  why: string
  /** You rejected it: it is named once, never opened in the pane again. */
  rejected?: true
  /** Named before: /guard held lists it, but no toast names it and the pane does not open on it by itself. */
  quiet?: true
  /** How the pane shows it again; absent when it could not be read. */
  how?: ScanHow
  /** What the check found, shown in the pane as it is rather than made again. */
  report?: ScanReport
}

/** A configured MCP server as its tools are named: what the tool hook refuses by. */
export type ServerTools = { key: string; label: string; tools: string; hashes: string[] }

/**
 * What the check found: what waits for you, and the servers named once as
 * checked. `baseline` marks the first check on this machine, which names
 * what was already there without opening the pane.
 */
export type ConfigCheck = { found: FoundConfig[]; checked: string[]; baseline: boolean }

/** Where the session's configuration is: the folder it started in, and the one CLAUDE_CONFIG_DIR names, if any. */
export type ConfigPlace = { cwd: string; configDir: string | undefined }

/** The first check on this machine, and what it left waiting, so /guard held lists it in later sessions without naming it again. */
const BASELINE = 'config-baseline'
type Baseline = { at: number; waiting: { treeHash: string; why: string }[] }
const MAX_WAITING = 200

/**
 * What each settings file ran when you last approved it, newest first, so a
 * change is shown as what it adds and takes away.
 */
const KEPT = 'settings-kept'
type Kept = { path: string; runs: string }[]
const MAX_KEPT = 50
const MAX_KEPT_CHARS = 64 * 1024

/** A server name a command can be given as one word. */
const SERVER_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/

/**
 * One MCP server or settings file, read and hashed but not yet judged.
 * `treeHash` is what the pane keeps a decision under; `hashes` holds it
 * first, then each other form an approval of the same thing was kept under.
 */
type Unit =
  | { kind: 'mcp'; key: string; label: string; treeHash: string; hashes: string[]; how: Extract<ScanHow, { files: unknown }>; tools: string }
  /** `treeHash` pins what the file runs; `hashes` adds the whole file, as the write gate pins it. */
  | { kind: 'settings'; key: string; label: string; treeHash: string; hashes: string[]; path: string; runs: Record<string, unknown>; runsText: string }

/**
 * Compares every MCP server and settings file in your configuration with
 * what you approved. Each is named once: a server with no red flags, each
 * rejection, and, at the first check on this machine, everything already
 * there, since you chose those before the guard looked. After that, a new or
 * changed one with a red flag, or a settings file that runs something new or
 * no longer runs something you approved, waits each session until you
 * decide. A file that cannot be read waits as Could not verify.
 */
export async function checkConfigured($: EngineInterface, place: ConfigPlace, lookups: boolean): Promise<ConfigCheck> {
  const host = modHost($)
  const { units, unreadable } = await readUnits(host, place)
  const decisions = await loadDecisions($)
  const known = await loadBaseline($)
  const baseline = known === undefined
  const kept = await loadKept($)
  const waiting: Baseline['waiting'] = []
  const found: FoundConfig[] = [...unreadable]
  const checked: string[] = []
  for (const unit of units) {
    // A file that runs nothing, and ran nothing you approved, has nothing to judge.
    if (unit.kind === 'settings' && Object.keys(unit.runs).length === 0 && !kept.some(item => item.path === unit.path)) continue
    // Decisions are kept newest first: the newest for any form of it stands.
    const decided = decisions.find(item => unit.hashes.includes(item.treeHash))
    if (decided?.decision === 'approved') {
      if (unit.kind === 'settings') await keep($, kept, unit)
      continue
    }
    const how: ScanHow = unit.kind === 'mcp' ? unit.how : { files: {}, root: unit.path, kind: 'settings' }
    const base = { key: unit.key, label: unit.label, treeHash: unit.treeHash, how }
    const report = unit.kind === 'settings' ? await settingsFound(unit, kept) : undefined
    const shown = report === undefined ? {} : { report }
    // Kept every session, so /guard held lists it; named once, by when it was rejected.
    if (decided?.decision === 'rejected') {
      const fresh = await noteChecked($, `rejected ${decided.treeHash} ${decided.decidedAt}`)
      found.push({ ...base, ...shown, why: `you rejected it on ${day(decided.decidedAt)}`, rejected: true, ...(fresh ? {} : { quiet: true as const }) })
      continue
    }
    const before = known?.waiting.find(item => item.treeHash === unit.treeHash)
    if (before !== undefined) {
      found.push({ ...base, ...shown, why: before.why, quiet: true })
      continue
    }
    if (unit.kind === 'mcp' && (await wasChecked($, unit.treeHash))) continue
    const judged = report ?? (await scanOnly(host, unit.label, how, { lookups }).catch((error: unknown) => (error instanceof Error ? error.message : String(error))))
    // Its hash is known all the same, so a rejection of it is kept, and its tools refused.
    if (typeof judged === 'string') {
      found.push({ ...base, why: `the scan failed (${safeLine(judged)})` })
      continue
    }
    if (judged.verdict.kind === 'safe') {
      // A server is named once; a settings file that only runs less is taken as what it now runs.
      if (unit.kind === 'mcp') {
        if (await noteChecked($, unit.treeHash)) checked.push(unit.label)
      } else await keep($, kept, unit)
      continue
    }
    const why = judged.verdict.recommendation
    if (baseline) waiting.push({ treeHash: unit.treeHash, why })
    found.push({ ...base, why, report: judged })
  }
  if (baseline) await $.store.set(BASELINE, { at: Date.now(), waiting: waiting.slice(0, MAX_WAITING) } satisfies Baseline)
  return { found, checked, baseline }
}

/**
 * What the configuration holds now, for /guard held, which lists only what
 * is still there: the hashes of what it reads, and the files it cannot.
 */
export async function configuredNow($: EngineInterface, place: ConfigPlace): Promise<{ hashes: Set<string>; unreadable: Set<string> }> {
  const { units, unreadable } = await readUnits(modHost($), place)
  return { hashes: new Set(units.flatMap(unit => unit.hashes)), unreadable: new Set(unreadable.map(item => item.key)) }
}

/**
 * The MCP servers in your configuration, as their tools are named, for the
 * tool hook: read when a session's first MCP tool is called, whether or not
 * the check has run, so a server you rejected before is refused from the
 * start, in any session. `blind` says a file that holds servers is there but
 * could not be read, so a tool may come from a server not listed.
 */
export async function configuredServers($: EngineInterface, place: ConfigPlace): Promise<{ servers: ServerTools[]; blind: boolean }> {
  const { units, unreadable } = await readUnits(modHost($), place)
  const servers = units.flatMap(unit => (unit.kind === 'mcp' ? [{ key: unit.key, label: unit.label, tools: unit.tools, hashes: unit.hashes }] : []))
  return { servers, blind: unreadable.some(item => /(?:^|\/)\.(?:claude|mcp)\.json$/.test(item.key)) }
}

/**
 * When the configuration could not be read: the refusal for a tool whose
 * name matches a server you rejected by name, whatever its configuration
 * now, or undefined. A refusal too many, never one too few.
 */
export function refusalByName(tool: string, decisions: readonly Decision[]): string | undefined {
  // Several servers decided at once are joined by `+`, which a name of one may hold too: each reading counts.
  const names = (root: string): string[] => [root, ...root.split('+')]
  const rejected = decisions.find(
    decision =>
      decision.decision === 'rejected' &&
      decision.root?.startsWith(`${MCP_ROOT}/`) === true &&
      names(decision.root.slice(MCP_ROOT.length + 1)).some(name => tool.startsWith(toolsOf(name))),
  )
  if (rejected === undefined) return undefined
  return `AI Install Guard refused this tool: the person rejected an MCP server by this name (${safeLine(rejected.target)}), and the guard could not read the configuration to tell whether this tool comes from it. Tell the person.`
}

/** How Claude Code begins the names of a server's tools: every character but a letter, digit, `_` or `-` made `_`. */
function toolsOf(name: string): string {
  return `mcp__${name.replace(/[^A-Za-z0-9_-]/g, '_')}__`
}

/**
 * Reads the configuration: your MCP servers and this folder's in your
 * .claude.json, this folder's .mcp.json, and your own and this folder's
 * settings files. An administrator's managed settings are theirs. A file
 * that does not parse holds nothing Claude Code could use; one that is there
 * but cannot be read is named as such.
 */
async function readUnits(host: Host, place: ConfigPlace): Promise<{ units: Unit[]; unreadable: FoundConfig[] }> {
  const home = await expandHome(host, '~')
  const units: Unit[] = []
  const unreadable: FoundConfig[] = []
  const read = async (raw: string): Promise<{ path: string; text: string | undefined }> => {
    // Read where it really is, so a link to a file is the same file.
    const path = normalizePath(await landsAt(host, slashed(raw)))
    const text = await readConfig(host, path)
    if (typeof text !== 'object') return { path, text }
    unreadable.push({ key: `file ${path}`, label: safeLine(path), why: text.why })
    return { path, text: undefined }
  }
  const project = normalizePath(slashed(place.cwd))
  // The folder where it really is too, as Claude Code may keep it (macOS's /tmp is /private/tmp).
  const real = normalizePath(await landsAt(host, slashed(place.cwd)))
  const folders = [...new Set([project, real])]
  const own = await read(place.configDir === undefined ? `${home}/.claude.json` : `${place.configDir}/.claude.json`)
  const shared = await read(`${place.cwd}/.mcp.json`)
  // Scoped as the write gate scopes them, so a server you approved as Claude wrote it is the same server here.
  const local = new Set([place.cwd, ...folders].map(folder => `local ${folder}`))
  const servers = [
    ...(serversIn(own.text ?? '', 'mcp-user', '') ?? []).filter(entry => entry.scope === 'user' || local.has(entry.scope)),
    ...(serversIn(shared.text ?? '', 'mcp-project', project) ?? []),
  ]
  for (const entry of servers) {
    // Claude Code starts no server whose configuration is no object.
    if (entry.invalid === true) continue
    const scope = entry.scope.split(' ')[0] as string
    const label = `MCP server ${safeLine(entry.name)} (${scope} scope)`
    const laid = mcpCandidate([entry])
    // What the add and write gates refuse to approve here is a running server: it is shown as worth a look instead.
    const problem = mcpServerProblem(entry.name, entry.server)
    const how = problem === undefined ? laid : { ...laid, notes: [...(laid.notes ?? []), problemRow(problem)] }
    const hashes = await serverHashes(entry, folders)
    units.push({ kind: 'mcp', key: `mcp ${scope} ${entry.name}`, label, treeHash: hashes[0] as string, hashes, how, tools: toolsOf(entry.name) })
  }
  const files = new Set<string>()
  // Your own folder's settings, then this folder's shared and personal ones.
  const yours = place.configDir ?? `${home}/.claude`
  const folder = `${place.cwd}/.claude`
  for (const raw of [`${yours}/settings.json`, `${folder}/settings.json`, `${folder}/settings.local.json`]) {
    const { path, text } = await read(raw)
    // Started in the home folder, the folder's settings are your own: read once.
    if (files.has(path)) continue
    files.add(path)
    // A file gone, or one that does not parse, runs nothing: what it ran before is then taken away.
    const parsed = parseObject(text ?? '')
    const runs = parsed === undefined ? {} : runsOf(parsed)
    const runsText = stable(runs)
    const [pinned, whole] = await Promise.all([settingsTree(path, runsText), settingsTree(path, text ?? '')])
    units.push({ kind: 'settings', key: `settings ${path}`, label: `settings file ${safeLine(path)}`, treeHash: pinned.hash, hashes: [pinned.hash, whole.hash], path, runs, runsText })
  }
  return { units, unreadable }
}

/**
 * A configuration file as text; undefined when it is not there (or a path on
 * the way is a file); or why it could not be read, when it is there.
 */
async function readConfig(host: Host, path: string): Promise<string | undefined | { why: string }> {
  let size: number
  try {
    size = (await host.stat(path)).size
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return /\b(?:ENOENT|ENOTDIR)\b/.test(message) ? undefined : { why: `the guard could not look at it (${safeLine(message)})` }
  }
  if (size > MAX_CONFIG_BYTES) return { why: `it is ${size} bytes, more than the guard reads` }
  try {
    return new TextDecoder().decode(await host.readBytes(path))
  } catch {
    return { why: 'the guard could not read it' }
  }
}

/**
 * Every form an approval of this server may have been kept under, its own
 * first: scoped as the write gate scopes it, under either name of the folder,
 * or by its scope's name alone as `claude mcp add` scopes it, and as written
 * here or as that command builds it, with what Claude Code adds as it saves
 * it (`"type": "stdio"`, an empty `env`) taken away.
 */
async function serverHashes(entry: McpEntry, folders: readonly string[]): Promise<string[]> {
  const word = entry.scope.split(' ')[0] as string
  const scopes = word === 'user' ? ['user'] : [entry.scope, ...folders.map(folder => `${word} ${folder}`), word]
  const forms = [entry.server, asAdded(entry.server)].filter((server, at, all) => all.findIndex(other => stable(other) === stable(server)) === at)
  const hashes: string[] = []
  for (const scope of new Set(scopes)) for (const server of forms) hashes.push(await laidHash(mcpCandidate([{ name: entry.name, scope, server }])))
  return [...new Set(hashes)]
}

/** A server's configuration as `claude mcp add` builds it before Claude Code saves it. */
function asAdded(server: Record<string, unknown>): Record<string, unknown> {
  const out = { ...server }
  if (out.type === 'stdio' && typeof out.command === 'string') delete out.type
  for (const key of ['env', 'headers']) if (isRecord(out[key]) && Object.keys(out[key] as object).length === 0) delete out[key]
  return out
}

/** What the guard does not check in a server's configuration, as a row of its report. */
function problemRow(problem: string) {
  return row(
    {
      id: 'mcp.config',
      group: 'mcp',
      title: 'What the guard could not check',
      advice: 'Claude Code reads more of this configuration than the guard checks, or fills part of it in as the server starts. Keep it only if you know where it came from.',
    },
    [{ file: '.mcp.json', excerpt: safeLine(problem), status: 'warn' }],
  )
}

/**
 * A settings file's report: what it runs now that it did not when you last
 * approved it, and what it no longer runs, or all it runs when you never did.
 */
async function settingsFound(unit: Extract<Unit, { kind: 'settings' }>, kept: Kept): Promise<ScanReport> {
  const earlier = kept.find(item => item.path === unit.path)?.runs
  const before = earlier === undefined ? undefined : parseObject(earlier)
  const evidence = settingsChange(before ?? {}, unit.runs, safeLine(unit.path))
  const title = before === undefined ? 'What this file runs on its own' : 'What changed in what it runs since you approved it'
  return settingsReport(unit.label, unit.path, unit.runsText, evidence, title)
}

/** Remembers what a settings file runs as approved, so its next change is shown against it. */
async function keep($: EngineInterface, kept: Kept, unit: Extract<Unit, { kind: 'settings' }>): Promise<void> {
  const at = kept.findIndex(item => item.path === unit.path)
  if (at !== -1 && kept[at]?.runs === unit.runsText) return
  if (at !== -1) kept.splice(at, 1)
  // One too large to keep is shown whole next time.
  if (unit.runsText.length <= MAX_KEPT_CHARS) kept.unshift({ path: unit.path, runs: unit.runsText })
  kept.splice(MAX_KEPT)
  await $.store.set(KEPT, kept)
}

async function loadKept($: EngineInterface): Promise<Kept> {
  const stored = await $.store.get(KEPT)
  return Array.isArray(stored) ? (stored as unknown[]).filter((item): item is Kept[number] => isRecord(item) && typeof item.path === 'string' && typeof item.runs === 'string') : []
}

async function loadBaseline($: EngineInterface): Promise<Baseline | undefined> {
  const stored = await $.store.get(BASELINE)
  if (stored == null) return undefined
  const listed = isRecord(stored) && Array.isArray(stored.waiting) ? (stored.waiting as unknown[]) : []
  const waiting = listed.filter((item): item is Baseline['waiting'][number] => isRecord(item) && typeof item.treeHash === 'string' && typeof item.why === 'string')
  return { at: isRecord(stored) && typeof stored.at === 'number' ? stored.at : 0, waiting }
}

/**
 * The toast for what the check found: what waits for you, then the servers
 * checked and named once. Nothing to say is undefined.
 */
export function configToast(check: ConfigCheck, opensPane: boolean): string | undefined {
  const { found, checked } = check
  if (check.baseline) {
    if (found.length + checked.length === 0) return undefined
    const look = found.length === 0 ? 'no red flags' : `${checked.length} with no red flags, and ${found.length} worth your look when you like: ${labels(found)}. /guard held opens them one at a time`
    return `AI Install Guard looked at the ${nouns([...found, ...checked.map(() => ({ key: 'mcp' }))])} in your configuration that it had not checked: ${look}. From now on, it checks one that is new or changed as a session starts.`
  }
  const parts: string[] = []
  // What was named before waits quietly, for /guard held.
  const named = found.filter(item => item.quiet !== true)
  if (named.length > 0) {
    const one = named.length === 1
    const after = named.every(item => item.rejected === true)
      ? `You rejected ${one ? 'it' : 'them'}: /guard held says how to remove ${one ? 'it' : 'each'}.`
      : opensPane
        ? 'The pane shows the first: keep it, or reject it. /guard held lists them all.'
        : '/guard held lists them and opens the first in the pane.'
    parts.push(`AI Install Guard found ${nouns(named)} in your configuration that you have not approved: ${labels(named)}. ${after}`)
  }
  if (checked.length > 0) parts.push(`AI Install Guard checked ${count(checked.length, 'MCP server')} new since it last looked: no red flags (${checked.join(', ')}).`)
  return parts.length === 0 ? undefined : parts.join(' ')
}

/** The first one the pane should open by itself: not one you rejected, nor one named before. */
export function toReviewConfig(found: readonly FoundConfig[]): FoundConfig | undefined {
  return found.find(item => item.rejected !== true && item.quiet !== true)
}

/**
 * Shows one in the pane, with Keep and Reject; Could not verify when it
 * could not be read. Only when the pane holds no verdict still waiting for
 * you; says whether the pane shows it.
 */
export async function reviewConfig($: EngineInterface, item: FoundConfig, lookups: boolean): Promise<boolean> {
  const request: GuardRequest = { origin: 'command', args: item.key, label: item.label, subject: 'configured', display: `In your configuration, not approved: ${item.label}` }
  const options = { action: 'approve' as const, request, lookups, report: item.report, ifFree: true }
  if (item.how === undefined || item.treeHash === undefined) return !(await showUnverified($, item.label, item.why, options)).superseded
  return !(await showScan($, item.label, item.how, options)).superseded
}

/** Each one found and where it stands, and the first still undecided. */
export function configStatus(found: readonly FoundConfig[], decisions: readonly Decision[]): { lines: string[]; next?: FoundConfig } {
  const decisionOf = (item: FoundConfig): Decision | undefined => (item.treeHash === undefined ? undefined : decisions.find(decision => decision.treeHash === item.treeHash))
  const lines = found.map(item => {
    const decided = decisionOf(item)
    if (decided?.decision === 'approved') return `  ${item.label}: kept`
    const when = decided === undefined ? undefined : day(decided.decidedAt)
    if (when === undefined && item.rejected !== true) return `  ${item.label}: ${item.why}`
    return `  ${item.label}: ${when === undefined ? item.why : `you rejected it on ${when}`}; ${removal(item.key, true)}`
  })
  return { lines, next: found.find(item => item.rejected !== true && decisionOf(item) === undefined) }
}

/**
 * What the pane says once you reject one: what the guard does about it, and
 * how to remove it. `recorded` is false when nothing could be recorded, so
 * nothing is refused either.
 */
export function rejectedNote(request: GuardRequest, recorded: boolean): string {
  if (!recorded) return `AI Install Guard: closed ${request.label}; the guard could not check it, so nothing was recorded and nothing is refused; ${removal(request.args, false)}`
  return `AI Install Guard: rejected ${request.label}; ${removal(request.args, true)}`
}

/** The servers in your configuration a tool by this name may come from. */
export function servingTool(servers: readonly ServerTools[], tool: string): ServerTools[] {
  return servers.filter(server => tool.startsWith(server.tools))
}

/**
 * The refusal Claude reads for a tool one of `servers` serves that you
 * rejected, or undefined. A server is found by its name alone, which may
 * cover another whose name differs only where Claude Code makes it `_`: a
 * refusal too many, never one too few.
 */
export function toolRefusal(servers: readonly ServerTools[], decisions: readonly Decision[]): string | undefined {
  const rejected = servers.find(server => decisions.find(decision => server.hashes.includes(decision.treeHash))?.decision === 'rejected')
  if (rejected === undefined) return undefined
  return `AI Install Guard refused this tool: it comes from the ${rejected.label}, which the person rejected. Tell the person; ${removal(rejected.key, true)}.`
}

/** How one rejected item is dealt with: the guard does not change your configuration itself. */
function removal(key: string, refuses: boolean): string {
  const [kind, scope, ...rest] = key.split(' ')
  if (kind === 'mcp') {
    const name = rest.join(' ')
    const refused = refuses ? 'the guard refuses its tools; ' : ''
    if (!SERVER_NAME.test(name)) return `${refused}remove it in /mcp`
    return `${refused}claude mcp remove ${name} -s ${scope}${scope === 'local' ? ', run in this folder,' : ''} removes it`
  }
  const path = safeLine(key.slice(key.indexOf(' ') + 1))
  if (kind === 'file') return `the guard could not read ${path}, so nothing in it was judged`
  return `the guard cannot hold back one hook on its own: remove what you do not want from ${path}`
}

/** `2 MCP servers and 1 settings file`, by what each one is. */
function nouns(items: readonly { key: string }[]): string {
  const kinds = [
    ['mcp', 'MCP server'],
    ['settings', 'settings file'],
    ['file', 'configuration file'],
  ] as const
  return kinds
    .map(([kind, noun]) => ({ n: items.filter(item => item.key.split(' ')[0] === kind).length, noun }))
    .filter(part => part.n > 0)
    .map(part => count(part.n, part.noun))
    .join(' and ')
}

function labels(items: readonly FoundConfig[]): string {
  return items.map(item => item.label).join(', ')
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

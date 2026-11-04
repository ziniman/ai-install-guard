// After a shell command whose code the guard cannot read: what it changed
// where Claude Code loads from. Before such code runs, the guard cannot tell
// what it writes, and holding every command whose code names a `.claude`
// path held ordinary work that only reads or mentions one. So the command
// runs, and each place it names that nothing else checks before Claude Code
// uses it is compared before and after: settings files, MCP configurations,
// agents and output styles, and the plugins Claude Code installed. A skill or
// a command needs no look here, since the skill gate checks it before it is
// used, and a mod none, since the load gate does. A change with no red flags
// goes on with a note; anything else waits in the pane, and one that takes
// effect at once (a settings file that widens what Claude may do, an agent or
// output style with a red flag) leaves Claude only reading and writing files
// until the person decides. Nothing here runs anything: it lists, reads and
// hashes.

import type { EngineInterface } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { GuardLock } from '../../types'
import { decisionFor, loadDecisions, noteChecked } from '../guard/decisions'
import { scanOnly } from '../guard/run'
import { modHost } from '../mod-host'
import { sha256Hex } from '../scan/hash'
import type { Host } from '../scan/host'
import { takeInventory } from '../scan/inventory'
import { safeLine } from '../scan/safe-text'
import { problemRow, type FoundConfig } from './configured'
import { laidHash, mcpCandidate, promptCandidate, settingsReport, settingsTree } from './gate'
import type { FoundPlugin } from './installed'
import { mcpServerProblem } from './requests'
import { landsAt, MAX_CONFIG_BYTES, normalizePath, readMade, readText, slashed, type WriteReading } from './writes'

/** The places one command is looked at in. */
export type Watch = {
  /** Settings files and MCP configurations, compared by their text. */
  files: string[]
  /** Folders of agents or output styles, compared file by file. */
  prompts: string[]
  /** Plugin folders, compared by what they hold as listed. */
  plugins: string[]
  /** The lists of plugins Claude Code installed, compared by each plugin's entry. */
  registry: string[]
}

/** What each place held before the command ran. */
export type Snapshot = {
  files: Map<string, string | undefined>
  prompts: Map<string, Map<string, string>>
  plugins: Map<string, string>
  registry: Map<string, string | undefined>
}

/** A change the command made, read as the gate judges it. */
export type Made = { kind: 'reading'; path: string; reading: Exclude<WriteReading, { kind: 'pass' }> } | { kind: 'plugin'; root: string; id: string }

/**
 * The places a command's code names, read from `named` (as `namedPlaces`
 * finds them): a relative one from `cwd`, and from the home folder too, since
 * code joins `.claude` onto a root it has. A `.claude` folder named whole is
 * watched in each part; a path into one, in the part it reaches. A path that
 * leads through a link counts where it lands as well.
 */
export async function watchFor(host: Host, named: readonly string[], cwd: string | undefined, home: string | undefined, configDir: string | undefined): Promise<Watch> {
  const watch: Watch = { files: [], prompts: [], plugins: [], registry: [] }
  const add = (list: string[], path: string): void => {
    if (!list.includes(path)) list.push(path)
  }
  const whole = (root: string): void => {
    add(watch.files, `${root}/settings.json`)
    add(watch.files, `${root}/settings.local.json`)
    add(watch.prompts, `${root}/agents`)
    add(watch.prompts, `${root}/output-styles`)
    add(watch.registry, `${root}/plugins/installed_plugins.json`)
  }
  const part = (root: string, tail: readonly string[]): void => {
    const [first, second, ...rest] = tail
    if (first === undefined) return whole(root)
    const name = first.toLowerCase()
    if (name === 'settings.json' || name === 'settings.local.json') add(watch.files, `${root}/${first}`)
    else if (name === 'agents' || name === 'output-styles') add(watch.prompts, `${root}/${first}`)
    else if (name === 'plugins') {
      add(watch.registry, `${root}/plugins/installed_plugins.json`)
      // One plugin's own folder: cache/<marketplace>/<plugin>/<version>.
      if (second?.toLowerCase() === 'cache' && rest.length >= 3) add(watch.plugins, `${root}/plugins/cache/${rest.slice(0, 3).join('/')}`)
    }
  }
  const classify = (path: string): void => {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
    if (name === '.mcp.json' || name === '.claude.json' || name === 'managed-settings.json') add(watch.files, path)
    const dir = configDir === undefined ? undefined : normalizePath(configDir).replace(/\/+$/, '')
    if (dir !== undefined && (path === dir || path.toLowerCase().startsWith(`${dir.toLowerCase()}/`))) part(dir, path.slice(dir.length).split('/').filter(Boolean))
    for (const match of path.matchAll(/(?:^|\/)\.claude(?=\/|$)/gi)) {
      const end = (match.index ?? 0) + match[0].length
      part(path.slice(0, end), path.slice(end).split('/').filter(Boolean))
    }
  }
  const resolve = (raw: string): string[] => {
    const path = slashed(raw)
    if (path === '~' || path.startsWith('~/')) return home === undefined ? [] : [`${home}${path.slice(1)}`]
    if (path.startsWith('~')) return []
    if (/^(?:\/|[A-Za-z]:\/)/.test(path)) return [path]
    return [cwd, home].filter((root): root is string => root !== undefined).map(root => `${root.replace(/\/+$/, '')}/${path}`)
  }
  for (const raw of named) {
    if (raw === '$CLAUDE_CONFIG_DIR') {
      const yours = configDir ?? (home === undefined ? undefined : `${home}/.claude`)
      if (yours !== undefined) whole(normalizePath(yours))
      continue
    }
    for (const path of resolve(raw)) {
      const plain = normalizePath(path)
      classify(plain)
      const landed = normalizePath(await landsAt(host, plain).catch(() => plain))
      if (landed !== plain) classify(landed)
    }
  }
  return watch
}

/** What each watched place holds now. */
export async function snapshot(host: Host, watch: Watch): Promise<Snapshot> {
  const files = new Map<string, string | undefined>()
  for (const path of watch.files) files.set(path, await textOf(host, path))
  const prompts = new Map<string, Map<string, string>>()
  for (const folder of watch.prompts) prompts.set(folder, await filesIn(host, folder))
  const plugins = new Map<string, string>()
  for (const root of watch.plugins) plugins.set(root, await listed(host, root))
  const registry = new Map<string, string | undefined>()
  for (const path of watch.registry) registry.set(path, await textOf(host, path))
  return { files, prompts, plugins, registry }
}

/** What the command changed in the watched places, as the gate reads each change. */
export async function changesSince(host: Host, watch: Watch, before: Snapshot, configDir: string | undefined): Promise<Made[]> {
  const made: Made[] = []
  for (const path of watch.files) {
    const was = before.files.get(path)
    if ((await textOf(host, path)) === was) continue
    const reading = await readMade(host, path, was === UNREADABLE ? undefined : was, configDir)
    if (reading.kind !== 'pass') made.push({ kind: 'reading', path, reading })
  }
  for (const folder of watch.prompts) {
    const was = before.prompts.get(folder) ?? new Map<string, string>()
    for (const [rel, hash] of await filesIn(host, folder)) {
      if (was.get(rel) === hash) continue
      const reading = await readMade(host, `${folder}/${rel}`, undefined, configDir)
      if (reading.kind !== 'pass') made.push({ kind: 'reading', path: `${folder}/${rel}`, reading })
    }
  }
  const ids = new Map<string, string>()
  for (const path of watch.registry) {
    const now = await textOf(host, path)
    for (const [root, id] of installedIn(now)) ids.set(root, id)
    // A plugin added to the list, or moved to other files, outside any install.
    for (const [root, id] of changedEntries(before.registry.get(path), now)) made.push({ kind: 'plugin', root, id })
  }
  for (const root of watch.plugins) {
    if ((await listed(host, root)) === before.plugins.get(root)) continue
    if (!made.some(item => item.kind === 'plugin' && item.root === root)) made.push({ kind: 'plugin', root, id: ids.get(root) ?? '' })
  }
  return made
}

/** What the gate makes of the changes: the notes to show, and what waits for the person, with any lock it puts on. */
export type Judged = { notes: string[]; configs: FoundConfig[]; plugins: FoundPlugin[]; locks: GuardLock[] }

/**
 * Judges each change the command made, as the write gate judges a Write of
 * it, but after the fact: what was approved before, or has no red flags,
 * goes on; anything else waits.
 */
export async function judgeMade($: EngineInterface, made: readonly Made[], lookups: boolean): Promise<Judged> {
  const host = modHost($)
  const judged: Judged = { notes: [], configs: [], plugins: [], locks: [] }
  const display = (label: string): string => `Changed by a command Claude ran: ${label}`
  for (const one of made) {
    if (one.kind === 'plugin') {
      const label = safeLine(one.id === '' ? one.root : one.id)
      const tree = await takeInventory(host, one.root).then(
        scanned => scanned.inventory.treeHash,
        () => undefined,
      )
      const base = { id: one.id, label, root: one.root, display: display(label) }
      if (tree === undefined) {
        judged.plugins.push({ ...base, why: 'the command changed its files, and the guard could not read them' })
        continue
      }
      const decided = (await loadDecisions($)).find(item => item.treeHash === tree)
      if (decided?.decision === 'approved') continue
      const report = await scanOnly(host, label, { folder: one.root }, { lookups }).catch(() => undefined)
      const mod = report?.results.some(result => result.group === 'mod') === true
      if (decided === undefined && report?.verdict.kind === 'safe' && !mod) {
        await noteChecked($, tree).catch(() => false)
        judged.notes.push(`AI Install Guard: the command changed the files of ${label}; checked them: No red flags`)
        continue
      }
      const why = decided?.decision === 'rejected' ? 'the command changed its files to ones you rejected' : report === undefined ? 'the command changed its files, and the scan failed' : `the command changed its files: ${report.verdict.recommendation}`
      judged.plugins.push({ ...base, treeHash: tree, why, ...(report === undefined ? {} : { report }) })
      continue
    }
    const { reading, path } = one
    if (reading.kind === 'unreadable') {
      judged.configs.push({ key: `file ${path}`, label: reading.label, why: reading.reason, display: display(reading.label) })
      continue
    }
    if (reading.kind === 'settings') {
      const { hash } = await settingsTree(reading.path, reading.content)
      const report = await settingsReport(reading.label, reading.path, reading.content, reading.evidence, 'What the change lets Claude do')
      const decided = await decisionFor($, { treeHash: hash }, report.verdict.kind).catch(() => undefined)
      if (decided?.decision === 'approved') continue
      judged.configs.push({ key: `settings ${reading.path}`, label: reading.label, treeHash: hash, why: 'it widens what Claude may do', how: { files: {}, root: reading.path, kind: 'settings change' }, report, display: display(reading.label) })
      judged.locks.push({ label: reading.label, treeHash: hash, path: reading.path, hash: await contentHash(host, reading.path), settings: true })
      continue
    }
    if (reading.kind === 'mcp') {
      for (const entry of reading.servers) {
        const laid = mcpCandidate([entry])
        const problem = mcpServerProblem(entry.name, entry.server)
        const how = problem === undefined ? laid : { ...laid, notes: [...(laid.notes ?? []), problemRow(problem)] }
        const treeHash = await laidHash(laid)
        const label = `MCP server ${safeLine(entry.name)} (${entry.scope.split(' ')[0] ?? 'user'} scope)`
        const decided = (await loadDecisions($)).find(item => item.treeHash === treeHash)
        if (decided?.decision === 'approved') continue
        const report = await scanOnly(host, label, how, { lookups }).catch(() => undefined)
        if (decided === undefined && report?.verdict.kind === 'safe') {
          await noteChecked($, treeHash).catch(() => false)
          judged.notes.push(`AI Install Guard: the command added ${label}; checked it: No red flags`)
          continue
        }
        const why = decided?.decision === 'rejected' ? 'you rejected this server before' : report === undefined ? 'the scan failed' : report.verdict.recommendation
        judged.configs.push({ key: `mcp ${entry.scope.split(' ')[0] ?? 'user'} ${entry.name}`, label, treeHash, why, how, ...(report === undefined ? {} : { report }), display: display(label) })
      }
      continue
    }
    // An agent or an output style: what it says is used as soon as Claude reaches for it.
    const how = await promptCandidate(host, reading)
    const report = await scanOnly(host, reading.label, how, { lookups }).catch(() => undefined)
    const treeHash = report?.inventory?.treeHash
    if (report !== undefined && treeHash !== undefined) {
      const decided = await decisionFor($, { treeHash }, report.verdict.kind).catch(() => undefined)
      if (decided?.decision === 'approved') continue
      if (decided === undefined && report.verdict.kind === 'safe') {
        await noteChecked($, treeHash).catch(() => false)
        judged.notes.push(`AI Install Guard: the command changed ${reading.label}; checked it: No red flags`)
        continue
      }
    }
    const why = report === undefined ? 'the scan failed' : report.verdict.recommendation
    judged.configs.push({ key: `prompt ${path}`, label: reading.label, why, ...(treeHash === undefined ? {} : { treeHash, how, report }), display: display(reading.label) })
    if (treeHash !== undefined) judged.locks.push({ label: reading.label, treeHash, path, hash: await contentHash(host, path), settings: false })
  }
  return judged
}

const locksAtom = atom({ plugin: 'ai-install-guard', key: 'locks' } as const, [] as GuardLock[])

/** Adds locks for changes that wait, each once. */
export async function addLocks($: EngineInterface, locks: readonly GuardLock[]): Promise<void> {
  if (locks.length === 0) return
  await update($, locksAtom, current => [...current.filter(item => !locks.some(lock => lock.treeHash === item.treeHash && lock.path === item.path)), ...locks])
}

/**
 * The locks still on: a change you kept is let go, and one you rejected
 * once its file no longer holds it; the rest wait.
 */
export async function locksOn($: EngineInterface): Promise<GuardLock[]> {
  const current = await read($, locksAtom)
  if (current.length === 0) return current
  const decisions = await loadDecisions($)
  const host = modHost($)
  const on: GuardLock[] = []
  for (const lock of current) {
    const decided = decisions.find(item => item.treeHash === lock.treeHash)
    if (decided?.decision === 'approved') continue
    if (decided?.decision === 'rejected' && (await contentHash(host, lock.path)) !== lock.hash) continue
    on.push(lock)
  }
  if (on.length !== current.length) await update($, locksAtom, latest => latest.filter(item => on.some(lock => lock.treeHash === item.treeHash && lock.path === item.path)))
  return on
}

/** Tools that only read, or write files the write gate judges: what Claude may still use while a change waits. */
export const LOCK_FREE = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS', 'TodoWrite', 'ToolSearch', 'AskUserQuestion'])

/** What Claude reads for a tool refused while changes wait. */
export async function lockRefusal($: EngineInterface, locks: readonly GuardLock[]): Promise<string> {
  const decisions = await loadDecisions($).catch(() => [])
  const rejected = locks.filter(lock => decisions.some(item => item.treeHash === lock.treeHash && item.decision === 'rejected'))
  const names = locks.map(lock => lock.label).join(', ')
  const undo = rejected.length === 0 ? '' : ` The person rejected ${rejected.map(lock => lock.label).join(', ')}, which is still there: restore what the file held, with Edit or Write, or ask the person to.`
  return `AI Install Guard refused this tool: a command Claude ran changed ${names} where Claude Code loads from, and the change waits for the person's decision in the guard's pane (/guard held opens it).${undo} Until then, Claude may only read files and use Write or Edit. Tell the person.`
}

/** What a command's change that waits is called, for the note Claude reads with the command's result. */
export function madeNote(judged: Judged): string | undefined {
  const waiting = [...judged.configs.map(item => item.label), ...judged.plugins.map(item => item.label)]
  if (waiting.length === 0) return undefined
  const locked = judged.locks.length > 0 ? ' Until they decide, Claude may only read files and use Write or Edit.' : ''
  return `AI Install Guard: this command changed ${waiting.join(', ')} where Claude Code loads from, and the change waits for the person's decision in the guard's pane. Tell the person; do not change it again or work around it.${locked}`
}

/** Read where a file's text cannot be: there, but not readable. */
const UNREADABLE = '\u0000unreadable'

async function textOf(host: Host, path: string): Promise<string | undefined> {
  const text = await readText(host, path, MAX_CONFIG_BYTES)
  return 'text' in text ? text.text : UNREADABLE
}

async function contentHash(host: Host, path: string): Promise<string> {
  return sha256Hex((await textOf(host, path)) ?? '\u0000none')
}

/** A folder's files by path, each with its hash; empty when it is not there. */
async function filesIn(host: Host, folder: string): Promise<Map<string, string>> {
  const scanned = await takeInventory(host, folder).catch(() => undefined)
  const out = new Map<string, string>()
  for (const entry of scanned?.inventory.entries ?? []) {
    if (entry.kind === 'file') out.set(entry.path, entry.sha256)
    else if (entry.kind === 'link') out.set(entry.path, `link ${entry.target}`)
  }
  return out
}

/** The most entries a plugin folder is listed to: past it, the first ones are what is compared. */
const MAX_LISTED = 5000

/**
 * A plugin folder as it lists, entry by entry (kind, size, when it changed),
 * with Claude Code's in-use marks at its root left out: cheap to take before
 * and after, where reading every file would not be.
 */
async function listed(host: Host, root: string): Promise<string> {
  const lines: string[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await host.list(dir).catch(() => undefined)
    if (entries === undefined) {
      lines.push(`? ${rel}`)
      return
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (lines.length >= MAX_LISTED) return
      if (rel === '' && entry.name === '.in_use') continue
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      lines.push(`${entry.kind} ${entry.size} ${entry.mtimeMs ?? ''} ${entry.isLink ? 'link ' : ''}${path}`)
      if (entry.kind === 'dir' && !entry.isLink) await walk(`${dir}/${entry.name}`, path)
    }
  }
  await walk(root, '')
  return sha256Hex(lines.join('\n'))
}

/** Each plugin's folder in a list of installed plugins, with its id. */
function installedIn(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const [id, entries] of Object.entries(pluginsOf(text))) {
    for (const entry of entries) if (typeof entry.installPath === 'string') out.set(normalizePath(entry.installPath), id)
  }
  return out
}

/** The plugins a list gained, or whose entry changed (other files, another version), with their folders. */
function changedEntries(before: string | undefined, after: string | undefined): Map<string, string> {
  const was = pluginsOf(before)
  const out = new Map<string, string>()
  for (const [id, entries] of Object.entries(pluginsOf(after))) {
    const old = new Set((was[id] ?? []).map(entry => JSON.stringify([entry.installPath, entry.version, entry.gitCommitSha])))
    for (const entry of entries) {
      if (typeof entry.installPath !== 'string' || old.has(JSON.stringify([entry.installPath, entry.version, entry.gitCommitSha]))) continue
      out.set(normalizePath(entry.installPath), id)
    }
  }
  return out
}

function pluginsOf(text: string | undefined): Record<string, Record<string, unknown>[]> {
  try {
    const parsed: unknown = JSON.parse(text === undefined || text === UNREADABLE ? '{}' : text)
    const plugins = isRecord(parsed) && isRecord(parsed.plugins) ? parsed.plugins : {}
    return Object.fromEntries(Object.entries(plugins).map(([id, list]) => [id, Array.isArray(list) ? list.filter(isRecord) : []]))
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
// until the person decides, as an MCP server that waits has its tools
// refused. Nothing here runs anything: it lists, reads and hashes.

import type { EngineInterface } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { GuardChanged, GuardLock } from '../../types'
import { decisionFor, loadDecisions, noteChecked } from '../guard/decisions'
import { scanOnly } from '../guard/run'
import { modHost } from '../mod-host'
import { sha256Hex } from '../scan/hash'
import type { Host } from '../scan/host'
import { takeInventory } from '../scan/inventory'
import { safeLine } from '../scan/safe-text'
import { problemRow, toolsOf, type FoundConfig } from './configured'
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
  /** The copies of marketplaces it keeps, compared by what they hold as listed. */
  marketplaces: string[]
}

/** What each place held before the command ran. */
export type Snapshot = {
  files: Map<string, string | undefined>
  prompts: Map<string, Map<string, string>>
  plugins: Map<string, string>
  registry: Map<string, string | undefined>
  marketplaces: Map<string, string>
}

/** A change the command made, read as the gate judges it. */
export type Made =
  | { kind: 'reading'; path: string; reading: Exclude<WriteReading, { kind: 'pass' }> }
  | { kind: 'plugin'; root: string; id: string }
  /** A marketplace's copy: what it lists is scanned as it is installed, so the change is only named. */
  | { kind: 'marketplace'; root: string }

/**
 * The places a command's code names, read from `named` (as `namedPlaces`
 * finds them): a relative one from `cwd`, and from the home folder too, since
 * code joins `.claude` onto a root it has. A `.claude` folder named whole is
 * watched in each part; a path into one, in the part it reaches. Your own
 * folder named whole, or the plugins in it named by no one plugin's folder
 * (`plugins/cache`, a wildcard), has every plugin it installed watched. A
 * path that leads through a link counts where it lands as well.
 */
export async function watchFor(host: Host, named: readonly string[], cwd: string | undefined, home: string | undefined, configDir: string | undefined): Promise<Watch> {
  const watch: Watch = { files: [], prompts: [], plugins: [], registry: [], marketplaces: [] }
  const add = (list: string[], path: string): void => {
    if (!list.includes(path)) list.push(path)
  }
  const yours = normalizePath(configDir ?? (home === undefined ? '' : `${home}/.claude`))
  // Paths named in the folder plugins are installed in, each found to its plugin's own folder below.
  const cached: { cache: string; rest: string[] }[] = []
  // Folders whose plugins are watched, each one Claude Code installed.
  const every = new Set<string>()
  const whole = (root: string): void => {
    add(watch.files, `${root}/settings.json`)
    add(watch.files, `${root}/settings.local.json`)
    add(watch.prompts, `${root}/agents`)
    add(watch.prompts, `${root}/output-styles`)
    add(watch.registry, `${root}/plugins/installed_plugins.json`)
    if (yours !== '' && root.toLowerCase() === yours.toLowerCase()) every.add(root)
  }
  const part = (root: string, tail: readonly string[]): void => {
    const [first, second, ...rest] = tail
    // A wildcard in the first name (`settings*.json`, `*`) may reach any part of the folder.
    if (first === undefined || /[*?[{]/.test(first)) return whole(root)
    const name = first.toLowerCase()
    if (name === 'settings.json' || name === 'settings.local.json') add(watch.files, `${root}/${first}`)
    else if (name === 'agents' || name === 'output-styles') add(watch.prompts, `${root}/${first}`)
    else if (name === 'plugins') {
      add(watch.registry, `${root}/plugins/installed_plugins.json`)
      const where = second?.toLowerCase()
      if (where === undefined || (where === 'cache' && (rest.length === 0 || rest.some(item => /[*?[{]/.test(item))))) every.add(root)
      else if (where === 'cache') cached.push({ cache: `${root}/plugins/${second}`, rest })
      else if (where === 'marketplaces' && rest[0] !== undefined && !/[*?[{]/.test(rest[0])) add(watch.marketplaces, `${root}/plugins/${second}/${rest[0]}`)
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
      if (yours !== '') whole(yours)
      continue
    }
    for (const path of resolve(raw)) {
      const plain = normalizePath(path)
      classify(plain)
      const landed = normalizePath(await landsAt(host, plain).catch(() => plain))
      if (landed !== plain) classify(landed)
    }
  }
  // A plugin's own folder is cache/<marketplace>/<plugin>/<version>; a shorter path is the folder it names, or the one its file is in.
  for (const { cache, rest } of cached) {
    if (rest.length >= 3) {
      add(watch.plugins, `${cache}/${rest.slice(0, 3).join('/')}`)
      continue
    }
    const kind = (await host.stat(`${cache}/${rest.join('/')}`).catch(() => undefined))?.kind
    const folder = kind === 'dir' ? rest : rest.slice(0, -1)
    if (folder.length > 0) add(watch.plugins, `${cache}/${folder.join('/')}`)
  }
  for (const root of every) for (const plugin of installedIn(await textOf(host, `${root}/plugins/installed_plugins.json`)).keys()) add(watch.plugins, plugin)
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
  const marketplaces = new Map<string, string>()
  for (const root of watch.marketplaces) marketplaces.set(root, await listed(host, root))
  return { files, prompts, plugins, registry, marketplaces }
}

/** What the command changed in the watched places, as the gate reads each change. */
export async function changesSince(host: Host, watch: Watch, before: Snapshot, configDir: string | undefined): Promise<Made[]> {
  const made: Made[] = []
  for (const path of watch.files) {
    const was = before.files.get(path)
    if ((await textOf(host, path)) === was) continue
    const reading = await readMade(host, path, was?.startsWith(UNREADABLE) === true ? undefined : was, configDir)
    if (reading.kind !== 'pass') made.push({ kind: 'reading', path, reading })
  }
  for (const folder of watch.prompts) {
    const was = before.prompts.get(folder) ?? new Map<string, string>()
    const now = await filesIn(host, folder)
    // A folder that cannot be read now may hold anything.
    const blind = now.get(UNREADABLE)
    if (blind !== undefined) {
      if (was.get(UNREADABLE) !== blind) made.push({ kind: 'reading', path: folder, reading: { kind: 'unreadable', label: `a change to ${safeLine(folder)}`, reason: 'the guard could not read the folder after the command ran' } })
      continue
    }
    for (const [rel, hash] of now) {
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
    const now = await listed(host, root)
    // Too large to list whole, a plugin is judged by its files instead.
    if (now === before.plugins.get(root) && !now.startsWith(PARTIAL)) continue
    if (!made.some(item => item.kind === 'plugin' && item.root === root)) made.push({ kind: 'plugin', root, id: ids.get(root) ?? '' })
  }
  for (const root of watch.marketplaces) if ((await listed(host, root)) !== before.marketplaces.get(root)) made.push({ kind: 'marketplace', root })
  return made
}

/** What the gate makes of the changes: the notes to show, and what waits for the person, with any lock it puts on. */
export type Judged = { notes: string[]; configs: FoundConfig[]; plugins: FoundPlugin[]; locks: GuardLock[] }

/**
 * Judges each change the command made, as the write gate judges a Write of
 * it, but after the fact: what was approved at a verdict no better than the
 * one it gets now goes on, as does what has no red flags, named once;
 * anything else waits.
 */
export async function judgeMade($: EngineInterface, made: readonly Made[], lookups: boolean): Promise<Judged> {
  const host = modHost($)
  const judged: Judged = { notes: [], configs: [], plugins: [], locks: [] }
  const display = (label: string): string => `Changed by a command Claude ran: ${label}`
  const note = async (treeHash: string, text: string): Promise<void> => {
    if (await noteChecked($, treeHash).catch(() => false)) judged.notes.push(text)
  }
  for (const one of made) {
    if (one.kind === 'marketplace') {
      judged.notes.push(`AI Install Guard: the command changed the files of the marketplace ${safeLine(one.root.slice(one.root.lastIndexOf('/') + 1))}; a plugin from it is scanned as it is installed or updated`)
      continue
    }
    if (one.kind === 'plugin') {
      // The guard's own folder is not one it judges, as at the start of a session.
      if (normalizePath(one.root).replace(/\/+$/, '') === normalizePath($.plugin.root).replace(/\/+$/, '')) continue
      const label = safeLine(one.id === '' ? one.root : one.id)
      const base = { id: one.id, label, root: one.root, display: display(label) }
      const report = await scanOnly(host, label, { folder: one.root }, { lookups }).catch(() => undefined)
      const treeHash = report?.inventory?.treeHash
      if (report === undefined || treeHash === undefined) {
        judged.plugins.push({ ...base, why: 'the command changed its files, and the guard could not read them' })
        continue
      }
      const decided = await decisionFor($, { treeHash }, report.verdict.kind).catch(() => undefined)
      if (decided?.decision === 'approved') continue
      const mod = report.results.some(result => result.group === 'mod')
      if (decided === undefined && report.verdict.kind === 'safe' && !mod) {
        await note(treeHash, `AI Install Guard: the command changed the files of ${label}; checked them: No red flags`)
        continue
      }
      const why = decided?.decision === 'rejected' ? 'the command changed its files to ones you rejected' : `the command changed its files: ${report.verdict.kind === 'safe' ? 'a mod whose files you have not approved' : report.verdict.recommendation}`
      judged.plugins.push({ ...base, treeHash, why, report })
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
        const scope = entry.scope.split(' ')[0] ?? 'user'
        const label = `MCP server ${safeLine(entry.name)} (${scope} scope)`
        const report = await scanOnly(host, label, how, { lookups }).catch(() => undefined)
        const decided = report === undefined ? undefined : await decisionFor($, { treeHash }, report.verdict.kind).catch(() => undefined)
        if (decided?.decision === 'approved') continue
        if (decided === undefined && report?.verdict.kind === 'safe') {
          await note(treeHash, `AI Install Guard: the command added ${label}; checked it: No red flags`)
          continue
        }
        const why = decided?.decision === 'rejected' ? 'you rejected this server before' : report === undefined ? 'the scan failed' : report.verdict.recommendation
        judged.configs.push({ key: `mcp ${scope} ${entry.name}`, label, treeHash, why, how, ...(report === undefined ? {} : { report }), display: display(label) })
        // Its tools are refused until you keep it: a server starts as a session does, and may serve them before you decide.
        judged.locks.push({ label, treeHash, path, hash: await contentHash(host, path), settings: false, tools: toolsOf(entry.name) })
      }
      continue
    }
    // An agent or an output style: what it says is used as soon as Claude reaches for it.
    const how = await promptCandidate(host, reading)
    const report = await scanOnly(host, reading.label, how, { lookups }).catch(() => undefined)
    // Laid out from its own text, it has a hash to wait on even when the scan failed, so it is held back all the same.
    const treeHash = report?.inventory?.treeHash ?? ('files' in how ? await laidHash(how).catch(() => undefined) : undefined)
    if (report !== undefined && treeHash !== undefined) {
      const decided = await decisionFor($, { treeHash }, report.verdict.kind).catch(() => undefined)
      if (decided?.decision === 'approved') continue
      if (decided === undefined && report.verdict.kind === 'safe') {
        await note(treeHash, `AI Install Guard: the command changed ${reading.label}; checked it: No red flags`)
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
const changedAtom = atom({ plugin: 'ai-install-guard', key: 'changed' } as const, { configs: [], plugins: [] } as GuardChanged)

/** Most changes kept for /guard held: the oldest fall off. */
const MAX_CHANGED = 50

/**
 * Keeps what waits for /guard held, and its locks, in the session's state, so
 * a reload, which starts the guard's own hooks again, loses neither. A
 * plugin's scan is left out, to be made again when it is shown.
 */
export async function keepChanged($: EngineInterface, judged: Judged): Promise<void> {
  if (judged.configs.length + judged.plugins.length > 0) {
    await update($, changedAtom, current => ({
      configs: [...current.configs, ...judged.configs].slice(-MAX_CHANGED),
      plugins: [...current.plugins, ...judged.plugins.map(({ report: _report, ...plugin }) => plugin)].slice(-MAX_CHANGED),
    }))
  }
  if (judged.locks.length === 0) return
  await update($, locksAtom, current => [...current.filter(item => !judged.locks.some(lock => lock.treeHash === item.treeHash && lock.path === item.path)), ...judged.locks])
}

/** What commands Claude ran changed that waits for the person, as kept. */
export async function loadChanged($: EngineInterface): Promise<{ configs: FoundConfig[]; plugins: FoundPlugin[] }> {
  const kept = await read($, changedAtom)
  return { configs: kept.configs as FoundConfig[], plugins: kept.plugins as FoundPlugin[] }
}

/**
 * The locks still on: a change you kept is let go, and one you rejected
 * once its file no longer holds it, but for a server's tools, refused for
 * the session; the rest wait.
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
    if (decided?.decision === 'rejected' && lock.tools === undefined && (await contentHash(host, lock.path)) !== lock.hash) continue
    on.push(lock)
  }
  if (on.length !== current.length) await update($, locksAtom, latest => latest.filter(item => on.some(lock => lock.treeHash === item.treeHash && lock.path === item.path)))
  return on
}

/** Tools that only read, or write files the write gate judges: what Claude may still use while a change waits. */
export const LOCK_FREE = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS', 'TodoWrite', 'ToolSearch', 'AskUserQuestion'])

/** The refusal Claude reads for `tool` while changes wait, or undefined when none holds it back. */
export async function lockRefusal($: EngineInterface, locks: readonly GuardLock[], tool: string): Promise<string | undefined> {
  const decisions = await loadDecisions($).catch(() => [])
  const rejected = (lock: GuardLock): boolean => decisions.some(item => item.treeHash === lock.treeHash && item.decision === 'rejected')
  const server = locks.find(lock => lock.tools !== undefined && tool.startsWith(lock.tools))
  if (server !== undefined) {
    return rejected(server)
      ? `AI Install Guard refused this tool: it comes from the ${server.label}, which a command Claude ran added and the person rejected. Tell the person.`
      : `AI Install Guard refused this tool: it comes from the ${server.label}, which a command Claude ran added, and which waits for the person's decision in the guard's pane (/guard held opens it). Tell the person.`
  }
  const all = locks.filter(lock => lock.tools === undefined)
  if (all.length === 0 || LOCK_FREE.has(tool)) return undefined
  const names = all.map(lock => lock.label).join(', ')
  const back = all.filter(rejected)
  const undo = back.length === 0 ? '' : ` The person rejected ${back.map(lock => lock.label).join(', ')}, which is still there: restore what the file held, with Edit or Write, or ask the person to.`
  return `AI Install Guard refused this tool: a command Claude ran changed ${names} where Claude Code loads from, and the change waits for the person's decision in the guard's pane (/guard held opens it).${undo} Until then, Claude may only read files and use Write or Edit. Tell the person.`
}

/** What a command's change that waits is called, for the note Claude reads with the command's result. */
export function madeNote(judged: Judged): string | undefined {
  const waiting = [...judged.configs.map(item => item.label), ...judged.plugins.map(item => item.label)]
  if (waiting.length === 0) return undefined
  const locked = judged.locks.some(lock => lock.tools === undefined) ? ' Until they decide, Claude may only read files and use Write or Edit.' : ''
  return `AI Install Guard: this command changed ${waiting.join(', ')} where Claude Code loads from, and the change waits for the person's decision in the guard's pane. Tell the person; do not change it again or work around it.${locked}`
}

/** What stands for a file's text, or for a folder's files, where it cannot be read: with what the guard can tell of it. */
const UNREADABLE = '\u0000unreadable'

/**
 * A file's text; undefined when it is not there; one too large or that
 * cannot be read stands as its size and when it last changed, so a change
 * to it still shows.
 */
async function textOf(host: Host, path: string): Promise<string | undefined> {
  const text = await readText(host, path, MAX_CONFIG_BYTES)
  if ('text' in text) return text.text
  const stat = await host.stat(path).catch(() => undefined)
  return `${UNREADABLE} ${stat?.size ?? ''} ${stat?.mtimeMs ?? ''}`
}

async function contentHash(host: Host, path: string): Promise<string> {
  return sha256Hex((await textOf(host, path)) ?? '\u0000none')
}

/** A folder's files by path, each with its hash; empty when it is not there; one key, UNREADABLE, when it cannot be read. */
async function filesIn(host: Host, folder: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if ((await host.stat(folder).catch(() => undefined)) === undefined) return out
  const scanned = await takeInventory(host, folder).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  if (typeof scanned === 'string') return new Map([[UNREADABLE, scanned]])
  for (const entry of scanned.inventory.entries) {
    if (entry.kind === 'file') out.set(entry.path, entry.sha256)
    else if (entry.kind === 'link') out.set(entry.path, `link ${entry.target}`)
  }
  return out
}

/** The most entries a plugin folder is listed to; past it, the plugin is judged by its files. */
const MAX_LISTED = 5000

/** What marks a listing cut short. */
const PARTIAL = 'partial '

/**
 * A plugin folder as it lists, entry by entry (kind, size, when it changed),
 * with Claude Code's in-use marks at its root left out: cheap to take before
 * and after, where reading every file would not be.
 */
async function listed(host: Host, root: string): Promise<string> {
  const lines: string[] = []
  let partial = false
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await host.list(dir).catch(() => undefined)
    if (entries === undefined) {
      lines.push(`? ${rel}`)
      return
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (lines.length >= MAX_LISTED) {
        partial = true
        return
      }
      if (rel === '' && entry.name === '.in_use') continue
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      lines.push(`${entry.kind} ${entry.size} ${entry.mtimeMs ?? ''} ${entry.isLink ? 'link ' : ''}${path}`)
      if (entry.kind === 'dir' && !entry.isLink) await walk(`${dir}/${entry.name}`, path)
    }
  }
  await walk(root, '')
  return `${partial ? PARTIAL : ''}${await sha256Hex(lines.join('\n'))}`
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
    const parsed: unknown = JSON.parse(text === undefined || text.startsWith(UNREADABLE) ? '{}' : text)
    const plugins = isRecord(parsed) && isRecord(parsed.plugins) ? parsed.plugins : {}
    return Object.fromEntries(Object.entries(plugins).map(([id, list]) => [id, Array.isArray(list) ? list.filter(isRecord) : []]))
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

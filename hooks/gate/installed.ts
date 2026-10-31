// The session-start check: every plugin installed and turned on is compared
// with what you approved, once the session has started and without holding
// it up. Claude Code adds plugins no gate sees (an update made on its own, an
// install from a terminal while no session ran, a mod that loads before the
// guard), and their skills, classic hooks and MCP servers run as they are.
// Files you approved, or checked before with no red flags, go on. Anything
// else is scanned: a plugin with no red flags is named once, and one with a
// red flag, or a mod whose files you never approved, waits in the pane with
// Keep and Turn off.

import type { EngineInterface } from 'claude-code'

import type { GuardRequest } from '../../types'
import { loadDecisions, noteChecked, wasChecked, type Decision } from '../guard/decisions'
import { scanOnly, showScan, showUnverified } from '../guard/run'
import { modHost } from '../mod-host'
import type { Host } from '../scan/host'
import { takeInventory } from '../scan/inventory'
import { safeLine } from '../scan/safe-text'
import type { ScanReport } from '../scan/scan'
import { day, heldReport, heldStatus, PANE_BUSY, reviewHeld, type HeldMod } from './load'
import { claudeJson } from './resolve'

/** A plugin on in this session whose files you have not approved. */
export type FoundPlugin = {
  /** `<name>@<marketplace>` as Claude Code lists it, for Turn off; empty when it is not one a command can name. */
  id: string
  label: string
  root: string
  /** The tree hash of its folder; absent when it could not be read. */
  treeHash?: string
  /** Why it waits, in the guard's own words. */
  why: string
  /** You rejected these files: it is named, never opened in the pane again. */
  rejected?: true
  /** Named at the first check on this machine: /guard held lists it, but no toast names it and the pane does not open on it by itself. */
  quiet?: true
  /** The scan that found it, shown in the pane as it is rather than made again. */
  report?: ScanReport
}

/**
 * What the check found: the plugins that wait for you, and the ones named
 * once as checked. `baseline` marks the first check on this machine, which
 * names what was already on without opening the pane.
 */
export type InstalledCheck = { found: FoundPlugin[]; checked: string[]; baseline: boolean }

/**
 * The first check on this machine: when it ran, and the plugins it named
 * that were waiting for a decision, so /guard held still lists them in later
 * sessions without naming them again. Before it, nothing on had been
 * compared at a session's start.
 */
const BASELINE = 'plugins-baseline'
type Baseline = { at: number; waiting: { treeHash: string; why: string }[] }
/** The plugins the first check leaves waiting, at most: the store is 4 MiB in all. */
const MAX_WAITING = 200

/** A plugin installed and on, as `claude plugin list` names it. */
type Installed = { id: string; root: string }

/** A plugin id a `/plugin disable` can be given as one word. */
const PLUGIN_ID = /^[A-Za-z0-9][\w.-]*@[A-Za-z0-9][\w.-]*$/

/** Scopes an administrator owns: their plugins load as they are. */
const MANAGED = new Set(['managed', 'policy'])

/**
 * Compares every plugin installed and on with what you approved. `skip` is
 * the folders the load gate already kept out in this session, and `own` the
 * guard's own folder. Each version is named once: one with no red flags, each
 * rejection of files that are on all the same, and, at the first check on
 * this machine, everything already on, since you chose those before the
 * guard looked; /guard held still lists the ones that wait. After that, a new
 * or changed plugin with a red flag, or a mod you never approved, waits each
 * session until you decide. A plugin whose folder cannot be read, or whose
 * files change while it is checked, waits as Could not verify; a failure to
 * list the plugins at all throws.
 */
export async function checkInstalled($: EngineInterface, options: { skip: ReadonlySet<string>; own: string; lookups: boolean }): Promise<InstalledCheck> {
  const host = modHost($)
  const plugins = (await installedPlugins(host)).filter(plugin => !options.skip.has(plugin.root) && trimmed(plugin.root) !== trimmed(options.own))
  const decisions = await loadDecisions($)
  const known = await loadBaseline($)
  const baseline = known === undefined
  const waiting: Baseline['waiting'] = []
  const found: FoundPlugin[] = []
  const checked: string[] = []
  // One at a time: the session has just started, and this runs beside it.
  for (const plugin of plugins) {
    const label = safeLine(plugin.id)
    const id = PLUGIN_ID.test(plugin.id) ? plugin.id : ''
    const tree = await takeInventory(host, plugin.root).then(
      scanned => ({ treeHash: scanned.inventory.treeHash }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    )
    if ('error' in tree) {
      found.push({ id, label, root: plugin.root, why: `its folder could not be read (${safeLine(tree.error)})` })
      continue
    }
    // Decisions are kept newest first: the newest for these files stands.
    const decided = decisions.find(item => item.treeHash === tree.treeHash)
    if (decided?.decision === 'approved') continue
    // Each rejection is named once on its own, by when it was made: files checked
    // before with no red flags and rejected since, or approved and rejected again, are named.
    if (decided?.decision === 'rejected') {
      if (await noteChecked($, `rejected ${tree.treeHash} ${decided.decidedAt}`)) found.push({ id, label, root: plugin.root, treeHash: tree.treeHash, why: `you rejected these files on ${day(decided.decidedAt)}`, rejected: true })
      continue
    }
    const before = known?.waiting.find(item => item.treeHash === tree.treeHash)
    if (before !== undefined) {
      found.push({ id, label, root: plugin.root, treeHash: tree.treeHash, why: before.why, quiet: true })
      continue
    }
    if (await wasChecked($, tree.treeHash)) continue
    const report = await scanOnly(host, label, { folder: plugin.root }, { lookups: options.lookups }).catch((error: unknown) => error instanceof Error ? error.message : String(error))
    if (typeof report === 'string') {
      found.push({ id, label, root: plugin.root, why: `the scan failed (${safeLine(report)})` })
      continue
    }
    if (report.inventory === undefined) {
      found.push({ id, label, root: plugin.root, why: `the scan could not read it (${safeLine(report.verdict.reasons[0] ?? 'it read nothing')})` })
      continue
    }
    // The verdict is for the files the scan read: ones that changed since they were hashed are not named as checked.
    if (report.inventory.treeHash !== tree.treeHash) {
      found.push({ id, label, root: plugin.root, why: 'its files changed while the guard was checking them' })
      continue
    }
    // A mod needs your approval to load at all, so one that loaded before the guard waits for it too.
    const mod = report.results.some(result => result.group === 'mod')
    if (report.verdict.kind === 'safe' && !mod) {
      if (await noteChecked($, tree.treeHash)) checked.push(label)
      continue
    }
    const earlier = decisions.find(item => item.decision === 'approved' && (item.root === plugin.root || item.target === plugin.id))
    const what = report.verdict.kind === 'safe' ? 'a mod whose files you have not approved' : report.verdict.recommendation
    const why = earlier === undefined ? what : `${what}; its files changed since you approved it on ${day(earlier.decidedAt)}`
    if (baseline) waiting.push({ treeHash: tree.treeHash, why })
    found.push({ id, label, root: plugin.root, treeHash: tree.treeHash, why, report })
  }
  if (baseline) await $.store.set(BASELINE, { at: Date.now(), waiting: waiting.slice(0, MAX_WAITING) } satisfies Baseline)
  return { found, checked, baseline }
}

/** The first check on this machine, when it has run. */
async function loadBaseline($: EngineInterface): Promise<Baseline | undefined> {
  const stored = await $.store.get(BASELINE)
  if (stored == null) return undefined
  const listed = isRecord(stored) && Array.isArray(stored.waiting) ? (stored.waiting as unknown[]) : []
  const waiting = listed.filter((item): item is Baseline['waiting'][number] => isRecord(item) && typeof item.treeHash === 'string' && typeof item.why === 'string')
  return { at: isRecord(stored) && typeof stored.at === 'number' ? stored.at : 0, waiting }
}

/**
 * The check as a session starts, run beside it: what it finds is named in a
 * toast, and the first plugin to review is opened in the pane, unless this is
 * the first check on this machine, a held mod has the pane (`paneTaken`) or a
 * scan there still waits for you. `own` is the
 * guard's own folder. Resolves with the plugins that wait, for /guard held; a
 * failure is named, never thrown.
 */
export async function checkAtStart($: EngineInterface, options: { held: readonly HeldMod[]; own: string; paneTaken: boolean; lookups: boolean }): Promise<FoundPlugin[]> {
  $.ui.status('AI Install Guard: checking the plugins that are on')
  try {
    const check = await checkInstalled($, { skip: new Set(options.held.map(mod => mod.root)), own: options.own, lookups: options.lookups })
    $.ui.status(undefined)
    const first = options.paneTaken || check.baseline ? undefined : toReviewFound(check.found)
    // Opened only on a free pane, so the toast says what the pane shows.
    const opens = first !== undefined && (await reviewFound($, first, options.lookups, true))
    const toast = checkToast(check, opens)
    if (toast !== undefined) $.ui.toast(toast)
    return check.found
  } catch (error) {
    $.ui.status(undefined)
    $.ui.toast(`AI Install Guard could not check the plugins that are on: ${safeLine(error instanceof Error ? error.message : String(error))}`)
    return []
  }
}

/** The plugins installed and on, from Claude Code's own listing; an administrator's left out. */
async function installedPlugins(host: Host): Promise<Installed[]> {
  const listing = await claudeJson(host, ['plugin', 'list', '--json'], 'the installed plugins')
  if (!Array.isArray(listing)) throw new Error('could not read the installed plugins: the listing was not a list')
  return listing.flatMap(item => {
    if (!isRecord(item) || item.enabled !== true || typeof item.id !== 'string' || typeof item.installPath !== 'string' || item.installPath === '') return []
    if (typeof item.scope === 'string' && MANAGED.has(item.scope)) return []
    return [{ id: item.id, root: item.installPath }]
  })
}

/**
 * The toast at the end of the check: what waits for you, then what was
 * checked and named once. Nothing to say is undefined.
 */
export function checkToast(check: InstalledCheck, opensPane: boolean): string | undefined {
  const parts: string[] = []
  const { found, checked } = check
  if (check.baseline) {
    const total = found.length + checked.length
    if (total === 0) return undefined
    const look = found.length === 0 ? 'no red flags' : `${checked.length} with no red flags, and ${found.length} worth your look when you like: ${found.map(plugin => plugin.label).join(', ')}. /guard held opens them one at a time`
    return `AI Install Guard looked at the ${count(total)} already on that it had not checked: ${look}. From now on, it checks a plugin that is new or changed as a session starts.`
  }
  // What the first check already named waits quietly, for /guard held.
  const named = found.filter(plugin => plugin.quiet !== true)
  if (named.length > 0) {
    const names = named.map(plugin => plugin.label).join(', ')
    const open = named.some(plugin => plugin.rejected !== true)
    const after = !open
      ? `You rejected ${named.length === 1 ? 'its' : 'their'} files: turn ${named.length === 1 ? 'it' : 'them'} off in /plugin. /guard held lists ${named.length === 1 ? 'it' : 'them'}.`
      : opensPane
        ? 'The pane shows the first: keep it, or turn it off. /guard held lists them all.'
        : '/guard held lists them and opens the first in the pane.'
    parts.push(`AI Install Guard found ${count(named.length)} on that you have not approved: ${names}. ${after}`)
  }
  if (checked.length > 0) parts.push(`AI Install Guard checked ${count(checked.length)} new since it last looked: no red flags (${checked.join(', ')}).`)
  return parts.length === 0 ? undefined : parts.join(' ')
}

/** The first found plugin the pane should open by itself: one you have not rejected, and not one the first check already named. */
export function toReviewFound(found: readonly FoundPlugin[]): FoundPlugin | undefined {
  return found.find(plugin => plugin.rejected !== true && plugin.quiet !== true)
}

/**
 * Shows one found plugin in the pane: its scan, with Keep and Turn off;
 * Could not verify when it could not be read. Only when the pane holds no
 * verdict still waiting for you; says whether the pane shows it.
 */
export async function reviewFound($: EngineInterface, plugin: FoundPlugin, lookups: boolean, ifFree = true): Promise<boolean> {
  const request: GuardRequest = { origin: 'command', args: plugin.id, label: plugin.label, subject: 'installed', display: `On in this session, not approved: ${plugin.label}` }
  const options = { action: 'approve' as const, request, lookups, report: plugin.report, ifFree }
  if (plugin.treeHash === undefined) return !(await showUnverified($, plugin.label, plugin.why, options)).superseded
  return !(await showScan($, plugin.label, { folder: plugin.root }, options)).superseded
}

/**
 * What `/guard held` answers: the mods kept from loading and the plugins
 * found on that you have not approved and that are still on, each with where
 * it stands, and the first one still undecided opened in the pane, unless the
 * pane holds a verdict still waiting for you.
 */
export async function waitingReport($: EngineInterface, held: readonly HeldMod[], found: readonly FoundPlugin[], lookups: boolean): Promise<string> {
  // A plugin turned off since it was found no longer waits; when the listing fails, every one is kept.
  const on = found.length === 0 ? undefined : await installedPlugins(modHost($)).then(list => new Set(list.map(plugin => trimmed(plugin.root))), () => undefined)
  const current = on === undefined ? found : found.filter(plugin => on.has(trimmed(plugin.root)))
  if (current.length === 0) return heldReport($, held, lookups)
  const decisions = await loadDecisions($)
  const mods = heldStatus(held, decisions)
  const plugins = foundStatus(current, decisions)
  const parts: string[] = []
  if (held.length > 0) parts.push(`AI Install Guard kept ${held.length === 1 ? '1 mod' : `${held.length} mods`} from loading in this session:\n${mods.lines.join('\n')}`)
  parts.push(`${held.length > 0 ? 'It' : 'AI Install Guard'} found ${count(current.length)} on in this session that you have not approved:\n${plugins.lines.join('\n')}`)
  if (mods.next !== undefined) {
    const shown = await reviewHeld($, mods.next, lookups, true)
    parts.push(shown ? `${mods.next.label} is in the guard's pane. Approve it there, then run /reload-plugins to load it. Run /guard held again for the next one.` : PANE_BUSY)
  } else if (plugins.next !== undefined) {
    const shown = await reviewFound($, plugins.next, lookups, true)
    parts.push(shown ? `${plugins.next.label} is in the guard's pane: keep it, or turn it off there. Run /guard held again for the next one.` : PANE_BUSY)
  } else {
    parts.push('Each is decided.')
  }
  return parts.join('\n\n')
}

/** Each found plugin and where it stands, and the first still undecided. */
function foundStatus(found: readonly FoundPlugin[], decisions: readonly Decision[]): { lines: string[]; next?: FoundPlugin } {
  const decisionOf = (plugin: FoundPlugin): Decision | undefined => (plugin.treeHash === undefined ? undefined : decisions.find(item => item.treeHash === plugin.treeHash))
  const lines = found.map(plugin => {
    const decided = decisionOf(plugin)
    if (decided === undefined) return `  ${plugin.label}: ${plugin.why}`
    if (decided.decision === 'approved') return `  ${plugin.label}: kept`
    const off = plugin.id === '' ? 'turn it off in /plugin' : `/plugin disable ${plugin.id} turns it off`
    return `  ${plugin.label}: you rejected these files on ${day(decided.decidedAt)}; ${off} if it is still on`
  })
  return { lines, next: found.find(plugin => decisionOf(plugin) === undefined) }
}

function count(n: number): string {
  return n === 1 ? '1 plugin' : `${n} plugins`
}

function trimmed(path: string): string {
  return path.replace(/\/+$/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The install gate: an install asked for by `/plugin` or by a shell command
// Claude runs is let through only when the person already approved that exact
// version. Anything else is scanned and held in the pane, where Install
// carries it out.

import type { EngineInterface } from 'claude-code'

import type { GuardRequest } from '../../types'
import { decisionFor, noteChecked, pinnedDecision } from '../guard/decisions'
import { takePass } from '../guard/passes'
import { scanOnly, showScan, showUnverified, type ScanHow, type ShowOptions, type Shown } from '../guard/run'
import type { Host } from '../scan/host'
import { landsAt, readWrite, type WriteReading } from './writes'
import type { ShellChange } from './shell-change'
import type { RemoteSpec } from '../scan/remote'
import { sha256Hex, treeHash } from '../scan/hash'
import type { InventoryEntry } from '../scan/inventory'
import type { ScanReport } from '../scan/scan'
import { decide } from '../scan/verdict'
import { row, type CheckResult, type Evidence } from '../scan/checks/types'
import { sourceRoot } from '../guard/view'
import { modHost } from '../mod-host'
import { resolvePin } from '../scan/remote'
import { safeLine } from '../scan/safe-text'
import type { VerdictKind } from '../scan/verdict'
import type { InstallRequest, Reading } from './requests'
import { targetOf } from './resolve'

export type Judgement =
  /** The install goes through; `note` says why, for a toast. */
  | { kind: 'allow'; note?: string }
  /** The install is held: `text` answers the command, or tells Claude why its command was refused. */
  | { kind: 'hold'; text: string }

/** What the guard does with one install, asked for as `request` says. */
export async function judge($: EngineInterface, reading: Exclude<Reading, { kind: 'pass' }>, request: GuardRequest, lookups: boolean): Promise<Judgement> {
  // Install anyway, confirmed, on something nothing could pin: this exact command, once.
  if (await takePass($, { origin: request.origin, args: request.args })) {
    return { kind: 'allow', note: `AI Install Guard: installing ${request.label}, as you allowed` }
  }
  const options = { action: 'install' as const, request, lookups }
  if (reading.kind === 'unreadable') {
    const shown = await showUnverified($, reading.label, reading.reason, options)
    // The reason is the guard's own reading of the command, so Claude may read it too.
    return shown.superseded ? superseded(request) : hold(request, UNVERIFIED, '', shown.placed, { why: reading.reason, toClaude: true })
  }
  const name = nameOf(reading.request)
  // An MCP server has no repository to fetch: its configuration is what is checked.
  if (reading.request.kind === 'mcp') return afterScan(request, name, await showScan($, name, mcpCandidate([reading.request]), options))
  const host = modHost($)
  const target = await targetOf(host, reading.request)
  switch (target.kind) {
    case 'browse':
      return { kind: 'allow', note: BROWSE_NOTE }
    case 'unverifiable': {
      const shown = await showUnverified($, name, target.reason, options)
      // This reason can quote a marketplace's own catalog: the person reads it, Claude does not.
      return shown.superseded ? superseded(request) : hold(request, UNVERIFIED, '', shown.placed, { why: target.reason, toClaude: false })
    }
    case 'remote':
      return judgeRemote($, name, target.spec, request, options)
    case 'local':
      return afterScan(request, name, await showScan($, name, { folder: target.path }, options))
  }
}

/**
 * A repository at the commit it would give now. A rejection of that commit
 * stands without a new scan; an approval is checked against a new one, which
 * may judge worse (a lookup turned on since may know it as malware).
 */
async function judgeRemote($: EngineInterface, name: string, wanted: RemoteSpec, request: GuardRequest, options: ShowOptions): Promise<Judgement> {
  const pin = await resolvePin(modHost($), wanted).catch(() => undefined)
  if (pin !== undefined) {
    const decided = await pinnedDecision($, { root: sourceRoot(wanted.url, pin.subdir), sha: pin.sha }).catch(() => undefined)
    if (decided?.decision === 'rejected') return rejected(request, name, ` at commit ${pin.sha.slice(0, 12)}`, decided.decidedAt)
  }
  // The scan fetches exactly the commit just looked up, so the verdict is about what arrives. It is
  // named by the branch or tag it was looked up through, so a release branch's commit is not taken
  // for one a fork could have put there.
  const spec: RemoteSpec =
    pin === undefined
      ? wanted
      : { url: wanted.url, ref: pin.sha, ...(pin.subdir === undefined ? {} : { subdir: pin.subdir }), ...(pin.foundAs === undefined ? {} : { foundAs: pin.foundAs }) }
  return afterScan(request, name, await showScan($, name, { remote: spec }, options))
}

/**
 * What the guard does with a file Claude is about to write where Claude Code
 * loads from. An MCP server written into a configuration is held, as one
 * added by command is. A skill, command or agent Claude writes itself is
 * scanned first with no pane and goes through, with a note, when the scan
 * finds nothing; otherwise it is held. A change to an installed plugin is
 * held as Could not verify.
 */
export async function judgeWrite($: EngineInterface, reading: Exclude<WriteReading, { kind: 'pass' }>, request: GuardRequest, lookups: boolean, copied = false): Promise<Judgement> {
  if (await takePass($, { origin: request.origin, args: request.args })) return { kind: 'allow', note: `AI Install Guard: writing ${request.label}, as you allowed` }
  const options = { action: 'install' as const, request, lookups }
  if (reading.kind === 'unreadable') {
    const shown = await showUnverified($, reading.label, reading.reason, options)
    return shown.superseded ? superseded(request) : hold(request, UNVERIFIED, '', shown.placed, { why: reading.reason, toClaude: true })
  }
  if (reading.kind === 'mcp') return afterScan(request, reading.label, await showScan($, reading.label, mcpCandidate(reading.servers), options))
  // A settings change that widens what Claude may do always waits, judged by what it widens.
  if (reading.kind === 'settings') {
    const how: ScanHow = { files: {}, root: reading.path, kind: 'settings change' }
    const report = await settingsReport(reading.label, reading.path, reading.content, reading.evidence, 'What the change lets Claude do')
    return afterScan(request, reading.label, await showScan($, reading.label, how, { ...options, report }))
  }
  // Text Claude writes itself goes on when it has no red flags; text copied from elsewhere is always shown.
  return scanThenHold($, reading.label, await promptCandidate(modHost($), reading), request, options, !copied)
}

/**
 * Scans `how` first with no pane: what was approved before goes on, and so
 * does what has no red flags when `quiet`; anything else is held in the pane.
 */
async function scanThenHold($: EngineInterface, label: string, how: ScanHow, request: GuardRequest, options: ShowOptions, quiet: boolean): Promise<Judgement> {
  const first = await scanOnly(modHost($), label, how, { lookups: options.lookups }).catch(() => undefined)
  if (quiet && first?.verdict.kind === 'safe') {
    // Named now, so its first use does not name it again.
    if (first.inventory !== undefined) await noteChecked($, first.inventory.treeHash).catch(() => false)
    return { kind: 'allow', note: `AI Install Guard: checked ${label}: No red flags` }
  }
  if (first?.inventory !== undefined) {
    const earlier = await decisionFor($, { treeHash: first.inventory.treeHash }, first.verdict.kind).catch(() => undefined)
    if (earlier?.decision === 'approved') return { kind: 'allow', note: `AI Install Guard: you approved ${label} on ${day(earlier.decidedAt)}; writing it` }
  }
  return afterScan(request, label, await showScan($, label, how, { ...options, ...(first === undefined ? {} : { report: first }) }))
}

/**
 * What the guard does with a shell command that changes where Claude Code
 * loads from. Text it writes is judged as Claude's Write of it would be; a
 * file it copies, as text copied in, is always shown; a folder copied in, or
 * a repository cloned, is scanned and held; anything else is Could not
 * verify, which Install anyway lets through once, as that exact command.
 */
export async function judgeShell($: EngineInterface, change: Exclude<ShellChange, { kind: 'pass' }>, command: string, lookups: boolean): Promise<Judgement> {
  const request = (label: string): GuardRequest => ({ origin: 'tool', args: command, label, subject: 'command' })
  if (change.kind === 'write') {
    const reading = await readWrite(modHost($), change.input, change.configDir)
    if (reading.kind === 'pass') return { kind: 'allow' }
    return judgeWrite($, reading, request(reading.label), lookups, change.copied)
  }
  if (change.kind === 'unreadable') return judgeWrite($, change, request(change.label), lookups)
  if (await takePass($, { origin: 'tool', args: command })) return { kind: 'allow', note: `AI Install Guard: writing ${change.label}, as you allowed` }
  const options: ShowOptions = { action: 'install', request: request(change.label), lookups }
  if (change.kind === 'folder') return scanThenHold($, change.label, { folder: change.path }, request(change.label), options, false)
  return judgeRemote($, change.label, change.spec, request(change.label), options)
}

/**
 * A settings change as a report: one row of what it widens and narrows,
 * the verdict that row gives, and a tree of the one file the change makes,
 * its path included, so an approval covers that exact file.
 */
/**
 * A settings file's report, built from what a change to it widens or
 * narrows, pinned to `content` at `path`: the whole file Claude writes, or,
 * at the start of a session, only the parts of it that run something.
 */
export async function settingsReport(label: string, path: string, content: string, evidence: Evidence[], title: string): Promise<ScanReport> {
  const { entries, bytes, hash } = await settingsTree(path, content)
  const results = [
    row(
      {
        id: 'settings.change',
        group: 'structure',
        title,
        advice: 'Settings decide what Claude runs without asking, what runs on its own, and where its traffic goes. Approve a change only if you asked for it.',
      },
      evidence,
    ),
  ]
  // Kept under the file's own path, so /guard forget <path> finds this file's decisions and no other's.
  return { target: label, inventory: { root: path, entries, totalBytes: bytes, treeHash: hash, skipped: [] }, results, verdict: decide(results) }
}

/** The one-file tree a settings file's decisions are pinned to: its path and `content` together. */
export async function settingsTree(path: string, content: string): Promise<{ entries: InventoryEntry[]; bytes: number; hash: string }> {
  const bytes = new TextEncoder().encode(content).length
  const entries: InventoryEntry[] = [{ kind: 'file', path: 'settings.json', size: bytes, sha256: await sha256Hex(`${path}\u0000${content}`), isText: true }]
  return { entries, bytes, hash: await treeHash(entries) }
}

/** Where a prompt Claude writes is scanned: a skill as its real folder once the write lands, a command or agent as the one file. */
async function promptCandidate(host: Host, reading: Extract<WriteReading, { kind: 'prompt' }>): Promise<ScanHow> {
  // The scan reads the folder where it really is, links followed (on macOS /tmp is /private/tmp).
  if (reading.folder !== undefined) return { overlay: { root: await landsAt(host, reading.folder), rel: reading.rel, content: reading.content }, kind: 'skill' }
  return { files: { [reading.rel]: reading.content }, root: `/ai-install-guard/${reading.what}/${reading.rel.slice(reading.rel.lastIndexOf('/') + 1)}`, kind: reading.what }
}

/** What the plugins menu cannot promise yet. */
export const BROWSE_NOTE = 'AI Install Guard: plugins picked from this menu are not scanned before they install, and a mod among them stays off until you approve it. To scan one first, run /plugin install <name>@<marketplace>'

/** The name a decision is kept under, so /guard forget finds it: the plugin as typed, or the marketplace's source. */
function nameOf(request: InstallRequest): string {
  if (request.kind === 'marketplace') return safeLine(request.source)
  if (request.kind === 'mcp') return `MCP server ${safeLine(request.name)}`
  return safeLine(request.marketplace === undefined ? request.plugin : `${request.plugin}@${request.marketplace}`)
}

/**
 * Where the configuration of an MCP server being added is laid out to be
 * scanned: a folder named after the server, so its decisions are kept under
 * its name and `/guard forget <name>` finds them.
 */
const MCP_ROOT = '/ai-install-guard/mcp-server'

/**
 * The files an MCP server being added is scanned as: an `.mcp.json` holding
 * that one server, so the scan's MCP checks judge it as they would in a
 * plugin. The same command builds the same files, so an approval pins to it.
 * A note says what the scan cannot read: the program it starts, or the
 * server at the other end of its address.
 */
export function mcpCandidate(servers: readonly { name: string; scope?: string; server: Record<string, unknown> }[]): Extract<ScanHow, { files: unknown }> {
  // Where each is kept is part of what is approved: local (the default), project (shared through .mcp.json) or user (every project).
  const only = servers.length === 1 ? servers[0] : undefined
  const keys = servers.map(item => (servers.filter(other => other.name === item.name).length > 1 ? `${item.name} (${item.scope ?? 'local'})` : item.name))
  const config = JSON.stringify(
    only !== undefined
      ? { scope: only.scope ?? 'local', mcpServers: { [only.name]: only.server } }
      : { scopes: Object.fromEntries(servers.map((item, at) => [keys[at], item.scope ?? 'local'])), mcpServers: Object.fromEntries(servers.map((item, at) => [keys[at], item.server])) },
    null,
    2,
  )
  const remote = servers.every(item => typeof item.server.url === 'string')
  const note = remote ? 'the server at this address runs elsewhere, so only how Claude connects to it was checked' : 'the program it starts was not read, only how Claude Code starts it'
  const notes: CheckResult[] = [
    row(
      { id: 'mcp.source', group: 'mcp', title: "The server's own code", advice: 'An MCP server added by a command has no files here to read. A package it starts is checked by name with the outside lookups, when they are on.' },
      [{ file: '.mcp.json', excerpt: note, status: 'info' }],
    ),
  ]
  return { files: { '.mcp.json': `${config}\n` }, root: `${MCP_ROOT}/${servers.map(item => item.name).join('+')}`, notes, kind: servers.length === 1 ? 'MCP server' : 'MCP servers' }
}

/** How a held install that could not be checked is described. */
const UNVERIFIED = { kind: 'unverified', recommendation: 'Could not verify' } as const

function afterScan(request: GuardRequest, name: string, shown: Shown): Judgement {
  if (shown.kind === 'failed') return shown.superseded ? superseded(request) : hold(request, UNVERIFIED, '', shown.placed)
  const sha = shown.report.source?.sha
  const where = sha === undefined ? '' : ` at commit ${sha.slice(0, 12)}`
  // The same files approved before (through /guard scan, or an earlier install), and judged no
  // worse now, need no second press.
  if (shown.view.decision === 'approved') return { kind: 'allow', note: `AI Install Guard: you approved ${name}${where} on ${day(shown.view.decidedAt ?? Date.now())}; ${wordsFor(request).doing}` }
  if (shown.view.decision === 'rejected') return rejected(request, name, where, shown.view.decidedAt)
  if (shown.superseded) return superseded(request)
  return hold(request, shown.report.verdict, where, shown.placed, { report: shown.text })
}

/** The words an answer uses for what was held: an install, or a write. */
function wordsFor(request: GuardRequest): { thing: string; done: string; doing: string; again: string } {
  // A pass lets exactly the command through, so a change a command makes is made again by running it again.
  if (request.subject === 'command') return { thing: 'change', done: 'Nothing was written', doing: 'running it', again: 'run the same command again' }
  return request.subject === 'write'
    ? { thing: 'change', done: 'Nothing was written', doing: 'writing it', again: 'make the same change again' }
    : { thing: 'install', done: 'Nothing was installed', doing: 'installing it', again: 'run the same command again' }
}

/** Another scan took the pane before this one finished: nothing to press, so nothing installs. */
function superseded(request: GuardRequest): Judgement {
  const text = `AI Install Guard: another scan took the pane before the one for ${request.label} finished, so ${wordsFor(request).done.toLowerCase()}.`
  return { kind: 'hold', text: request.origin === 'tool' ? `${text} Do not retry it now; tell the person, and run it again once they ask.` : `${text} Run it again to review it.` }
}

function rejected(request: GuardRequest, name: string, where: string, decidedAt: number | undefined): Judgement {
  const when = decidedAt === undefined ? '' : ` on ${day(decidedAt)}`
  if (request.origin === 'tool') {
    const words = wordsFor(request)
    return { kind: 'hold', text: `AI Install Guard: the person rejected this exact version of ${name}${where}${when}. ${words.done}. Do not ${request.subject === 'write' || request.subject === 'command' ? 'write it' : 'install it'} or try another way.` }
  }
  return { kind: 'hold', text: `AI Install Guard: you rejected ${name}${where}${when}. Nothing was installed. /guard forget ${name} judges it again.` }
}

/**
 * The answer while an install waits for the person's decision in the pane.
 * `why` says why it could not be checked; Claude reads it only when it is the
 * guard's own reading of Claude's command, never words from a catalog.
 */
function hold(
  request: GuardRequest,
  verdict: { kind: VerdictKind; recommendation: string },
  where: string,
  placed: boolean,
  more: { report?: string; why?: string; toClaude?: boolean } = {},
): Judgement {
  const unverified = verdict.kind === 'unverified'
  const why = more.why === undefined ? '' : `: ${safeLine(more.why)}`
  const what = unverified ? `could not verify ${request.label}${where}` : `${verdict.recommendation} for ${request.label}${where}`
  // Do not install and Could not verify install only through Install anyway, which asks twice.
  const button = unverified || verdict.kind === 'reject' ? 'Install anyway (it asks you to confirm)' : 'Install'
  if (request.origin === 'tool') {
    const words = wordsFor(request)
    const next = placed
      ? `The verdict and the Install and Reject buttons are in the guard's pane. Tell the person the ${words.thing} waits for their decision there, and ${words.again} only after they say they approved it.`
      : 'This session cannot show the guard\'s pane, so the person cannot approve it here.'
    return { kind: 'hold', text: `AI Install Guard held this ${words.thing} for the person to review: ${unverified ? `it ${what}${more.toClaude === true ? why : ''}` : what}. ${words.done}. Do not retry it or ${request.subject === 'write' || request.subject === 'command' ? 'write it' : 'install it'} another way. ${next}` }
  }
  const said = unverified ? `AI Install Guard ${what}${why}.` : `AI Install Guard: ${what}.`
  if (!placed) {
    return { kind: 'hold', text: `${more.report === undefined ? '' : `${more.report}\n\n`}${said} Nothing was installed: approving an install needs the guard's pane, which this session cannot show.` }
  }
  return { kind: 'hold', text: `${said} Nothing is installed yet: press ${button} in the guard's pane to install it, or Reject.` }
}

function day(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

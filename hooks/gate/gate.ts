// The install gate: an install asked for by `/plugin` or by a shell command
// Claude runs is let through only when the person already approved that exact
// version. Anything else is scanned and held in the pane, where Install
// carries it out.

import type { EngineInterface } from 'claude-code'

import type { GuardRequest } from '../../types'
import { decisionFor, pinnedDecision } from '../guard/decisions'
import { takePass } from '../guard/passes'
import { scanOnly, showScan, showUnverified, type ScanHow, type Shown } from '../guard/run'
import type { Host } from '../scan/host'
import { landsAt, type WriteReading } from './writes'
import { sha256Hex, treeHash } from '../scan/hash'
import type { InventoryEntry } from '../scan/inventory'
import type { ScanReport } from '../scan/scan'
import { decide } from '../scan/verdict'
import { row, type CheckResult } from '../scan/checks/types'
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
    case 'remote': {
      // The commit the install would take now. A rejection of it stands
      // without a new scan; an approval is checked against a new one, which
      // may judge worse (a lookup turned on since may know it as malware).
      const pin = await resolvePin(host, target.spec).catch(() => undefined)
      if (pin !== undefined) {
        const decided = await pinnedDecision($, { root: sourceRoot(target.spec.url, pin.subdir), sha: pin.sha }).catch(() => undefined)
        if (decided?.decision === 'rejected') return rejected(request, name, ` at commit ${pin.sha.slice(0, 12)}`, decided.decidedAt)
      }
      // The scan fetches exactly the commit just looked up, so the verdict is about what installs.
      const spec = pin === undefined ? target.spec : { url: target.spec.url, ref: pin.sha, ...(pin.subdir === undefined ? {} : { subdir: pin.subdir }) }
      return afterScan(request, name, await showScan($, name, { remote: spec }, options))
    }
    case 'local':
      return afterScan(request, name, await showScan($, name, { folder: target.path }, options))
  }
}

/**
 * What the guard does with a file Claude is about to write where Claude Code
 * loads from. An MCP server written into a configuration is held, as one
 * added by command is. A skill, command or agent Claude writes itself is
 * scanned first with no pane and goes through, with a note, when the scan
 * finds nothing; otherwise it is held. A change to an installed plugin is
 * held as Could not verify.
 */
export async function judgeWrite($: EngineInterface, reading: Exclude<WriteReading, { kind: 'pass' }>, request: GuardRequest, lookups: boolean): Promise<Judgement> {
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
    return afterScan(request, reading.label, await showScan($, reading.label, how, { ...options, report: await settingsReport(reading) }))
  }
  const host = modHost($)
  const how = await promptCandidate(host, reading)
  const first = await scanOnly(host, reading.label, how, { lookups }).catch(() => undefined)
  if (first?.verdict.kind === 'safe') return { kind: 'allow', note: `AI Install Guard: checked ${reading.label}: No red flags` }
  if (first?.inventory !== undefined) {
    const earlier = await decisionFor($, { treeHash: first.inventory.treeHash }, first.verdict.kind).catch(() => undefined)
    if (earlier?.decision === 'approved') return { kind: 'allow', note: `AI Install Guard: you approved ${reading.label} on ${day(earlier.decidedAt)}; writing it` }
  }
  return afterScan(request, reading.label, await showScan($, reading.label, how, { ...options, ...(first === undefined ? {} : { report: first }) }))
}

/**
 * A settings change as a report: one row of what it widens and narrows,
 * the verdict that row gives, and a tree of the one file the change makes,
 * its path included, so an approval covers that exact file.
 */
async function settingsReport(reading: Extract<WriteReading, { kind: 'settings' }>): Promise<ScanReport> {
  const bytes = new TextEncoder().encode(reading.content)
  const entries: InventoryEntry[] = [{ kind: 'file', path: 'settings.json', size: bytes.length, sha256: await sha256Hex(`${reading.path}\u0000${reading.content}`), isText: true }]
  const results = [
    row(
      {
        id: 'settings.change',
        group: 'structure',
        title: 'What the change lets Claude do',
        advice: 'Settings decide what Claude runs without asking, what runs on its own, and where its traffic goes. Approve a change only if you asked for it.',
      },
      reading.evidence,
    ),
  ]
  // Kept under the file's own path, so /guard forget <path> finds this file's decisions and no other's.
  return { target: reading.label, inventory: { root: reading.path, entries, totalBytes: bytes.length, treeHash: await treeHash(entries), skipped: [] }, results, verdict: decide(results) }
}

/** Where a prompt Claude writes is scanned: a skill as its real folder once the write lands, a command or agent as the one file. */
async function promptCandidate(host: Host, reading: Extract<WriteReading, { kind: 'prompt' }>): Promise<ScanHow> {
  // The scan reads the folder where it really is, links followed (on macOS /tmp is /private/tmp).
  if (reading.folder !== undefined) return { overlay: { root: await landsAt(host, reading.folder), rel: reading.rel, content: reading.content }, kind: 'skill' }
  return { files: { [reading.rel]: reading.content }, root: `/ai-install-guard/${reading.what}/${reading.rel.slice(reading.rel.lastIndexOf('/') + 1)}`, kind: reading.what }
}

/** What the plugins menu cannot promise yet. */
export const BROWSE_NOTE = 'AI Install Guard: plugins picked from this menu are not scanned yet. To scan one first, run /plugin install <name>@<marketplace>'

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
function mcpCandidate(servers: readonly { name: string; scope?: string; server: Record<string, unknown> }[]): ScanHow {
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
    return { kind: 'hold', text: `AI Install Guard: the person rejected this exact version of ${name}${where}${when}. ${words.done}. Do not ${request.subject === 'write' ? 'write it' : 'install it'} or try another way.` }
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
    return { kind: 'hold', text: `AI Install Guard held this ${words.thing} for the person to review: ${unverified ? `it ${what}${more.toClaude === true ? why : ''}` : what}. ${words.done}. Do not retry it or ${request.subject === 'write' ? 'write it' : 'install it'} another way. ${next}` }
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

import type { EngineInterface, Register } from 'claude-code'
import { atom, update } from 'claude-code'

import { BROWSE_NOTE, judge } from './gate/gate'
import { readPluginArgs, readShellCommand } from './gate/requests'
import { expandHome } from './gate/resolve'
import { badgeFor } from './guard/badge'
import { forgetDecisions, loadDecisions, loadLastView, loadReport } from './guard/decisions'
import { drawPane } from './guard/pane'
import { showScan } from './guard/run'
import { PANE_ID } from './guard/view'
import { modHost } from './mod-host'
import type { Host } from './scan/host'
import { looksRemote, parseRemote, type RemoteSpec } from './scan/remote'
import { safeLine } from './scan/safe-text'

// Claude Code reads every state reference from the file that uses it, so each
// module declares its own atom for the pane's view.
const viewAtom = atom({ plugin: 'ai-install-guard', key: 'view' } as const, null)

const USAGE = [
  'Usage:',
  '  /guard scan <path>            Scan a local plugin, mod or skill folder without installing it',
  '  /guard scan <repository>      Fetch one commit of a repository and scan it: https://host/owner/repo,',
  '                                github:owner/repo or owner/repo, with an optional @ref',
  '      --ref <branch|tag|commit>   The commit to scan (the default branch otherwise)',
  '      --path <folder>             A folder inside the repository',
  '      --details                   The full report as text',
  '  /guard report                 Reopen the last report',
  '  /guard badge                  A README badge for the last scan (Safe to install or Review what it can do)',
  '  /guard list                   Your approved and rejected versions',
  '  /guard forget <name>          Forget decisions about a name, so it is judged again',
].join('\n')

export const register: Register = (on, options) => {
  // Off unless you turn it on: the lookups send package and plugin names out.
  const lookups = options.outsideLookups === true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'guard',
      description: 'Scan a plugin, mod, skill or MCP server without installing it',
      argumentHint: 'scan <path | repository> | report | badge | list | forget <name>',
    })
    return next(e)
  })

  on('command.run', { command: 'guard' }, async ($, e) => {
    const { sub, rest, details, ref, path, error } = splitArgs(e.args)
    if (error !== undefined) return { text: `AI Install Guard: ${error}\n\n${USAGE}` }
    if (sub === 'scan' && rest !== '') return { text: await scan($, rest, details, { ref, path }, lookups) }
    if (sub === 'report') return { text: await reopen($) }
    if (sub === 'badge') return { text: await badge($) }
    if (sub === 'list') return { text: await list($) }
    if (sub === 'forget' && rest !== '') {
      const count = (await forgetDecisions($, rest)).length
      return { text: `AI Install Guard: forgot ${count} decision${count === 1 ? '' : 's'} about ${safeLine(rest)}.` }
    }
    return { text: USAGE }
  }).catch(() => ({ text: 'AI Install Guard: the command failed before it could answer.' }))

  // Gate A: the person's own /plugin install and /plugin marketplace add. An
  // install is answered in the command's place, so nothing installs, until
  // the person approves that exact version.
  on('command.run', { command: 'plugin' }, async ($, e, next) => {
    const reading = readPluginArgs(e.args)
    if (reading.kind === 'pass') {
      if (reading.browse) $.ui.toast(BROWSE_NOTE)
      return next(e)
    }
    const judged = await judge($, reading, { origin: 'command', args: e.args, label: reading.label }, lookups)
    if (judged.kind === 'hold') return { text: judged.text }
    if (judged.note !== undefined) $.ui.toast(judged.note)
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { text: 'AI Install Guard stopped this install: it failed before it could check it, so nothing was installed.' }))

  // Gate B: Claude installing a plugin or adding a marketplace with the claude
  // command. The command is refused, with a reason Claude reads, until the
  // person approves that exact version in the pane.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const reading = readShellCommand(e.command)
    if (reading.kind === 'pass') return next(e)
    const judged = await judge($, reading, { origin: 'tool', args: e.command, label: reading.label }, lookups)
    if (judged.kind === 'hold') return { deny: judged.text }
    if (judged.note !== undefined) $.ui.toast(judged.note)
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'AI Install Guard stopped this command: it may install a plugin or add a marketplace, and the guard failed before it could check it. Nothing was installed.' }))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, ($, e) => drawPane($, e))
}

/**
 * Scans a folder with the pane showing progress and then the verdict. The
 * command's own answer, which the model also reads, is one line: the quoted
 * findings stay in the pane. Where no pane can show (a headless run), or with
 * --details, the answer is the full text report.
 */
async function scan($: EngineInterface, target: string, details: boolean, flags: { ref?: string; path?: string }, lookups: boolean): Promise<string> {
  const host = modHost($)
  const shown = await showScan(
    $,
    target,
    async () => {
      const spec = await remoteSpecFor(host, target, flags)
      return spec === undefined ? { folder: await expandHome(host, target) } : { remote: spec }
    },
    { action: 'approve', lookups },
  )
  if (shown.kind === 'failed') return shown.reason
  // Where no pane shows, the answer is the whole report: findings and advice.
  if (!shown.placed || details) return shown.text
  return `AI Install Guard: ${shown.report.verdict.recommendation} for ${safeLine(target)}. The report is in the pane; /guard report reopens it.`
}

async function reopen($: EngineInterface): Promise<string> {
  const view = await loadLastView($)
  if (view === undefined) return 'AI Install Guard: no report yet. Run /guard scan <path>.'
  await update($, viewAtom, () => ({ ...view, confirming: false, deciding: false }))
  const opened = await $.ui.open({ id: PANE_ID, title: 'AI Install Guard', focus: true }).catch(() => ({ isPlaced: false }))
  if (opened.isPlaced) return `AI Install Guard: reopened the report for ${safeLine(view.target)}.`
  return (await loadReport($, view.scanId)) ?? 'AI Install Guard: the last report is no longer stored.'
}

async function badge($: EngineInterface): Promise<string> {
  const view = await loadLastView($)
  const made = badgeFor(view)
  if ('refusal' in made) return `AI Install Guard: ${made.refusal}`
  return [
    `AI Install Guard: a README badge for ${view?.target ?? 'the last scan'} at ${made.pin}. Paste it near the top of your README:`,
    '',
    made.markdown,
    '',
    'It names the exact version that was scanned. A change to your code needs a new scan and a new badge; the guard checks a badge against its own scan and never trusts it.',
  ].join('\n')
}

async function list($: EngineInterface): Promise<string> {
  const decisions = await loadDecisions($)
  if (decisions.length === 0) return 'AI Install Guard: no decisions yet.'
  const lines = decisions.map(item => {
    const when = new Date(item.decidedAt).toISOString().slice(0, 10)
    const how = item.decision === 'approved' ? (item.overridden ? 'approved against the verdict' : 'approved') : 'rejected'
    return `  ${when}  ${how.padEnd(28)} ${safeLine(item.target)}  (${item.verdict}, tree ${item.treeHash.slice(7, 19)})`
  })
  return ['AI Install Guard: your decisions, newest first', ...lines].join('\n')
}

/**
 * `scan --details --ref v1 "my folder"` → `{ sub: 'scan', details: true, ref: 'v1', rest: 'my folder' }`.
 * Options count only as their own tokens right after the subcommand, so a
 * quoted path that contains one is left whole.
 */
export function splitArgs(args: string): { sub: string; rest: string; details: boolean; ref?: string; path?: string; error?: string } {
  const trimmed = args.trim()
  const space = trimmed.search(/\s/)
  const sub = space === -1 ? trimmed : trimmed.slice(0, space)
  let rest = space === -1 ? '' : trimmed.slice(space).trim()
  let details = false
  let ref: string | undefined
  let path: string | undefined
  for (;;) {
    const option = /^(--details|--ref|--path)(?:\s+|$)/.exec(rest)
    if (option === null) break
    rest = rest.slice(option[0].length)
    if (option[1] === '--details') {
      details = true
      continue
    }
    const value = /^("[^"]*"|'[^']*'|\S+)\s*/.exec(rest)
    if (value === null || (value[1] as string).startsWith('--')) return { sub: sub.toLowerCase(), rest: '', details, error: `${option[1]} needs a value` }
    rest = rest.slice(value[0].length)
    if (option[1] === '--ref') ref = unquote(value[1] as string)
    else path = unquote(value[1] as string)
  }
  return { sub: sub.toLowerCase(), rest: unquote(rest), details, ref, path }
}

/**
 * The remote source `target` names, or undefined for a local folder. A bare
 * owner/repo is a folder when one exists by that name and no --ref or --path
 * says otherwise.
 */
async function remoteSpecFor(host: Host, target: string, flags: { ref?: string; path?: string }): Promise<RemoteSpec | undefined> {
  const shape = looksRemote(target)
  const asked = flags.ref !== undefined || flags.path !== undefined
  if (shape === 'local') {
    if (asked) throw new Error('--ref and --path apply to a repository, not to a folder')
    return undefined
  }
  if (shape === 'maybe' && !asked && (await host.stat(target).catch(() => undefined)) !== undefined) return undefined
  return parseRemote(target, { ref: flags.ref, subdir: flags.path })
}

function unquote(text: string): string {
  return /^(["']).*\1$/.test(text) ? text.slice(1, -1) : text
}

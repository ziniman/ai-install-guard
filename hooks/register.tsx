import type { EngineInterface, Register } from 'claude-code'
import { atom, update } from 'claude-code'

import { badgeFor } from './guard/badge'
import { decisionFor, forgetDecisions, loadDecisions, loadLastView, MAX_REPORT_CHARS, saveLastView } from './guard/decisions'
import { drawPane, REPORT_TEXT } from './guard/pane'
import { PANE_ID, scanningView, viewOf } from './guard/view'
import { modHost } from './mod-host'
import type { Host } from './scan/host'
import { looksRemote, parseRemote, type RemoteSpec } from './scan/remote'
import { formatReport } from './scan/report'
import { safeLine } from './scan/safe-text'
import { scanFolder, scanRemote } from './scan/scan'

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
  const opened = await $.ui.open({ id: PANE_ID, title: 'AI Install Guard', focus: true }).catch(() => ({ isPlaced: false }))
  // Until this scan's report is stored, Copy report has nothing to copy, never
  // the previous scan's report.
  await $.store.delete(REPORT_TEXT).catch(() => undefined)
  await update($, viewAtom, () => scanningView(target, 'approve'))
  $.ui.status(`AI Install Guard: scanning ${safeLine(target)}`)
  try {
    const options = {
      lookups,
      // Stage names can carry a candidate's own words (a plugin's name).
      onStage: (stage: string) => update($, viewAtom, current => (current === null ? current : { ...current, stage: safeLine(stage) })).then(() => undefined),
    }
    const spec = await remoteSpecFor(host, target, flags)
    const report = spec === undefined ? await scanFolder(host, target, await expandHome(host, target), options) : await scanRemote(host, target, spec, options)
    // A tree you already decided on shows that decision, not the buttons
    // again, unless it now judges worse than when you approved it.
    const earlier = report.inventory === undefined ? undefined : await decisionFor($, { treeHash: report.inventory.treeHash, sha: report.source?.sha }, report.verdict.kind).catch(() => undefined)
    const view = earlier === undefined ? viewOf(report, 'approve') : { ...viewOf(report, 'approve'), decision: earlier.decision, decidedAt: earlier.decidedAt }
    const text = formatReport(report, { details: true })
    // The report text is stored before the pane shows the verdict, so Copy
    // report always copies this scan's report. It is held well inside the
    // store's limit; a failed write leaves Copy with nothing, not old text.
    const stored = text.length > MAX_REPORT_CHARS ? `${text.slice(0, MAX_REPORT_CHARS)}\n… the report was cut here to fit the store` : text
    await $.store.set(REPORT_TEXT, stored).catch(() => undefined)
    await update($, viewAtom, () => view)
    await saveLastView($, view).catch(() => undefined)
    $.ui.toast(`AI Install Guard: ${report.verdict.recommendation} for ${safeLine(target)}`)
    // Where no pane shows, the answer is the whole report: findings and advice.
    if (!opened.isPlaced || details) return text
    return `AI Install Guard: ${report.verdict.recommendation} for ${safeLine(target)}. The report is in the pane; /guard report reopens it.`
  } catch (error) {
    const reason = `Could not verify ${safeLine(target)}: ${safeLine(reasonOf(error))}`
    await $.store.set(REPORT_TEXT, reason).catch(() => undefined)
    // The pane, and the report /guard report reopens, show this failure: never
    // a scanning pane, and never an older verdict in its place.
    const failed = { ...scanningView(target, 'approve'), stage: '', verdict: { kind: 'unverified' as const, recommendation: 'Could not verify', reasons: [reason], counts: { pass: 0, warn: 0, fail: 0, info: 0 } } }
    await update($, viewAtom, () => failed).catch(() => undefined)
    await saveLastView($, failed).catch(() => undefined)
    return reason
  } finally {
    $.ui.status(undefined)
  }
}

async function reopen($: EngineInterface): Promise<string> {
  const view = await loadLastView($)
  if (view === undefined) return 'AI Install Guard: no report yet. Run /guard scan <path>.'
  await update($, viewAtom, () => ({ ...view, confirming: false }))
  const opened = await $.ui.open({ id: PANE_ID, title: 'AI Install Guard', focus: true }).catch(() => ({ isPlaced: false }))
  if (opened.isPlaced) return `AI Install Guard: reopened the report for ${safeLine(view.target)}.`
  const text = await $.store.get(REPORT_TEXT)
  return typeof text === 'string' ? text : 'AI Install Guard: the last report is no longer stored.'
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

async function expandHome(host: Host, path: string): Promise<string> {
  if (path !== '~' && !path.startsWith('~/')) {
    return path
  }
  const { exitCode, stdout } = await host.run(['printenv', 'HOME'])
  const home = stdout.trim()
  if (exitCode !== 0 || home === '') {
    throw new Error('could not find the home folder')
  }
  return home + path.slice(1)
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

import type { EngineInterface, Register } from 'claude-code'
import { atom, update } from 'claude-code'

import { forgetDecisions, loadDecisions, loadLastView, MAX_REPORT_CHARS, saveLastView } from './guard/decisions'
import { drawPane, REPORT_TEXT } from './guard/pane'
import { PANE_ID, scanningView, viewOf } from './guard/view'
import { modHost } from './mod-host'
import type { Host } from './scan/host'
import { formatReport } from './scan/report'
import { safeLine } from './scan/safe-text'
import { scanFolder } from './scan/scan'

// Claude Code reads every state reference from the file that uses it, so each
// module declares its own atom for the pane's view.
const viewAtom = atom({ plugin: 'ai-install-guard', key: 'view' } as const, null)

const USAGE = [
  'Usage:',
  '  /guard scan <path>            Scan a local plugin, mod or skill folder without installing it',
  '  /guard scan --details <path>  The same, with the full report as text',
  '  /guard report                 Reopen the last report',
  '  /guard list                   Your approved and rejected versions',
  '  /guard forget <name>          Forget decisions about a name, so it is judged again',
].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'guard',
      description: 'Scan a plugin, mod, skill or MCP server without installing it',
      argumentHint: 'scan <path> | report | list | forget <name>',
    })
    return next(e)
  })

  on('command.run', { command: 'guard' }, async ($, e) => {
    const { sub, rest, details } = splitArgs(e.args)
    if (sub === 'scan' && rest !== '') return { text: await scan($, rest, details) }
    if (sub === 'report') return { text: await reopen($) }
    if (sub === 'list') return { text: await list($) }
    if (sub === 'forget' && rest !== '') {
      const count = await forgetDecisions($, rest)
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
async function scan($: EngineInterface, target: string, details: boolean): Promise<string> {
  const host = modHost($)
  const opened = await $.ui.open({ id: PANE_ID, title: 'AI Install Guard', focus: true }).catch(() => ({ isPlaced: false }))
  // Until this scan's report is stored, Copy report has nothing to copy, never
  // the previous scan's report.
  await $.store.delete(REPORT_TEXT).catch(() => undefined)
  await update($, viewAtom, () => scanningView(target, 'approve'))
  $.ui.status(`AI Install Guard: scanning ${safeLine(target)}`)
  try {
    const report = await scanFolder(host, target, await expandHome(host, target), {
      // Stage names can carry a candidate's own words (a plugin's name).
      onStage: stage => update($, viewAtom, current => (current === null ? current : { ...current, stage: safeLine(stage) })).then(() => undefined),
    })
    const view = viewOf(report, 'approve')
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
    // The pane must not keep saying it is scanning.
    await update($, viewAtom, current => (current === null ? current : { ...current, stage: '', verdict: { kind: 'unverified' as const, recommendation: 'Could not verify', reasons: [reason], counts: { pass: 0, warn: 0, fail: 0, info: 0 } } })).catch(() => undefined)
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
 * `scan --details "my folder"` → `{ sub: 'scan', details: true, rest: 'my folder' }`.
 * `--details` counts only as its own token right after the subcommand, so a
 * quoted path that contains it is left whole.
 */
export function splitArgs(args: string): { sub: string; rest: string; details: boolean } {
  const trimmed = args.trim()
  const space = trimmed.search(/\s/)
  const sub = space === -1 ? trimmed : trimmed.slice(0, space)
  let rest = space === -1 ? '' : trimmed.slice(space).trim()
  const details = /^--details(?:\s|$)/.test(rest)
  if (details) rest = rest.slice('--details'.length).trim()
  return { sub: sub.toLowerCase(), rest: unquote(rest), details }
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

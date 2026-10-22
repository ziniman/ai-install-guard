// The install gate: an install asked for by `/plugin` or by a shell command
// Claude runs is let through only when the person already approved that exact
// version. Anything else is scanned and held in the pane, where Install
// carries it out.

import type { EngineInterface } from 'claude-code'

import type { GuardRequest } from '../../types'
import { pinnedDecision } from '../guard/decisions'
import { takePass } from '../guard/passes'
import { showScan, showUnverified, type Shown } from '../guard/run'
import { sourceRoot } from '../guard/view'
import { modHost } from '../mod-host'
import { resolvePin } from '../scan/remote'
import { safeLine } from '../scan/safe-text'
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
    return hold(request, 'Could not verify', '', shown.placed)
  }
  const name = nameOf(reading.request)
  const host = modHost($)
  const target = await targetOf(host, reading.request)
  switch (target.kind) {
    case 'browse':
      return { kind: 'allow', note: BROWSE_NOTE }
    case 'unverifiable': {
      const shown = await showUnverified($, name, target.reason, options)
      return hold(request, 'Could not verify', '', shown.placed)
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

/** What the plugins menu cannot promise yet. */
export const BROWSE_NOTE = 'AI Install Guard: plugins picked from this menu are not scanned yet. To scan one first, run /plugin install <name>@<marketplace>'

/** The name a decision is kept under, so /guard forget finds it: the plugin as typed, or the marketplace's source. */
function nameOf(request: InstallRequest): string {
  if (request.kind === 'marketplace') return safeLine(request.source)
  return safeLine(request.marketplace === undefined ? request.plugin : `${request.plugin}@${request.marketplace}`)
}

function afterScan(request: GuardRequest, name: string, shown: Shown): Judgement {
  if (shown.kind === 'failed') return shown.superseded ? superseded(request) : hold(request, 'Could not verify', '', shown.placed)
  const sha = shown.report.source?.sha
  const where = sha === undefined ? '' : ` at commit ${sha.slice(0, 12)}`
  // The same files approved before (through /guard scan, or an earlier install), and judged no
  // worse now, need no second press.
  if (shown.view.decision === 'approved') return { kind: 'allow', note: `AI Install Guard: you approved ${name}${where} on ${day(shown.view.decidedAt ?? Date.now())}; installing it` }
  if (shown.view.decision === 'rejected') return rejected(request, name, where, shown.view.decidedAt)
  if (shown.superseded) return superseded(request)
  return hold(request, shown.report.verdict.recommendation, where, shown.placed, shown.text)
}

/** Another scan took the pane before this one finished: nothing to press, so nothing installs. */
function superseded(request: GuardRequest): Judgement {
  const text = `AI Install Guard: another scan took the pane before the one for ${request.label} finished, so nothing was installed.`
  return { kind: 'hold', text: request.origin === 'tool' ? `${text} Do not retry it now; tell the person, and run it again once they ask.` : `${text} Run it again to review it.` }
}

function rejected(request: GuardRequest, name: string, where: string, decidedAt: number | undefined): Judgement {
  const when = decidedAt === undefined ? '' : ` on ${day(decidedAt)}`
  if (request.origin === 'tool') {
    return { kind: 'hold', text: `AI Install Guard: the person rejected this exact version of ${name}${where}${when}. Nothing was installed. Do not install it or try another way.` }
  }
  return { kind: 'hold', text: `AI Install Guard: you rejected ${name}${where}${when}. Nothing was installed. /guard forget ${name} judges it again.` }
}

/** The answer while an install waits for the person's decision in the pane. */
function hold(request: GuardRequest, recommendation: string, where: string, placed: boolean, report?: string): Judgement {
  const what = `${recommendation} for ${request.label}${where}`
  if (request.origin === 'tool') {
    const next = placed
      ? 'The verdict and the Install and Reject buttons are in the guard\'s pane. Tell the person the install waits for their decision there, and run the same command again only after they say they approved it.'
      : 'This session cannot show the guard\'s pane, so the person cannot approve it here.'
    return { kind: 'hold', text: `AI Install Guard held this install for the person to review: ${what}. Nothing was installed. Do not retry it or install it another way. ${next}` }
  }
  if (!placed) {
    return { kind: 'hold', text: `${report === undefined ? '' : `${report}\n\n`}AI Install Guard: ${what}. Nothing was installed: approving an install needs the guard's pane, which this session cannot show.` }
  }
  return { kind: 'hold', text: `AI Install Guard: ${what}. Nothing is installed yet: press Install in the guard's pane to install it, or Reject.` }
}

function day(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

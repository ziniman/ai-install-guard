// A scan shown in the pane: progress while it runs, then the verdict, the
// stored report Copy report copies and the view /guard report reopens.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { GuardAction, GuardRequest, GuardView } from '../../types'
import { modHost } from '../mod-host'
import type { RemoteSpec } from '../scan/remote'
import { formatReport } from '../scan/report'
import { safeLine } from '../scan/safe-text'
import type { CheckResult } from '../scan/checks/types'
import { scanFolder, scanRemote, type ScanReport } from '../scan/scan'
import { overlayHost } from '../scan/overlay-host'
import { virtualHost } from '../scan/virtual-host'
import type { Host } from '../scan/host'
import { decisionFor, saveLastView, saveReport } from './decisions'
import { ownVersion } from './version'
import { PANE_ID, scanningView, viewOf } from './view'

const viewAtom = atom({ plugin: 'ai-install-guard', key: 'view' } as const, null)

/**
 * What a scan reads: one commit of a repository, a folder on this machine, or
 * files the guard built in memory under `root` (an MCP server's configuration),
 * with `notes` added to its report.
 */
export type ScanHow =
  | { remote: RemoteSpec }
  /** A folder on this machine; with `kind`, a part Claude Code loads on its own (a skill's folder), named so, with no plugin to validate. */
  | { folder: string; kind?: string }
  | { files: Record<string, string>; root: string; notes?: CheckResult[]; kind: string }
  /** A real folder with the file at `rel` as a write is about to make it. */
  | { overlay: { root: string; rel: string; content: string }; kind: string }

/**
 * Scans what `how` names, with no pane: the gate's first look at a write,
 * which goes through without a pane when the scan finds nothing.
 */
export async function scanOnly(host: Host, target: string, how: ScanHow, options: { lookups: boolean; onStage?: (stage: string) => Promise<void> }): Promise<ScanReport> {
  if ('remote' in how) return scanRemote(host, target, how.remote, options)
  // Nothing to validate in a folder the guard built or overlaid; notes say what the scan could not read.
  if ('files' in how) return scanFolder(virtualHost(how.root, how.files, host.fetch), target, how.root, { ...options, validate: false, extraResults: async () => how.notes ?? [] })
  if ('overlay' in how) return scanFolder(overlayHost(host, how.overlay.root, how.overlay.rel, new TextEncoder().encode(how.overlay.content)), target, how.overlay.root, { ...options, validate: false })
  return scanFolder(host, target, how.folder, how.kind === undefined ? options : { ...options, validate: false })
}

export type ShowOptions = {
  action: GuardAction
  /** The install the pane's Install button carries out, for a held install. */
  request?: GuardRequest
  lookups: boolean
  /** A scan of the same thing already made, shown as it is rather than made again. */
  report?: ScanReport
  /**
   * A review the guard opens by itself (a held mod, a plugin found on at a
   * session's start): it takes the pane only when the pane is free, in the
   * same step that looks, and never over a verdict still waiting for you.
   */
  ifFree?: boolean
  /** For several MCP servers written at once, each one's own tree hash: the decision is kept for each too. */
  parts?: string[]
}

export type Shown =
  | { kind: 'done'; report: ScanReport; view: GuardView; text: string; placed: boolean; superseded: boolean }
  | { kind: 'failed'; reason: string; view: GuardView; placed: boolean; superseded: boolean }

let scans = 0

/**
 * A name for one scan, unique in this session, that sorts after every scan
 * started before it: the time, then a count for scans in the same moment.
 */
function newScanId(): string {
  scans += 1
  return `${Date.now().toString(36).padStart(10, '0')}-${scans.toString(36).padStart(6, '0')}`
}

/** Opens the pane on a scan of `how`, and leaves the verdict in it. */
export async function showScan($: EngineInterface, target: string, how: ScanHow | (() => Promise<ScanHow>), options: ShowOptions): Promise<Shown> {
  // Named before anything waits, so a scan asked for later is always the newer one.
  const scanId = newScanId()
  const host = modHost($)
  const scanning = { ...withRequest(scanningView(target, options.action), options.request), scanId }
  const ifFree = options.ifFree === true
  // A review the guard opens by itself takes the pane before showing it, and only a free one.
  if (ifFree && !(await takePane($, scanning, true))) {
    return { kind: 'failed', reason: `Could not verify ${safeLine(target)}: the pane holds a verdict still waiting`, view: scanning, placed: false, superseded: true }
  }
  const opened = await openPane($)
  if (!ifFree && !(await takePane($, scanning))) {
    return { kind: 'failed', reason: `Could not verify ${safeLine(target)}: a newer scan has the pane`, view: scanning, placed: opened, superseded: true }
  }
  $.ui.status(`AI Install Guard: scanning ${safeLine(target)}`)
  try {
    const scanOptions = {
      lookups: options.lookups,
      // Stage names can carry a candidate's own words (a plugin's name).
      onStage: (stage: string) => update($, viewAtom, current => (current === null || current.scanId !== scanId ? current : { ...current, stage: safeLine(stage) })).then(() => undefined),
    }
    const resolved = typeof how === 'function' ? await how() : how
    const report = options.report ?? (await scanOnly(host, target, resolved, scanOptions))
    // A tree you already decided on shows that decision, not the buttons
    // again, unless it now judges worse than when you approved it.
    const earlier = report.inventory === undefined ? undefined : await decisionFor($, { treeHash: report.inventory.treeHash, sha: report.source?.sha }, report.verdict.kind).catch(() => undefined)
    // What a gate builds, overlays or names by its kind is what is being added, named as such, and no project to badge.
    const kind = 'remote' in resolved ? undefined : resolved.kind
    const built = kind === undefined ? {} : { kind }
    const shownReport = 'kind' in built ? { ...report, badgeHash: undefined } : report
    const base = { ...withRequest(viewOf(shownReport, options.action), options.request), ...built, scanId, ...(options.parts === undefined ? {} : { parts: options.parts }) }
    const view = earlier === undefined ? base : { ...base, decision: earlier.decision, decidedAt: earlier.decidedAt }
    const text = formatReport(report, { details: true, version: await ownVersion($) })
    // A scan started since owns the pane now: this one leaves it, its report
    // and the reopened report alone, so no press lands on the wrong scan.
    if (!(await owns($, scanId))) return { kind: 'done', report, view, text, placed: opened, superseded: true }
    // The report is stored under this scan's name before the pane shows the
    // verdict, so Copy report copies it, and never another scan's.
    await saveReport($, scanId, text)
    if (!(await showOwn($, view))) return { kind: 'done', report, view, text, placed: opened, superseded: true }
    $.ui.toast(`AI Install Guard: ${report.verdict.recommendation} for ${safeLine(target)}`)
    return { kind: 'done', report, view, text, placed: opened, superseded: false }
  } catch (error) {
    const reason = `Could not verify ${safeLine(target)}: ${safeLine(error instanceof Error ? error.message : String(error))}`
    const failed = await showFailure($, target, reason, options, scanId)
    return { kind: 'failed', reason, view: failed.view, placed: opened, superseded: !failed.shown }
  } finally {
    $.ui.status(undefined)
  }
}

/**
 * Opens the pane on an install the guard could not scan: Could not verify,
 * with the reason, and Install anyway behind a second confirmation.
 * `superseded` says a newer scan has the pane instead.
 */
export async function showUnverified($: EngineInterface, target: string, reason: string, options: ShowOptions): Promise<{ view: GuardView; placed: boolean; superseded: boolean }> {
  const scanId = newScanId()
  const scanning = { ...withRequest(scanningView(target, options.action), options.request), scanId }
  const ifFree = options.ifFree === true
  if (ifFree && !(await takePane($, scanning, true))) return { view: scanning, placed: false, superseded: true }
  const placed = await openPane($)
  if (!ifFree && !(await takePane($, scanning))) return { view: scanning, placed, superseded: true }
  // The banner already says Could not verify and the title names the target: the pane shows the reason itself.
  const failed = await showFailure($, target, `Could not verify ${safeLine(target)}: ${safeLine(reason)}`, options, scanId, sentence(reason))
  return { view: failed.view, placed, superseded: !failed.shown }
}

/** A reason as a sentence of its own: made safe, its first letter a capital. */
function sentence(reason: string): string {
  const safe = safeLine(reason)
  return safe.charAt(0).toUpperCase() + safe.slice(1)
}

/**
 * The pane, and the report /guard report reopens, show a failure: never a
 * scanning pane, and never an older verdict in its place. Only while this
 * scan still owns the pane; `shown` says whether it did.
 */
async function showFailure($: EngineInterface, target: string, reason: string, options: ShowOptions, scanId: string, shownReason = reason): Promise<{ view: GuardView; shown: boolean }> {
  const failed: GuardView = {
    ...withRequest(scanningView(target, options.action), options.request),
    scanId,
    stage: '',
    verdict: { kind: 'unverified', recommendation: 'Could not verify', reasons: [shownReason], counts: { pass: 0, warn: 0, fail: 0, info: 0 } },
  }
  if (!(await owns($, scanId).catch(() => false))) return { view: failed, shown: false }
  await saveReport($, scanId, reason)
  return { view: failed, shown: await showOwn($, failed).catch(() => false) }
}

/**
 * Whether a review the guard opens by itself may take the pane: one showing
 * nothing, a decision already made, or another such review. Never a scan
 * still running or a verdict still waiting for you (a held install, a write,
 * your own scan), so neither the session-start check, which ends whenever it
 * ends, nor /guard held takes the pane from it.
 */
function isFree(view: GuardView | null): boolean {
  return view === null || view.decision !== undefined || yields(view)
}

/**
 * A review the guard opened by itself, of a held mod, a plugin found on or
 * part of your configuration, that no press is deciding: any scan may take
 * its place, even one started a moment before it, and /guard held still
 * lists it.
 */
function yields(view: GuardView): boolean {
  const subject = view.request?.subject
  return view.decision === undefined && view.deciding !== true && (subject === 'installed' || subject === 'configured' || subject === 'load')
}

/** Whether the pane still shows this scan. */
async function owns($: EngineInterface, scanId: string): Promise<boolean> {
  return (await read($, viewAtom))?.scanId === scanId
}

/**
 * Takes the pane for a scan just started, unless a newer scan already has it;
 * a review the guard opened by itself gives way to any scan. With `ifFree`,
 * only a free pane is taken, in the same step that looks at it.
 */
async function takePane($: EngineInterface, view: GuardView, ifFree = false): Promise<boolean> {
  let taken = false
  await update($, viewAtom, current => {
    taken = ifFree ? isFree(current) : current === null || current.scanId === undefined || view.scanId === undefined || current.scanId <= view.scanId || yields(current)
    return taken ? view : current
  })
  return taken
}

/**
 * Shows a scan's finished view while the pane still shows that scan, and
 * saves it for /guard report. Should a newer scan take the pane while it is
 * saved, the newer view is saved instead, so the reopened report is always
 * the pane's.
 */
async function showOwn($: EngineInterface, view: GuardView): Promise<boolean> {
  let shown = false
  await update($, viewAtom, current => {
    shown = current?.scanId === view.scanId
    return shown ? view : current
  })
  if (!shown) return false
  await saveLastView($, view).catch(() => undefined)
  const now = await read($, viewAtom).catch(() => null)
  if (now !== null && now.scanId !== view.scanId) await saveLastView($, now).catch(() => undefined)
  return true
}

/** Opens the pane; false where no surface can show it (a headless run). */
async function openPane($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE_ID, title: 'AI Install Guard', focus: true }).catch(() => ({ isPlaced: false }))
  return opened.isPlaced
}

function withRequest(view: GuardView, request: GuardRequest | undefined): GuardView {
  return request === undefined ? view : { ...view, request }
}

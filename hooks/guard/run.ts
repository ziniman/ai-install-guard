// A scan shown in the pane: progress while it runs, then the verdict, the
// stored report Copy report copies and the view /guard report reopens.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { GuardAction, GuardRequest, GuardView } from '../../types'
import { modHost } from '../mod-host'
import type { RemoteSpec } from '../scan/remote'
import { formatReport } from '../scan/report'
import { safeLine } from '../scan/safe-text'
import { scanFolder, scanRemote, type ScanReport } from '../scan/scan'
import { decisionFor, MAX_REPORT_CHARS, saveLastView } from './decisions'
import { REPORT_TEXT } from './pane'
import { PANE_ID, scanningView, viewOf } from './view'

const viewAtom = atom({ plugin: 'ai-install-guard', key: 'view' } as const, null)

export type ScanHow = { remote: RemoteSpec } | { folder: string }

export type ShowOptions = {
  action: GuardAction
  /** The install the pane's Install button carries out, for a held install. */
  request?: GuardRequest
  lookups: boolean
}

export type Shown =
  | { kind: 'done'; report: ScanReport; view: GuardView; text: string; placed: boolean; superseded: boolean }
  | { kind: 'failed'; reason: string; view: GuardView; placed: boolean; superseded: boolean }

let scans = 0

/** A name for one scan, unique in this session. */
function newScanId(): string {
  scans += 1
  return `${Date.now().toString(36)}-${scans}`
}

/** Opens the pane on a scan of `how`, and leaves the verdict in it. */
export async function showScan($: EngineInterface, target: string, how: ScanHow | (() => Promise<ScanHow>), options: ShowOptions): Promise<Shown> {
  const host = modHost($)
  const opened = await openPane($)
  const scanId = newScanId()
  // Until this scan's report is stored, Copy report has nothing to copy, never
  // the previous scan's report.
  await $.store.delete(REPORT_TEXT).catch(() => undefined)
  await update($, viewAtom, () => ({ ...withRequest(scanningView(target, options.action), options.request), scanId }))
  $.ui.status(`AI Install Guard: scanning ${safeLine(target)}`)
  try {
    const scanOptions = {
      lookups: options.lookups,
      // Stage names can carry a candidate's own words (a plugin's name).
      onStage: (stage: string) => update($, viewAtom, current => (current === null || current.scanId !== scanId ? current : { ...current, stage: safeLine(stage) })).then(() => undefined),
    }
    const resolved = typeof how === 'function' ? await how() : how
    const report = 'remote' in resolved ? await scanRemote(host, target, resolved.remote, scanOptions) : await scanFolder(host, target, resolved.folder, scanOptions)
    // A tree you already decided on shows that decision, not the buttons
    // again, unless it now judges worse than when you approved it.
    const earlier = report.inventory === undefined ? undefined : await decisionFor($, { treeHash: report.inventory.treeHash, sha: report.source?.sha }, report.verdict.kind).catch(() => undefined)
    const base = { ...withRequest(viewOf(report, options.action), options.request), scanId }
    const view = earlier === undefined ? base : { ...base, decision: earlier.decision, decidedAt: earlier.decidedAt }
    const text = formatReport(report, { details: true })
    // A scan started since owns the pane now: this one leaves it, its report
    // and the reopened report alone, so no press lands on the wrong scan.
    if (!(await owns($, scanId))) return { kind: 'done', report, view, text, placed: opened, superseded: true }
    // The report text is stored before the pane shows the verdict, so Copy
    // report always copies this scan's report. It is held well inside the
    // store's limit; a failed write leaves Copy with nothing, not old text.
    const stored = text.length > MAX_REPORT_CHARS ? `${text.slice(0, MAX_REPORT_CHARS)}\n… the report was cut here to fit the store` : text
    await $.store.set(REPORT_TEXT, stored).catch(() => undefined)
    let shown = false
    await update($, viewAtom, current => {
      shown = current?.scanId === scanId
      return shown ? view : current
    })
    if (!shown) return { kind: 'done', report, view, text, placed: opened, superseded: true }
    await saveLastView($, view).catch(() => undefined)
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
 */
export async function showUnverified($: EngineInterface, target: string, reason: string, options: ShowOptions): Promise<{ view: GuardView; placed: boolean }> {
  const placed = await openPane($)
  const scanId = newScanId()
  // Copy report never copies the previous scan's report in this one's place.
  await $.store.delete(REPORT_TEXT).catch(() => undefined)
  await update($, viewAtom, () => ({ ...withRequest(scanningView(target, options.action), options.request), scanId }))
  return { view: (await showFailure($, target, `Could not verify ${safeLine(target)}: ${safeLine(reason)}`, options, scanId)).view, placed }
}

/**
 * The pane, and the report /guard report reopens, show a failure: never a
 * scanning pane, and never an older verdict in its place. Only while this
 * scan still owns the pane; `shown` says whether it did.
 */
async function showFailure($: EngineInterface, target: string, reason: string, options: ShowOptions, scanId: string): Promise<{ view: GuardView; shown: boolean }> {
  const failed: GuardView = {
    ...withRequest(scanningView(target, options.action), options.request),
    scanId,
    stage: '',
    verdict: { kind: 'unverified', recommendation: 'Could not verify', reasons: [reason], counts: { pass: 0, warn: 0, fail: 0, info: 0 } },
  }
  if (!(await owns($, scanId).catch(() => false))) return { view: failed, shown: false }
  await $.store.set(REPORT_TEXT, reason).catch(() => $.store.delete(REPORT_TEXT).catch(() => undefined))
  let shown = false
  await update($, viewAtom, current => {
    shown = current?.scanId === scanId
    return shown ? failed : current
  }).catch(() => undefined)
  if (shown) await saveLastView($, failed).catch(() => undefined)
  return { view: failed, shown }
}

/** Whether the pane still shows this scan. */
async function owns($: EngineInterface, scanId: string): Promise<boolean> {
  return (await read($, viewAtom))?.scanId === scanId
}

/** Opens the pane; false where no surface can show it (a headless run). */
async function openPane($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE_ID, title: 'AI Install Guard', focus: true }).catch(() => ({ isPlaced: false }))
  return opened.isPlaced
}

function withRequest(view: GuardView, request: GuardRequest | undefined): GuardView {
  return request === undefined ? view : { ...view, request }
}

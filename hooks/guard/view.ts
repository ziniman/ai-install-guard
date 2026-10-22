import type { GuardAction, GuardRow, GuardView } from '../../types'
import { redactSecrets } from '../scan/checks/patterns'
import type { CheckResult } from '../scan/checks/types'
import { safeLine } from '../scan/safe-text'
import type { ScanReport } from '../scan/scan'

/** Evidence the pane keeps per row; the full list stays in the stored report. */
const EVIDENCE_PER_ROW = 20
/** Characters the pane keeps per excerpt or reason: one huge hook command cannot fill the store. */
const MAX_TEXT = 500

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text
}

export const PANE_ID = 'ai-install-guard'

export function scanningView(target: string, action: GuardAction): GuardView {
  return { target: safeLine(target), action, stage: 'Starting', rows: [], expanded: [], details: false, confirming: false }
}

/** The pane's view of a finished scan: compact, every quoted text made safe. */
export function viewOf(report: ScanReport, action: GuardAction): GuardView {
  return {
    // The person's own words, but drawn beside an Approve button: made safe too.
    target: safeLine(report.target),
    action,
    stage: '',
    verdict: {
      ...report.verdict,
      reasons: report.verdict.reasons.map(reason => clip(safeLine(redactSecrets(reason)))),
    },
    rows: report.results.map(rowOf),
    kind: report.kind,
    // A remote scan's folder is a temporary one: its source names it instead.
    root:
      report.source !== undefined
        ? safeLine(`${report.source.url}${report.source.subdir === undefined ? '' : `#${report.source.subdir}`}`)
        : report.inventory === undefined
          ? undefined
          : safeLine(report.inventory.root),
    sha: report.source?.sha,
    treeHash: report.inventory?.treeHash,
    expanded: [],
    details: false,
    confirming: false,
  }
}

function rowOf(result: CheckResult): GuardRow {
  return {
    id: result.id,
    group: result.group,
    title: result.title,
    status: result.status,
    evidence: result.evidence.slice(0, EVIDENCE_PER_ROW).map(item => ({
      file: clip(safeLine(redactSecrets(item.file))),
      line: item.line,
      excerpt: clip(safeLine(redactSecrets(item.excerpt))),
      status: item.status,
    })),
    more: Math.max(0, result.evidence.length - EVIDENCE_PER_ROW),
    advice: result.advice,
  }
}

/** Whether the primary button needs a second, explicit confirmation: the verdict is Do not install or Could not verify. */
export function needsConfirmation(view: GuardView): boolean {
  return view.verdict === undefined || view.verdict.kind === 'reject' || view.verdict.kind === 'unverified'
}

/** The primary button's label for this verdict. */
export function primaryLabel(view: GuardView): string {
  const verb = view.action === 'install' ? 'Install' : 'Approve'
  return needsConfirmation(view) ? `${verb} anyway` : verb
}

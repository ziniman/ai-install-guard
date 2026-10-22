import type { GuardAction, GuardRow, GuardView } from '../../types'
import { redactSecrets } from '../scan/checks/patterns'
import type { CheckResult } from '../scan/checks/types'
import { safeLine } from '../scan/safe-text'
import type { ScanReport } from '../scan/scan'

/** Evidence the pane keeps per row; the full list stays in the stored report. */
const EVIDENCE_PER_ROW = 20

export const PANE_ID = 'ai-install-guard'

export function scanningView(target: string, action: GuardAction): GuardView {
  return { target, action, stage: 'Starting', rows: [], expanded: [], details: false, confirming: false }
}

/** The pane's view of a finished scan: compact, every quoted text made safe. */
export function viewOf(report: ScanReport, action: GuardAction): GuardView {
  return {
    target: report.target,
    action,
    stage: '',
    verdict: {
      ...report.verdict,
      reasons: report.verdict.reasons.map(reason => safeLine(redactSecrets(reason))),
    },
    rows: report.results.map(rowOf),
    kind: report.kind,
    root: report.inventory?.root,
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
      file: safeLine(item.file),
      line: item.line,
      excerpt: safeLine(redactSecrets(item.excerpt)),
      status: item.status,
    })),
    more: Math.max(0, result.evidence.length - EVIDENCE_PER_ROW),
    advice: result.advice,
  }
}

/** Whether pressing the primary button once is enough. */
export function needsConfirmation(view: GuardView): boolean {
  return view.verdict === undefined || view.verdict.kind === 'reject' || view.verdict.kind === 'unverified'
}

/** The primary button's label for this verdict. */
export function primaryLabel(view: GuardView): string {
  const verb = view.action === 'install' ? 'Install' : 'Approve'
  return needsConfirmation(view) ? `${verb} anyway` : verb
}

// AI Install Guard's state contract: the session values its pane draws from.
// Full reports live in $.store; this holds only what the open pane shows.

export type GuardStatus = 'pass' | 'warn' | 'fail' | 'info'

export type GuardEvidence = {
  file: string
  line?: number
  excerpt: string
  status?: GuardStatus
}

/** One check as the pane shows it, evidence capped. */
export type GuardRow = {
  id: string
  group: string
  title: string
  status: GuardStatus
  evidence: GuardEvidence[]
  /** How many more pieces of evidence the full report holds. */
  more: number
  advice: string
}

export type GuardVerdict = {
  kind: 'safe' | 'caution' | 'reject' | 'unverified'
  recommendation: string
  reasons: string[]
  counts: { pass: number; warn: number; fail: number; info: number }
}

/** What the primary button does: install the candidate, or approve a scanned folder. */
export type GuardAction = 'install' | 'approve'

/** The scan the pane shows: in progress, then done with a verdict and a decision. */
export type GuardView = {
  target: string
  action: GuardAction
  /** What the scan is doing now; empty once it is done. */
  stage: string
  verdict?: GuardVerdict
  rows: GuardRow[]
  kind?: string
  root?: string
  treeHash?: string
  /** Rows the person opened. */
  expanded: string[]
  /** Every row open. */
  details: boolean
  /** "Install anyway" was pressed once and waits for its confirmation. */
  confirming: boolean
  decision?: 'approved' | 'rejected'
  /** When the decision was made: now, or in an earlier scan of the same tree. */
  decidedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'ai-install-guard': {
      view: GuardView | null
    }
  }
}

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
  /** What the evidence means in plain words: a headline, then a few lines. */
  summary?: string[]
}

export type GuardVerdict = {
  kind: 'safe' | 'caution' | 'reject' | 'unverified'
  recommendation: string
  reasons: string[]
  /** What it can do, in plain words: shown beside the verdict, never a reason in itself. */
  access?: string[]
  counts: { pass: number; warn: number; fail: number; info: number }
}

/** What the primary button does: install the candidate, or approve a scanned folder. */
export type GuardAction = 'install' | 'approve'

/** An install the guard holds until the person decides: what Install then carries out. */
export type GuardRequest = {
  /** Where it was asked for: the person's own /plugin command, or a command Claude ran. */
  origin: 'command' | 'tool'
  /** The /plugin arguments, or Claude's whole shell command, exactly as given. */
  args: string
  /** What it installs, as the pane names it. */
  label: string
  /** An install (the default), a file Claude writes into a place Claude Code loads from, a shell command that changes one, a mod kept from loading, or a skill held on its first use. */
  subject?: 'install' | 'write' | 'command' | 'load' | 'skill'
  /** The pane's line for what Claude asked for, when `args` is not one to show (a write's path, not its content). */
  display?: string
}

/**
 * One install the person allowed although nothing could be pinned (Could not
 * verify, Install anyway): it lets exactly that command through, once.
 */
export type GuardPass = {
  origin: GuardRequest['origin']
  args: string
}

/** The scan the pane shows: in progress, then done with a verdict and a decision. */
export type GuardView = {
  /** Which scan this is: a scan writes only its own view, and a press counts only on the view it was drawn from. */
  scanId?: string
  target: string
  action: GuardAction
  /** What the scan is doing now; empty once it is done. */
  stage: string
  verdict?: GuardVerdict
  rows: GuardRow[]
  kind?: string
  root?: string
  /** The commit a remote scan fetched; absent for a local folder. */
  sha?: string
  /** The folder inside the repository a remote scan covered, when it was one. */
  subdir?: string
  treeHash?: string
  /** What a README badge for this scan names: the tree hash with the README read without its badges. */
  badgeHash?: string
  /** Rows the person opened. */
  expanded: string[]
  /** Every row open. */
  details: boolean
  /** Rows whose code lines are shown under their summary. */
  codeOpen?: string[]
  /** The held install Install carries out; absent for a scan you asked for. */
  request?: GuardRequest
  /** "Install anyway" was pressed once and waits for its confirmation. */
  confirming: boolean
  /** A decision is being saved and carried out; the buttons wait. */
  deciding?: boolean
  decision?: 'approved' | 'rejected'
  /** When the decision was made: now, or in an earlier scan of the same tree. */
  decidedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'ai-install-guard': {
      view: GuardView | null
      /** Installs allowed once in this session, each used up when it goes through. */
      passes: GuardPass[]
    }
  }
}

import { redactSecrets } from './patterns'

export type Status = 'pass' | 'warn' | 'fail' | 'info'

export type Severity = 'none' | 'low' | 'medium' | 'high' | 'critical'

export type GroupId =
  | 'provenance'
  | 'structure'
  | 'mod'
  | 'hooks'
  | 'mcp'
  | 'prompts'
  | 'code'
  | 'secrets'
  | 'quality'
  | 'update'

/** The report's groups, in the order it shows them. */
export const GROUPS: readonly { id: GroupId; title: string }[] = [
  { id: 'provenance', title: 'Provenance and trust' },
  { id: 'structure', title: 'Structure and manifest' },
  { id: 'mod', title: 'Mod capabilities' },
  { id: 'hooks', title: 'Classic hooks' },
  { id: 'mcp', title: 'MCP servers' },
  { id: 'prompts', title: 'Skills, commands and agents' },
  { id: 'code', title: 'Code patterns' },
  { id: 'secrets', title: 'Committed secrets' },
  { id: 'quality', title: 'Quality signals' },
  { id: 'update', title: 'New since the version you approved' },
]

/**
 * One place a check points at. `excerpt` is quoted from the candidate and is
 * untrusted: reports pass it through `safeText` and never render it as
 * markup. `status` says how bad this one place is, when a row mixes them.
 */
export type Evidence = {
  file: string
  line?: number
  excerpt: string
  status?: Status
}

export type CheckResult = {
  id: string
  group: GroupId
  title: string
  status: Status
  severity: Severity
  evidence: Evidence[]
  advice: string
  /**
   * What the evidence means, in plain words for a person: a headline, then a
   * few lines. Shown before the evidence, which stays one step further in.
   */
  summary?: string[]
  /**
   * What the candidate can do, as short phrases for the verdict's "It can"
   * line ("run shell commands when a session starts"). A capability is not a
   * red flag: these never change the verdict. A row's status does.
   */
  access?: string[]
}

const RANK: Record<Status, number> = { info: 0, pass: 1, warn: 2, fail: 3 }

/** The worse of two statuses: fail > warn > pass > info. */
export function worse(a: Status, b: Status): Status {
  return RANK[a] >= RANK[b] ? a : b
}

export function rankOf(status: Status): number {
  return RANK[status]
}

export function severityFor(status: Status): Severity {
  return status === 'fail' ? 'high' : status === 'warn' ? 'medium' : 'none'
}

/**
 * At most `max` pieces of evidence, the worst first, and a line counting the
 * rest. Every piece is judged before capping, so a late failure still counts.
 */
/** The order evidence is shown in: red flags, things worth a look, notes, then what passed. */
const SHOWN: Record<Status, number> = { fail: 3, warn: 2, info: 1, pass: 0 }

/**
 * The worst `limit` of a check's judged findings, then at most `notes` notes.
 * Judge every match before keeping any: harmless mentions that come first
 * must not push a real finding out of the report.
 */
export function worstFirst<T extends { status?: Status }>(items: readonly T[], limit: number, notes = 2): T[] {
  const ranked = [...items].sort((a, b) => SHOWN[b.status ?? 'warn'] - SHOWN[a.status ?? 'warn'])
  const flagged = ranked.filter(item => item.status !== 'info' && item.status !== 'pass').slice(0, limit)
  return [...flagged, ...ranked.filter(item => item.status === 'info').slice(0, notes)]
}

export function capEvidence(evidence: Evidence[], max: number, fallback: Status = 'warn'): Evidence[] {
  if (evidence.length <= max) return evidence
  // A note says something; a pass only that nothing was found: notes are kept first.
  const worstFirst = [...evidence].sort((a, b) => SHOWN[b.status ?? fallback] - SHOWN[a.status ?? fallback])
  return [...worstFirst.slice(0, max), { file: '-', excerpt: `and ${evidence.length - max} more`, status: 'info' }]
}

/**
 * Builds a check's row from its evidence: the row takes the worst status any
 * piece of evidence carries (`fallback` when none does), and `pass` when
 * there is no evidence at all.
 */
export function row(
  base: { id: string; group: GroupId; title: string; advice: string; summary?: string[]; access?: string[] },
  evidence: Evidence[],
  fallback: Status = 'warn',
  severity?: Severity,
): CheckResult {
  if (evidence.length === 0) {
    const { summary: _unused, access: _none, ...rest } = base
    return { ...rest, status: 'pass', severity: 'none', evidence: [] }
  }
  const status = evidence.reduce<Status>((acc, item) => worse(acc, item.status ?? fallback), 'info')
  const worstFirst = [...evidence]
    .sort((a, b) => SHOWN[b.status ?? fallback] - SHOWN[a.status ?? fallback])
    .map(item => ({ ...item, excerpt: redactSecrets(item.excerpt) }))
  return { ...base, status, severity: severity ?? severityFor(status), evidence: worstFirst }
}

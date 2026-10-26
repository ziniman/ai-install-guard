import { redactSecrets } from './checks/patterns'
import { rankOf, type CheckResult } from './checks/types'

export type VerdictKind = 'safe' | 'caution' | 'reject' | 'unverified'

/**
 * The verdict answers one question: is anything suspicious? What the
 * candidate can do (its hooks, servers, network and shell access) is listed
 * beside it in `access`, and never makes it look worse on its own.
 */
export const RECOMMENDATION: Record<VerdictKind, string> = {
  safe: 'No red flags',
  // Something specific deserves a closer look before you install: not a refusal.
  caution: 'Worth a look',
  reject: 'Do not install',
  unverified: 'Could not verify',
}

/** "It can" lines kept in a verdict: the rest stay on their rows. */
const MAX_ACCESS = 8

export type Counts = { pass: number; warn: number; fail: number; info: number }

export type Verdict = {
  kind: VerdictKind
  recommendation: string
  /** Up to three: why not to install, what to watch, or why it could not be judged. */
  reasons: string[]
  /** What the candidate can do, in plain words, for the "It can" line: never a reason in itself. */
  access: string[]
  counts: Counts
}

/**
 * Any FAIL (a red flag): do not install. Else any WARN: worth a look. Else no
 * red flags. A scan that could not finish is "could not verify" whatever it
 * found. Rows only ever add to this: nothing a row says can lower another row.
 */
export function decide(results: readonly CheckResult[], error?: string): Verdict {
  const counts: Counts = { pass: 0, warn: 0, fail: 0, info: 0 }
  for (const result of results) counts[result.status] += 1
  // The phrases can carry a candidate's own words (a server's name): keys in them are hidden, as in evidence.
  const access = [...new Set(results.flatMap(result => result.access ?? []).map(line => redactSecrets(line)))].slice(0, MAX_ACCESS)
  if (error !== undefined) {
    return { kind: 'unverified', recommendation: RECOMMENDATION.unverified, reasons: [error], access, counts }
  }
  const kind: VerdictKind = counts.fail > 0 ? 'reject' : counts.warn > 0 ? 'caution' : 'safe'
  const focus = kind === 'reject' ? 'fail' : 'warn'
  const reasons = [...results]
    .filter(result => result.status === focus)
    .sort((a, b) => severityRank(b) - severityRank(a))
    .slice(0, 3)
    .map(reasonOf)
  return { kind, recommendation: RECOMMENDATION[kind], reasons, access, counts }
}

function severityRank(result: CheckResult): number {
  const order = { none: 0, low: 1, medium: 2, high: 3, critical: 4 }
  return order[result.severity] * 10 + rankOf(result.status)
}

/**
 * `Title: what it means` from the row's plain summary, or `Title: file:line
 * what` from its worst piece of evidence when it has none.
 */
export function reasonOf(result: CheckResult): string {
  const headline = result.summary?.[0]
  if (headline !== undefined) return `${result.title}: ${headline}`
  const worst = [...result.evidence].sort((a, b) => rankOf(b.status ?? result.status) - rankOf(a.status ?? result.status))[0]
  if (worst === undefined) return result.title
  return `${result.title}: ${locate(worst.file, worst.line)}${worst.excerpt}`
}

export function locate(file: string, line?: number): string {
  if (file === '-' || file === '') return ''
  return `${file}${line === undefined ? '' : `:${line}`} `
}

/** The counts in words: red flags first, then what is worth a look, then what passed. */
export function countsText(counts: Counts): string {
  return `${counts.fail} red flag${counts.fail === 1 ? '' : 's'} · ${counts.warn} to look at · ${counts.pass} passed`
}

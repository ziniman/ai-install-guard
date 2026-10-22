import { rankOf, type CheckResult } from './checks/types'

export type VerdictKind = 'safe' | 'caution' | 'reject' | 'unverified'

export const RECOMMENDATION: Record<VerdictKind, string> = {
  safe: 'Safe to install',
  caution: 'Install with caution',
  reject: 'Do not install',
  unverified: 'Could not verify',
}

export type Counts = { pass: number; warn: number; fail: number; info: number }

export type Verdict = {
  kind: VerdictKind
  recommendation: string
  /** Up to three: why not to install, what to watch, or why it could not be judged. */
  reasons: string[]
  counts: Counts
}

/**
 * Any FAIL: do not install. Else any WARN: install with caution. Else safe.
 * A scan that could not finish is "could not verify" whatever it found.
 * Rows only ever add to this: nothing a row says can lower another row.
 */
export function decide(results: readonly CheckResult[], error?: string): Verdict {
  const counts: Counts = { pass: 0, warn: 0, fail: 0, info: 0 }
  for (const result of results) counts[result.status] += 1
  if (error !== undefined) {
    return { kind: 'unverified', recommendation: RECOMMENDATION.unverified, reasons: [error], counts }
  }
  const kind: VerdictKind = counts.fail > 0 ? 'reject' : counts.warn > 0 ? 'caution' : 'safe'
  const focus = kind === 'reject' ? 'fail' : 'warn'
  const reasons = [...results]
    .filter(result => result.status === focus)
    .sort((a, b) => severityRank(b) - severityRank(a))
    .slice(0, 3)
    .map(reasonOf)
  return { kind, recommendation: RECOMMENDATION[kind], reasons, counts }
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

import type { Host } from '../host'
import { isRecord, parseJson } from './context'

export type ValidatorProblem = { file: string; message: string }

export type ValidatorReport =
  | {
      ran: true
      errors: ValidatorProblem[]
      warnings: ValidatorProblem[]
      /** Per module: the events it hooks and the `$` calls it makes, as Claude Code reads them. */
      modules: { module: string; hooks: string[]; calls: string[] }[]
    }
  | { ran: false; reason: string }

const TIMEOUT_MS = 60_000

/**
 * Runs `claude plugin validate --json` on the candidate. It reads the
 * manifest and the hooks module's source the way Claude Code will and runs
 * none of it, so it is the one external tool the scan uses on a candidate.
 */
export async function runValidator(host: Host, root: string): Promise<ValidatorReport> {
  const result = await host
    .run(['claude', 'plugin', 'validate', '--json', root], { timeoutMs: TIMEOUT_MS })
    .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }))
  const parsed = parseJson(result.stdout)
  // Only a report shaped like one counts: an error object is not a pass.
  const isReport = parsed.ok && isRecord(parsed.value) && typeof parsed.value.success === 'boolean' && ('manifest' in parsed.value || 'contents' in parsed.value)
  if (!isReport || !parsed.ok || !isRecord(parsed.value)) {
    const reason = result.stderr.trim().split('\n')[0] ?? ''
    return { ran: false, reason: reason === '' ? `exit code ${result.exitCode}` : reason.slice(0, 200) }
  }
  const report = parseValidatorReport(parsed.value)
  if (report.ran && parsed.value.success === false && report.errors.length === 0) {
    report.errors.push({ file: '-', message: `claude plugin validate failed (exit code ${result.exitCode})` })
  }
  return report
}

export function parseValidatorReport(report: Record<string, unknown>): ValidatorReport {
  const errors: ValidatorProblem[] = []
  const warnings: ValidatorProblem[] = []
  const modules: { module: string; hooks: string[]; calls: string[] }[] = []
  const sections = [report.manifest, ...(Array.isArray(report.contents) ? report.contents : [])]
  for (const section of sections) {
    if (!isRecord(section)) continue
    const file = typeof section.file === 'string' ? section.file : '-'
    for (const item of Array.isArray(section.errors) ? section.errors : []) errors.push(problem(file, item))
    for (const item of Array.isArray(section.warnings) ? section.warnings : []) warnings.push(problem(file, item))
    for (const note of Array.isArray(section.notes) ? section.notes : []) {
      if (typeof note !== 'string') continue
      const hooks = /^(\S+) hooks: (.*)$/.exec(note)
      const calls = /^(\S+) calls: (.*)$/.exec(note)
      const match = hooks ?? calls
      if (match === null) continue
      const name = match[1] as string
      let entry = modules.find(item => item.module === name)
      if (entry === undefined) {
        entry = { module: name, hooks: [], calls: [] }
        modules.push(entry)
      }
      const list = splitList(match[2] as string)
      if (hooks !== null) entry.hooks.push(...list)
      else entry.calls.push(...list.map(call => call.replace(/^\$\./, '').replace(/\s*\(via [^)]*\)$/, '')))
    }
  }
  return { ran: true, errors, warnings, modules }
}

function problem(file: string, item: unknown): ValidatorProblem {
  if (typeof item === 'string') return { file, message: item }
  if (isRecord(item)) {
    const path = typeof item.path === 'string' && item.path !== '' ? `${item.path}: ` : ''
    return { file, message: `${path}${typeof item.message === 'string' ? item.message : JSON.stringify(item)}` }
  }
  return { file, message: String(item) }
}

/** Splits `a, b{x=1, y=2}, c` on top-level commas. */
function splitList(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '{' || char === '(') depth += 1
    if (char === '}' || char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      if (current.trim() !== '') out.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim() !== '') out.push(current.trim())
  return out
}

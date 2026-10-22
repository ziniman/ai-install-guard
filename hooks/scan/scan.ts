import { codeChecks } from './checks/code'
import { buildContext, type CandidateKind } from './checks/context'
import { hookChecks } from './checks/hooks'
import { modChecks } from './checks/mod'
import { promptChecks } from './checks/prompts'
import { licenseCheck, qualityChecks } from './checks/quality'
import { secretChecks } from './checks/secrets'
import { structureChecks } from './checks/structure'
import { GROUPS, type CheckResult } from './checks/types'
import { runValidator } from './checks/validator'
import type { Host } from './host'
import { ScanError, takeInventory, type Inventory } from './inventory'
import { decide, type Verdict } from './verdict'

export type ScanReport = {
  /** What was asked for, as the person wrote it. */
  target: string
  kind?: CandidateKind
  inventory?: Inventory
  results: CheckResult[]
  verdict: Verdict
}

export type ScanOptions = {
  /** Run `claude plugin validate` on the candidate (on by default). */
  validate?: boolean
  /**
   * Rows from analyzers outside the deterministic checks (the model review, an
   * add-on). They are added to the report; they can raise the verdict and
   * never lower it, because a row can only add a WARN or FAIL of its own.
   */
  extraResults?: (report: Omit<ScanReport, 'verdict'>) => Promise<CheckResult[]>
}

/** Scans a local folder: inventory, every deterministic check, the verdict. */
export async function scanFolder(host: Host, target: string, path: string, options: ScanOptions = {}): Promise<ScanReport> {
  let tree
  try {
    tree = await takeInventory(host, path)
  } catch (error) {
    return { target, results: [], verdict: decide([], reasonOf(error)) }
  }
  const ctx = buildContext(tree)
  const validator = options.validate === false || ctx.kind === 'folder' ? undefined : await runValidator(host, tree.inventory.root)
  let results: CheckResult[]
  try {
    results = [
      licenseCheck(ctx),
      ...structureChecks(ctx, validator),
      ...modChecks(ctx, validator),
      ...hookChecks(ctx),
      ...promptChecks(ctx),
      ...codeChecks(ctx),
      ...secretChecks(ctx),
      ...qualityChecks(ctx),
    ]
  } catch (error) {
    return { target, kind: ctx.kind, inventory: tree.inventory, results: [], verdict: decide([], `a check failed: ${reasonOf(error)}`) }
  }
  if (options.extraResults !== undefined) {
    const extra = await options.extraResults({ target, kind: ctx.kind, inventory: tree.inventory, results }).catch(() => [])
    results = [...results, ...extra]
  }
  results = sortResults(results)
  return { target, kind: ctx.kind, inventory: tree.inventory, results, verdict: decide(results) }
}

/** In group order; inside a group, failures first, then warnings. */
export function sortResults(results: readonly CheckResult[]): CheckResult[] {
  const groupIndex = new Map(GROUPS.map((group, index) => [group.id, index]))
  const statusIndex = { fail: 0, warn: 1, pass: 2, info: 3 }
  return results
    .map((result, index) => ({ result, index }))
    .sort((a, b) =>
      (groupIndex.get(a.result.group) ?? 99) - (groupIndex.get(b.result.group) ?? 99) ||
      statusIndex[a.result.status] - statusIndex[b.result.status] ||
      a.index - b.index,
    )
    .map(item => item.result)
}

function reasonOf(error: unknown): string {
  if (error instanceof ScanError) return error.message
  return error instanceof Error ? error.message : String(error)
}

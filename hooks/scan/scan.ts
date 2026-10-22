import { codeChecks } from './checks/code'
import { buildContext, isRecord, parseJson, type CandidateKind, type ScanContext } from './checks/context'
import { hookChecks } from './checks/hooks'
import { mcpChecks } from './checks/mcp'
import { modChecks } from './checks/mod'
import { promptChecks } from './checks/prompts'
import { marketplacePinsCheck } from './checks/provenance'
import { licenseCheck, qualityChecks } from './checks/quality'
import { secretChecks } from './checks/secrets'
import { structureChecks } from './checks/structure'
import { joinPath } from './checks/text'
import { GROUPS, rankOf, type CheckResult, type Evidence } from './checks/types'
import { runValidator } from './checks/validator'
import type { Host } from './host'
import { treeHash } from './hash'
import { ScanError, takeInventory, type Inventory, type InventoryEntry, type ScannedTree } from './inventory'
import { fetchPinned, type PinnedSource, type RemoteSpec } from './remote'
import { decide, type Verdict } from './verdict'

export type ScanReport = {
  /** What was asked for, as the person wrote it. */
  target: string
  kind?: CandidateKind
  inventory?: Inventory
  results: CheckResult[]
  verdict: Verdict
  /** For a remote scan: the one commit that was fetched and checked. */
  source?: PinnedSource
}

export type ScanOptions = {
  /** Run `claude plugin validate` on the candidate (on by default). */
  validate?: boolean
  /** Told each stage as it starts, for progress in the pane. */
  onStage?: (stage: string) => Promise<void> | void
  /**
   * Rows from analyzers outside the deterministic checks (the model review, an
   * add-on). They are added to the report; they can raise the verdict and
   * never lower it, because a row can only add a WARN or FAIL of its own.
   */
  extraResults?: (report: Omit<ScanReport, 'verdict'>) => Promise<CheckResult[]>
}

/** Scans a local folder: inventory, every deterministic check, the verdict. */
export async function scanFolder(host: Host, target: string, path: string, rawOptions: ScanOptions = {}): Promise<ScanReport> {
  // Progress is a courtesy: a failure to show it never fails the scan.
  const options: ScanOptions = {
    ...rawOptions,
    onStage: async stage => {
      try {
        await rawOptions.onStage?.(stage)
      } catch {
        // ignored on purpose
      }
    },
  }
  let tree: ScannedTree
  try {
    await options.onStage?.('reading files')
    tree = await takeInventory(host, path)
  } catch (error) {
    return { target, results: [], verdict: decide([], reasonOf(error)) }
  }
  const ctx = buildContext(tree)
  let results: CheckResult[]
  try {
    await options.onStage?.('running the checks')
    results = await checksFor(host, ctx, options)
    // A marketplace's local plugins are plugins in their own right: each is
    // checked from its own folder, as Claude Code would read it.
    for (const source of marketplaceSources(ctx)) {
      if (source.kind === 'overflow') {
        results = mergeResults(results, [overflowRow(source.count)])
        continue
      }
      if (source.kind === 'remote') {
        results = mergeResults(results, [remoteSourceNote(source.name, source.description)])
        continue
      }
      await options.onStage?.(`checking ${source.name}`)
      const nested = await subTree(tree, source.path)
      if (nested === undefined) {
        results = mergeResults(results, [missingSourceRow(source.name, source.path)])
        continue
      }
      results = mergeResults(results, prefixed(await checksFor(host, buildContext(nested), options), source.path))
    }
  } catch (error) {
    return { target, kind: ctx.kind, inventory: tree.inventory, results: [], verdict: decide([], `a check failed: ${reasonOf(error)}`) }
  }
  if (options.extraResults !== undefined) {
    const extra = await options
      .extraResults({ target, kind: ctx.kind, inventory: tree.inventory, results })
      .catch((error: unknown): CheckResult[] => [
        {
          id: 'analysis.unfinished',
          group: 'quality',
          title: 'An additional review did not finish',
          status: 'warn',
          severity: 'medium',
          evidence: [{ file: '-', excerpt: reasonOf(error), status: 'warn' }],
          advice: 'Part of the review you asked for is missing, so the verdict rests on the deterministic checks alone.',
        },
      ])
    results = [...results, ...extra]
  }
  results = sortResults(results)
  return { target, kind: ctx.kind, inventory: tree.inventory, results, verdict: decide(results) }
}

async function checksFor(host: Host, ctx: ScanContext, options: ScanOptions): Promise<CheckResult[]> {
  const validator = options.validate === false || ctx.kind === 'folder' ? undefined : await runValidator(host, ctx.tree.inventory.root)
  return [
    licenseCheck(ctx),
    ...marketplacePinsCheck(ctx),
    ...structureChecks(ctx, validator),
    ...modChecks(ctx, validator),
    ...hookChecks(ctx),
    ...mcpChecks(ctx),
    ...promptChecks(ctx),
    ...codeChecks(ctx),
    ...secretChecks(ctx),
    ...qualityChecks(ctx),
  ]
}

const MAX_NESTED_PLUGINS = 50

type MarketplaceSource =
  | { kind: 'local'; name: string; path: string }
  | { kind: 'remote'; name: string; description: string }
  | { kind: 'overflow'; count: number }

/** The plugins a `.claude-plugin/marketplace.json` lists, other than the root itself. */
/**
 * Scans a remote source: fetches the one commit its ref names into the
 * guard's own temporary folder, scans that folder, and removes it. A failure
 * to fetch or verify is "Could not verify", never a pass.
 */
export async function scanRemote(host: Host, target: string, spec: RemoteSpec, options: ScanOptions = {}): Promise<ScanReport> {
  let fetched
  try {
    fetched = await fetchPinned(host, spec, async stage => {
      try {
        await options.onStage?.(stage)
      } catch {
        // Progress is a courtesy, as in scanFolder.
      }
    })
  } catch (error) {
    return { target, results: [], verdict: decide([], reasonOf(error)) }
  }
  try {
    const report = await scanFolder(host, target, fetched.root, options)
    if (report.verdict.kind === 'unverified') return { ...report, source: fetched.source }
    const results = sortResults([...fetched.results, ...report.results])
    return { ...report, source: fetched.source, results, verdict: decide(results) }
  } finally {
    await fetched.cleanup().catch(() => undefined)
  }
}

function marketplaceSources(ctx: ScanContext): MarketplaceSource[] {
  const raw = ctx.text('.claude-plugin/marketplace.json')
  const parsed = parseJson(raw)
  if (!parsed.ok || !isRecord(parsed.value) || !Array.isArray(parsed.value.plugins)) return []
  const out: MarketplaceSource[] = []
  const skipped = parsed.value.plugins.length - MAX_NESTED_PLUGINS
  if (skipped > 0) out.push({ kind: 'overflow', count: skipped })
  for (const plugin of parsed.value.plugins.slice(0, MAX_NESTED_PLUGINS)) {
    if (!isRecord(plugin)) continue
    const name = typeof plugin.name === 'string' ? plugin.name : '(unnamed)'
    const source = plugin.source
    if (typeof source === 'string' && (source.startsWith('./') || source.startsWith('../'))) {
      const path = joinPath('', source)
      if (path === undefined) out.push({ kind: 'remote', name, description: `${source}, outside the marketplace folder` })
      else if (path !== '') out.push({ kind: 'local', name, path })
    } else {
      out.push({ kind: 'remote', name, description: typeof source === 'string' ? source : JSON.stringify(source) })
    }
  }
  return out
}

/** The part of a scanned tree under `prefix`, re-rooted there. */
async function subTree(tree: ScannedTree, prefix: string): Promise<ScannedTree | undefined> {
  const root = `${tree.inventory.root}/${prefix}`
  const entries = tree.inventory.entries
    .filter(entry => entry.path.startsWith(`${prefix}/`))
    .map((entry): InventoryEntry => {
      const path = entry.path.slice(prefix.length + 1)
      if (entry.kind !== 'link' || !entry.isInside || entry.landsAt === undefined) return { ...entry, path }
      // A link's landing, seen from the nested plugin: inside it, or outside
      // it (once installed on its own, the plugin no longer holds that file).
      if (entry.landsAt === prefix) return { ...entry, path, landsAt: '.' }
      return entry.landsAt.startsWith(`${prefix}/`)
        ? { ...entry, path, landsAt: entry.landsAt.slice(prefix.length + 1) }
        : { ...entry, path, landsAt: `${tree.inventory.root}/${entry.landsAt}`, isInside: false }
    })
  if (entries.length === 0) return undefined
  const contents = new Map<string, Uint8Array>()
  for (const [path, bytes] of tree.contents) if (path.startsWith(`${prefix}/`)) contents.set(path.slice(prefix.length + 1), bytes)
  return {
    inventory: {
      root,
      entries,
      totalBytes: entries.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0),
      treeHash: await treeHash(entries),
      skipped: [],
    },
    contents,
  }
}

/** A nested plugin's rows, with every place named from the marketplace root. */
function prefixed(results: readonly CheckResult[], prefix: string): CheckResult[] {
  return results.map(result => ({
    ...result,
    evidence: result.evidence.map(item =>
      item.file === '-' || item.file === '' ? { ...item, excerpt: `${prefix}: ${item.excerpt}` } : { ...item, file: `${prefix}/${item.file}` },
    ),
  }))
}

/** One row per check: evidence from both, without repeats, at the worse status. */
export function mergeResults(base: readonly CheckResult[], extra: readonly CheckResult[]): CheckResult[] {
  const out = base.map(result => ({ ...result, evidence: [...result.evidence] }))
  const order = { none: 0, low: 1, medium: 2, high: 3, critical: 4 }
  for (const result of extra) {
    const existing = out.find(item => item.id === result.id)
    if (existing === undefined) {
      out.push({ ...result, evidence: [...result.evidence] })
      continue
    }
    const seen = new Map(existing.evidence.map((item, index) => [`${item.file}:${item.line ?? ''}:${item.excerpt}`, index]))
    for (const item of result.evidence) {
      const key = `${item.file}:${item.line ?? ''}:${item.excerpt}`
      const at = seen.get(key)
      if (at === undefined) {
        existing.evidence.push(item)
        continue
      }
      // The same place seen twice keeps the worse judgement, so a failure is
      // never shown with only a note as its evidence.
      const kept = existing.evidence[at] as Evidence
      if (rankOf(item.status ?? result.status) > rankOf(kept.status ?? existing.status)) existing.evidence[at] = item
    }
    // A pass on one side and a note on the other stay a pass; anything worse wins.
    if (rankOf(result.status) > rankOf(existing.status)) existing.status = result.status
    if (order[result.severity] > order[existing.severity]) existing.severity = result.severity
    existing.evidence.sort((a, b) => rankOf(b.status ?? existing.status) - rankOf(a.status ?? existing.status))
  }
  return out
}

function remoteSourceNote(name: string, description: string): CheckResult {
  return {
    id: 'structure.marketplace',
    group: 'structure',
    title: 'Plugins this marketplace lists',
    status: 'info',
    severity: 'none',
    evidence: [{ file: '.claude-plugin/marketplace.json', excerpt: `${name} comes from ${description}: scanned when you install it`, status: 'info' }],
    advice: 'A marketplace only lists plugins. Each one is scanned on its own when it is installed.',
  }
}

function overflowRow(count: number): CheckResult {
  return {
    id: 'structure.marketplace',
    group: 'structure',
    title: 'Plugins this marketplace lists',
    status: 'warn',
    severity: 'medium',
    evidence: [{ file: '.claude-plugin/marketplace.json', excerpt: `${count} more plugins than the ${MAX_NESTED_PLUGINS} checked here were not scanned`, status: 'warn' }],
    advice: 'Unscanned plugins are unknown. Each one is still scanned on its own when it is installed.',
  }
}

function missingSourceRow(name: string, path: string): CheckResult {
  return {
    id: 'structure.marketplace',
    group: 'structure',
    title: 'Plugins this marketplace lists',
    status: 'warn',
    severity: 'medium',
    evidence: [{ file: '.claude-plugin/marketplace.json', excerpt: `${name} points at ${path}, which is not in this folder`, status: 'warn' }],
    advice: 'A marketplace entry that points nowhere cannot be checked.',
  }
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

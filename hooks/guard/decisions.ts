import type { EngineInterface } from 'claude-code'

import type { GuardVerdict, GuardView } from '../../types'
import { safeLine } from '../scan/safe-text'

/** One decision, remembered across sessions so the same tree is never judged twice. */
export type Decision = {
  target: string
  root?: string
  /** The commit, for a remote source. */
  sha?: string
  treeHash: string
  verdict: string
  /** The verdict the decision was made on; an approval holds up to this one. */
  verdictKind: GuardVerdict['kind']
  decision: 'approved' | 'rejected'
  /** Approved although the verdict was Do not install or Could not verify. */
  overridden: boolean
  decidedAt: number
}

const DECISIONS = 'decisions'
/** Room for the report text, well inside the store's 4 MiB in all. */
export const MAX_REPORT_CHARS = 1_000_000
/** The last report as text, under the name of the scan that wrote it. */
const REPORT_TEXT = 'last-report-text'
const LAST_VIEW = 'last-view'
/** The store is capped at 4 MiB in all: keep the newest decisions only. */
const MAX_DECISIONS = 500
/**
 * What was checked and named, by tree hash, so each is named once: skills,
 * and plugins found on at the start of a session; `rejected <hash>` for a
 * plugin on although you rejected its files. The key keeps its first name,
 * so what was named before is not named again.
 */
const CHECKED = 'skills-checked'
const MAX_CHECKED = 300
/** How serious each verdict is, to tell whether an approval still covers it. */
const SEVERITY: Record<GuardVerdict['kind'], number> = { safe: 0, caution: 1, unverified: 2, reject: 3 }

export async function loadDecisions($: EngineInterface): Promise<Decision[]> {
  const stored = await $.store.get(DECISIONS)
  return Array.isArray(stored) ? (stored as Decision[]) : []
}

/** One decision per version: the same files at the same commit (or as a folder). */
function sameVersion(a: { treeHash: string; sha?: string }, b: { treeHash: string; sha?: string }): boolean {
  return a.treeHash === b.treeHash && (a.sha ?? '') === (b.sha ?? '')
}

/**
 * Keeps a decision, newest first. Over the limit, the oldest approval goes
 * first: one forgotten is asked about again, while a rejection forgotten
 * would let through what you turned away (a server whose tools are refused).
 * The decision just made always stays.
 */
export async function recordDecision($: EngineInterface, decision: Decision): Promise<void> {
  const kept = [decision, ...(await loadDecisions($)).filter(item => !sameVersion(item, decision))]
  while (kept.length > MAX_DECISIONS) {
    let oldest = kept.length - 1
    while (oldest > 0 && kept[oldest]?.decision !== 'approved') oldest -= 1
    kept.splice(oldest === 0 ? kept.length - 1 : oldest, 1)
  }
  await $.store.set(DECISIONS, kept)
}

/**
 * Removes the decisions about `name`: its target as typed, its folder, or the
 * last part of either; `landed` is where the name, as a path, really is. A
 * name inside another (tool in my-tool-2) does not count.
 */
export async function forgetDecisions($: EngineInterface, name: string, landed?: string): Promise<Decision[]> {
  const all = await loadDecisions($)
  const last = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? path
  // Stored paths are display-safe; compare the name both as typed and made
  // safe, without trailing slashes.
  const wanted = new Set([name, safeLine(name), ...(landed === undefined ? [] : [landed, safeLine(landed)])].map(value => value.replace(/\/+$/, '')))
  const matches = (item: Decision): boolean =>
    [item.target, item.root ?? '', last(item.target), last(item.root ?? '')].some(candidate => candidate !== '' && wanted.has(candidate.replace(/\/+$/, '')))
  const kept = all.filter(item => !matches(item))
  await $.store.set(DECISIONS, kept)
  // The last report must not keep claiming a decision that is gone.
  const forgotten = all.filter(matches)
  const view = await loadLastView($)
  if (view?.decision !== undefined && forgotten.some(item => item.treeHash === view.treeHash)) {
    await saveLastView($, { ...view, decision: undefined, confirming: false })
  }
  return forgotten
}

/**
 * The decision that still holds for this tree at this verdict. A rejection
 * always holds. An approval holds only while the verdict is no worse than the
 * one it was given on: the same files can judge worse in another place (a
 * copy whose absolute link now leaves the folder), and that needs a new look.
 */
export async function decisionFor($: EngineInterface, version: { treeHash: string; sha?: string }, kind: GuardVerdict['kind']): Promise<Decision | undefined> {
  // A decision is about one version: another commit with the same files, or
  // the same files as a local folder, is judged on its own.
  const found = (await loadDecisions($)).find(item => sameVersion(item, version))
  if (found === undefined || found.decision === 'rejected') return found
  const approvedUpTo = SEVERITY[found.verdictKind] as number | undefined
  return approvedUpTo !== undefined && SEVERITY[kind] <= approvedUpTo ? found : undefined
}

/**
 * The decision on one commit of one source, found before any scan: a commit
 * names its files exactly, so the same commit of the same folder is the same
 * version however it is asked for.
 */
export async function pinnedDecision($: EngineInterface, pin: { root: string; sha: string }): Promise<Decision | undefined> {
  return (await loadDecisions($)).find(item => item.sha === pin.sha && item.root === pin.root)
}

async function loadChecked($: EngineInterface): Promise<string[]> {
  const stored = await $.store.get(CHECKED)
  return Array.isArray(stored) ? (stored as unknown[]).filter((item): item is string => typeof item === 'string') : []
}

/**
 * Remembers that the files with this tree hash were checked and named, and
 * says whether it is the first time. A skill Claude wrote with no red flags
 * was named as it was written, so its first use names it no more.
 */
export async function noteChecked($: EngineInterface, treeHash: string): Promise<boolean> {
  const checked = await loadChecked($)
  if (checked.includes(treeHash)) return false
  await $.store.set(CHECKED, [treeHash, ...checked].slice(0, MAX_CHECKED))
  return true
}

/** Whether the files with this tree hash were checked and named before. */
export async function wasChecked($: EngineInterface, treeHash: string): Promise<boolean> {
  return (await loadChecked($)).includes(treeHash)
}

/**
 * Stores the text report of one scan, held well inside the store's limit. A
 * failed write leaves no report, never another scan's.
 */
export async function saveReport($: EngineInterface, scanId: string, text: string): Promise<void> {
  // A newer scan's report is never replaced by an older one's.
  const stored = await $.store.get(REPORT_TEXT).catch(() => undefined)
  const storedId = stored !== null && typeof stored === 'object' ? (stored as { scanId?: unknown }).scanId : undefined
  if (typeof storedId === 'string' && storedId > scanId) return
  const kept = text.length > MAX_REPORT_CHARS ? `${text.slice(0, MAX_REPORT_CHARS)}\n… the report was cut here to fit the store` : text
  await $.store.set(REPORT_TEXT, { scanId, text: kept }).catch(() => $.store.delete(REPORT_TEXT).catch(() => undefined))
}

/** The text report of the scan `scanId` names, if it is still the one stored. */
export async function loadReport($: EngineInterface, scanId: string | undefined): Promise<string | undefined> {
  const stored = await $.store.get(REPORT_TEXT)
  if (stored === null || typeof stored !== 'object') return undefined
  const { scanId: storedId, text } = stored as { scanId?: unknown; text?: unknown }
  return storedId === scanId && typeof text === 'string' ? text : undefined
}

/**
 * Saves the view /guard report reopens. When it cannot be saved, the old one
 * is removed, so a reopened report never shows an older verdict as current.
 */
export async function saveLastView($: EngineInterface, view: GuardView): Promise<void> {
  try {
    await $.store.set(LAST_VIEW, view)
  } catch (error) {
    await $.store.delete(LAST_VIEW).catch(() => undefined)
    throw error
  }
}

export async function loadLastView($: EngineInterface): Promise<GuardView | undefined> {
  const stored = await $.store.get(LAST_VIEW)
  return stored !== null && typeof stored === 'object' ? (stored as GuardView) : undefined
}

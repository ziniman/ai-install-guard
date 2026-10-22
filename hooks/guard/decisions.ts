import type { EngineInterface } from 'claude-code'

import type { GuardVerdict, GuardView } from '../../types'
import { safeLine } from '../scan/safe-text'

/** One decision, remembered across sessions so the same tree is never judged twice. */
export type Decision = {
  target: string
  root?: string
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
const LAST_VIEW = 'last-view'
/** The store is capped at 4 MiB in all: keep the newest decisions only. */
const MAX_DECISIONS = 500
/** How serious each verdict is, to tell whether an approval still covers it. */
const SEVERITY: Record<GuardVerdict['kind'], number> = { safe: 0, caution: 1, unverified: 2, reject: 3 }

export async function loadDecisions($: EngineInterface): Promise<Decision[]> {
  const stored = await $.store.get(DECISIONS)
  return Array.isArray(stored) ? (stored as Decision[]) : []
}

export async function recordDecision($: EngineInterface, decision: Decision): Promise<void> {
  const others = (await loadDecisions($)).filter(item => item.treeHash !== decision.treeHash)
  await $.store.set(DECISIONS, [decision, ...others].slice(0, MAX_DECISIONS))
}

/**
 * Removes the decisions about `name`: its target as typed, its folder, or the
 * last part of either. A name inside another (tool in my-tool-2) does not count.
 */
export async function forgetDecisions($: EngineInterface, name: string): Promise<Decision[]> {
  const all = await loadDecisions($)
  const last = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? path
  // Stored paths are display-safe; compare the name both as typed and made
  // safe, without trailing slashes.
  const wanted = new Set([name, safeLine(name)].map(value => value.replace(/\/+$/, '')))
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
export async function decisionFor($: EngineInterface, treeHash: string, kind: GuardVerdict['kind']): Promise<Decision | undefined> {
  const found = (await loadDecisions($)).find(item => item.treeHash === treeHash)
  if (found === undefined || found.decision === 'rejected') return found
  const approvedUpTo = SEVERITY[found.verdictKind] as number | undefined
  return approvedUpTo !== undefined && SEVERITY[kind] <= approvedUpTo ? found : undefined
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

import type { EngineInterface } from 'claude-code'

import type { GuardView } from '../../types'

/** One decision, remembered across sessions so the same tree is never judged twice. */
export type Decision = {
  target: string
  root?: string
  treeHash: string
  verdict: string
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
export async function forgetDecisions($: EngineInterface, name: string): Promise<number> {
  const all = await loadDecisions($)
  const last = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? path
  const matches = (item: Decision): boolean =>
    [item.target, item.root ?? '', last(item.target), last(item.root ?? '')].some(candidate => candidate !== '' && candidate === name)
  const kept = all.filter(item => !matches(item))
  await $.store.set(DECISIONS, kept)
  return all.length - kept.length
}

export async function decisionFor($: EngineInterface, treeHash: string): Promise<Decision | undefined> {
  return (await loadDecisions($)).find(item => item.treeHash === treeHash)
}

export async function saveLastView($: EngineInterface, view: GuardView): Promise<void> {
  await $.store.set(LAST_VIEW, view)
}

export async function loadLastView($: EngineInterface): Promise<GuardView | undefined> {
  const stored = await $.store.get(LAST_VIEW)
  return stored !== null && typeof stored === 'object' ? (stored as GuardView) : undefined
}

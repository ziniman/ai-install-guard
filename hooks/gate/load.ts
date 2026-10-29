// The load gate: a mod Claude Code is about to load joins only when its
// folder holds exactly files the person approved, through an install the
// guard held or in the pane. Anything else is kept out and shown in the pane,
// and loads once it is approved and the plugins are reloaded.

import type { EngineInterface, PluginRegisterInput } from 'claude-code'

import type { GuardRequest } from '../../types'
import { loadDecisions, type Decision } from '../guard/decisions'
import { showScan, showUnverified } from '../guard/run'
import { modHost } from '../mod-host'
import { takeInventory } from '../scan/inventory'
import { safeLine } from '../scan/safe-text'

/** A mod kept from loading in this session. */
export type HeldMod = {
  /** `<name>@<marketplace>`, as the loader keys it: what its decisions are kept under. */
  label: string
  root: string
  /** The tree hash of its folder as it was about to load; absent when it could not be read. */
  treeHash?: string
  /** Why it was kept out, in the guard's own words. */
  why: string
  /** You rejected these files: it is named, never opened in the pane again. */
  rejected?: true
}

export type LoadJudgement = { kind: 'allow' } | { kind: 'refuse'; reason: string; held?: HeldMod }

/**
 * Whether the mod `e` names may load. Only what a person installs is judged:
 * an administrator's managed plugins and the ones bundled in Claude Code
 * load as they are. The folder is hashed and compared with every decision
 * kept, newest first: the same files approved anywhere load without a scan.
 */
export async function judgeLoad($: EngineInterface, e: PluginRegisterInput): Promise<LoadJudgement> {
  if (e.tier !== 'user') return { kind: 'allow' }
  const label = safeLine(e.provenance)
  const tree = await takeInventory(modHost($), e.root).then(
    scanned => ({ treeHash: scanned.inventory.treeHash }),
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
  )
  if ('error' in tree) {
    const why = `its folder could not be read (${safeLine(tree.error)})`
    return { kind: 'refuse', reason: keptOut(label, why), held: { label, root: e.root, why } }
  }
  const decisions = await loadDecisions($)
  const decided = decisions.find(item => item.treeHash === tree.treeHash)
  if (decided?.decision === 'approved') return { kind: 'allow' }
  if (decided?.decision === 'rejected') {
    const why = `you rejected these files on ${day(decided.decidedAt)}`
    return { kind: 'refuse', reason: `AI Install Guard kept ${label} from loading: ${why}. ${forgetHint(decided)}.`, held: { label, root: e.root, treeHash: tree.treeHash, why, rejected: true } }
  }
  const earlier = decisions.find(item => item.decision === 'approved' && sameMod(item, e))
  const why = earlier === undefined ? 'you have not approved these files' : `its files changed since you approved it on ${day(earlier.decidedAt)}`
  return { kind: 'refuse', reason: keptOut(label, why), held: { label, root: e.root, treeHash: tree.treeHash, why } }
}

/** A decision about this same mod, by the names an install or a review keeps it under. */
function sameMod(decision: Decision, e: PluginRegisterInput): boolean {
  return [e.provenance, safeLine(e.provenance), e.root].includes(decision.target) || decision.root === e.root
}

/**
 * How to judge rejected files again. The rejection is found by its files, so
 * it may be kept under another name (the plugin as first installed, its
 * repository): forget names it as it is kept.
 */
function forgetHint(decision: Decision): string {
  return `/guard forget ${safeLine(decision.target)} judges them again`
}

function keptOut(label: string, why: string): string {
  return `AI Install Guard kept ${label} from loading: ${why}. Review it in the guard's pane (/guard held), approve it, then run /reload-plugins.`
}

/** Adds a held mod to the session's list, replacing an earlier entry for the same folder. */
export function remember(held: HeldMod[], mod: HeldMod): void {
  const at = held.findIndex(item => item.root === mod.root)
  if (at === -1) held.push(mod)
  else held[at] = mod
}

/** Takes a mod that has loaded since off the session's list. */
export function release(held: HeldMod[], root: string): void {
  const at = held.findIndex(item => item.root === root)
  if (at !== -1) held.splice(at, 1)
}

/** Shows one held mod in the pane: its folder scanned, with Approve and Reject; Could not verify when it could not be read. */
export async function reviewHeld($: EngineInterface, mod: HeldMod, lookups: boolean): Promise<void> {
  const request: GuardRequest = { origin: 'command', args: '', label: mod.label, subject: 'load', display: `Kept from loading until you decide: ${mod.label}` }
  const options = { action: 'approve' as const, request, lookups }
  if (mod.treeHash === undefined) {
    await showUnverified($, mod.label, mod.why, options)
    return
  }
  await showScan($, mod.label, { folder: mod.root }, options)
}

/**
 * What `/guard held` answers: each mod kept out in this session and where it
 * stands, and the first one still undecided opened in the pane. A mod
 * approved since loads after /reload-plugins; one rejected stays out.
 */
export async function heldReport($: EngineInterface, held: readonly HeldMod[], lookups: boolean): Promise<string> {
  if (held.length === 0) return 'AI Install Guard: no mod was kept from loading in this session.'
  const decisions = await loadDecisions($)
  const decisionOf = (mod: HeldMod): Decision | undefined => (mod.treeHash === undefined ? undefined : decisions.find(item => item.treeHash === mod.treeHash))
  const lines = held.map(mod => {
    const decided = decisionOf(mod)
    if (decided === undefined) return `  ${mod.label}: ${mod.why}`
    if (decided.decision === 'approved') return `  ${mod.label}: approved; run /reload-plugins to load it`
    return `  ${mod.label}: you rejected these files on ${day(decided.decidedAt)}; ${forgetHint(decided)}`
  })
  const next = held.find(mod => decisionOf(mod) === undefined)
  if (next === undefined) return `AI Install Guard kept ${count(held.length)} from loading in this session, and each is decided:\n${lines.join('\n')}`
  await reviewHeld($, next, lookups)
  return `AI Install Guard kept ${count(held.length)} from loading in this session:\n${lines.join('\n')}\n\n${next.label} is in the guard's pane. Approve it there, then run /reload-plugins to load it. Run /guard held again for the next one.`
}

/** The toast at the start of a session that kept mods out: each named, and what to do about those still undecided. */
export function heldToast(held: readonly HeldMod[]): string {
  const names = held.map(mod => mod.label).join(', ')
  const after = held.some(mod => mod.rejected !== true)
    ? 'The pane shows the first to review: approve it, then run /reload-plugins. /guard held lists them all.'
    : `You rejected ${held.length === 1 ? 'its' : 'their'} files; /guard held lists ${held.length === 1 ? 'it' : 'them'}.`
  return `AI Install Guard kept ${count(held.length)} from loading: ${names}. ${after}`
}

/** The first held mod the pane should open: one you have not rejected. */
export function toReview(held: readonly HeldMod[]): HeldMod | undefined {
  return held.find(mod => mod.rejected !== true)
}

/**
 * A mod kept out because the guard itself failed while checking it: named in
 * the refusal with what failed, and held as Could not verify.
 */
export function failedLoad(e: PluginRegisterInput, failure: { kind: string; message?: string }): HeldMod & { reason: string } {
  const label = safeLine(e.provenance)
  const what = failure.kind === 'timeout' ? 'it ran out of time' : safeLine(failure.message ?? 'an error')
  const why = `the guard failed while checking it (${what})`
  return { label, root: e.root, why, reason: `AI Install Guard kept ${label} from loading: ${why}.` }
}

function count(n: number): string {
  return n === 1 ? '1 mod' : `${n} mods`
}

function day(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

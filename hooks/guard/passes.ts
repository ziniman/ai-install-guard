// Installs the person allowed once although nothing could be pinned: Could
// not verify, then Install anyway, confirmed. Each pass lets that exact
// command through one time in this session and is then used up.

import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { GuardPass } from '../../types'

const passesAtom = atom({ plugin: 'ai-install-guard', key: 'passes' } as const, [] as GuardPass[])

/** Passes kept at once; an old one unused falls off. */
const MAX_PASSES = 20

function samePass(a: GuardPass, b: GuardPass): boolean {
  return a.origin === b.origin && a.args === b.args
}

export async function grantPass($: EngineInterface, pass: GuardPass): Promise<void> {
  await update($, passesAtom, current => [...current.filter(item => !samePass(item, pass)), pass].slice(-MAX_PASSES))
}

/**
 * Uses up the pass for this command, if there is one. Finding and removing it
 * is one write, so two commands at once cannot both use the same pass.
 */
export async function takePass($: EngineInterface, pass: GuardPass): Promise<boolean> {
  let taken = false
  await update($, passesAtom, latest => {
    taken = latest.some(item => samePass(item, pass))
    return taken ? latest.filter(item => !samePass(item, pass)) : latest
  })
  return taken
}

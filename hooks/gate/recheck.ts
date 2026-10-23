// The last look before a held install runs: the version it would install now
// must still be the one the person approved. A plugin's own `$.command.run`
// does not pass through its own gate, so Install asks this itself.

import type { GuardView } from '../../types'
import { sourceRoot } from '../guard/view'
import type { Host } from '../scan/host'
import { takeInventory } from '../scan/inventory'
import { resolvePin } from '../scan/remote'
import { readPluginArgs } from './requests'
import { targetOf } from './resolve'

/**
 * Undefined when the held install would still install what was scanned;
 * otherwise why not. Something nothing could pin (Could not verify) has no
 * version to compare, and the person allowed it as it is.
 */
export async function changedSinceScan(host: Host, view: GuardView): Promise<string | undefined> {
  if (view.treeHash === undefined || view.request === undefined) return undefined
  const reading = readPluginArgs(view.request.args)
  if (reading.kind !== 'install') return 'the install no longer reads as one the guard can check'
  const target = await targetOf(host, reading.request)
  if (target.kind === 'remote') {
    const pin = await resolvePin(host, target.spec)
    if (view.sha !== pin.sha || view.root !== sourceRoot(target.spec.url, pin.subdir)) return `it now points at commit ${pin.sha.slice(0, 12)}, not the one scanned`
    return undefined
  }
  if (target.kind === 'local') {
    const { inventory } = await takeInventory(host, target.path)
    return inventory.treeHash === view.treeHash ? undefined : 'its files changed since the scan'
  }
  return target.kind === 'unverifiable' ? target.reason : 'it no longer names one plugin'
}

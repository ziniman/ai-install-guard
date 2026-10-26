import type { InventoryEntry } from './inventory'

const encoder = new TextEncoder()

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * One record per entry, sorted by path, each ended by a NUL byte (which no
 * path can hold, so two different trees never share a record list), then
 * hashed:
 *
 *   file <sha256 of its bytes> <path>
 *   link <sha256 of the target as stored in the link> <path>
 *   dir - <path>
 *   other - <path>
 *
 * A link counts by its stored target, not where it lands on this machine, so
 * the same tree hashes the same everywhere. Changing this format changes every
 * stored approval.
 *
 * `replaced` counts some files by another hash: the README badge hash counts
 * the README without its badge. An approval never passes it.
 */
export async function treeHash(entries: readonly InventoryEntry[], replaced?: ReadonlyMap<string, string>): Promise<string> {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  let records = ''
  for (const entry of sorted) {
    if (entry.kind === 'file') {
      records += `file ${replaced?.get(entry.path) ?? entry.sha256} ${entry.path}\0`
    } else if (entry.kind === 'link') {
      records += `link ${await sha256Hex(entry.target)} ${entry.path}\0`
    } else {
      records += `${entry.kind} - ${entry.path}\0`
    }
  }
  return `sha256:${await sha256Hex(records)}`
}

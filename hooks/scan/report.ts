import { formatBytes, type Inventory } from './inventory'
import { safeLine } from './safe-text'

const MAX_LISTED = 60

/** The plain-text report `/guard scan` prints. */
export function formatInventory(target: string, inventory: Inventory): string {
  const files = inventory.entries.filter(entry => entry.kind === 'file')
  const links = inventory.entries.filter(entry => entry.kind === 'link')
  const others = inventory.entries.filter(entry => entry.kind === 'other')
  const listed = inventory.entries.filter(entry => entry.kind !== 'dir')

  const lines = [
    `AI Install Guard: ${safeLine(target)}`,
    `Folder: ${safeLine(inventory.root)}`,
    `Files: ${files.length} (${formatBytes(inventory.totalBytes)}), links: ${links.length}, other: ${others.length}`,
    `Tree hash: ${inventory.treeHash}`,
  ]
  if (inventory.skipped.length > 0) {
    lines.push(`Not read: ${inventory.skipped.map(safeLine).join(', ')}`)
  }
  lines.push('')

  for (const entry of listed.slice(0, MAX_LISTED)) {
    const path = safeLine(entry.path)
    if (entry.kind === 'file') {
      lines.push(`  ${path}  ${formatBytes(entry.size)}${entry.isText ? '' : ', binary'}`)
    } else if (entry.kind === 'link') {
      const where = entry.landsAt === undefined ? 'leads nowhere' : entry.isInside ? '' : 'outside the folder'
      lines.push(`  ${path}  link to ${safeLine(entry.target)}${where === '' ? '' : ` (${where})`}`)
    } else {
      lines.push(`  ${path}  not a regular file`)
    }
  }
  if (listed.length > MAX_LISTED) {
    lines.push(`  ... and ${listed.length - MAX_LISTED} more`)
  }

  lines.push('', 'No checks run yet: this build lists and hashes the files only.')
  return lines.join('\n')
}

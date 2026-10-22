import type { InventoryEntry } from './inventory'

const encoder = new TextEncoder()

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * One line per entry, sorted by path, hashed. A file is `file <sha256> <path>`,
 * a link `link <sha256 of where it points> <path>`, anything else
 * `other - <path>`. The hash leads so a path can hold any character; a path
 * with a line break is JSON-escaped so it stays one line.
 */
export async function treeHash(entries: readonly InventoryEntry[]): Promise<string> {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const lines: string[] = []
  for (const entry of sorted) {
    const path = /[\n\r]/.test(entry.path) ? JSON.stringify(entry.path) : entry.path
    if (entry.kind === 'file') {
      lines.push(`file ${entry.sha256} ${path}`)
    } else if (entry.kind === 'link') {
      lines.push(`link ${await sha256Hex(entry.target)} ${path}`)
    } else {
      lines.push(`other - ${path}`)
    }
  }
  return `sha256:${await sha256Hex(lines.join('\n'))}`
}

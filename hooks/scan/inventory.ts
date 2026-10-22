import { sha256Hex, treeHash } from './hash'
import type { Host } from './host'

/** Past these the scan stops and the verdict is "Could not verify". */
export const LIMITS = {
  maxEntries: 5000,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
}

const READ_CONCURRENCY = 8
const TEXT_SNIFF_BYTES = 8000

export type InventoryFile = {
  kind: 'file'
  path: string
  size: number
  sha256: string
  isText: boolean
}

export type InventoryLink = {
  kind: 'link'
  path: string
  /** Relative to the root when the link lands inside it, else where it lands, or `(nowhere)`. */
  target: string
  isInside: boolean
}

export type InventoryOther = {
  kind: 'other'
  path: string
}

export type InventoryEntry = InventoryFile | InventoryLink | InventoryOther

export type Inventory = {
  /** The scanned folder, every link resolved. */
  root: string
  /** Sorted by path. */
  entries: InventoryEntry[]
  totalBytes: number
  treeHash: string
  /** Folders left out on purpose (the root's `.git`). */
  skipped: string[]
}

export type ScannedTree = {
  inventory: Inventory
  /** Each file's bytes by path, for the checks. Never stored. */
  contents: Map<string, Uint8Array>
}

export class ScanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScanError'
  }
}

/**
 * Lists every entry under `path` and reads and hashes every regular file.
 * A symbolic link is recorded with where it lands and never followed, so a
 * link to `~/.ssh` is reported, not read.
 */
export async function takeInventory(host: Host, path: string): Promise<ScannedTree> {
  const rootStat = await host.stat(path, { resolve: true }).catch(() => undefined)
  if (rootStat === undefined) {
    throw new ScanError(`${path} does not exist`)
  }
  if (rootStat.kind !== 'dir' || rootStat.isLink) {
    throw new ScanError(`${path} is not a folder`)
  }
  const root = normalize(rootStat.realPath ?? path)

  const entries: InventoryEntry[] = []
  const files: { path: string; size: number }[] = []
  const skipped: string[] = []
  const queue: string[] = ['']

  while (queue.length > 0) {
    const dir = queue.shift() as string
    const listed = await host.list(dir === '' ? root : `${root}/${dir}`)
    for (const item of listed) {
      const rel = dir === '' ? item.name : `${dir}/${item.name}`
      if (item.isLink) {
        entries.push(await describeLink(host, root, rel))
      } else if (item.kind === 'dir') {
        if (dir === '' && item.name === '.git') {
          skipped.push(rel)
        } else {
          queue.push(rel)
        }
      } else if (item.kind === 'file') {
        files.push({ path: rel, size: item.size })
      } else {
        entries.push({ kind: 'other', path: rel })
      }
      if (entries.length + files.length > LIMITS.maxEntries) {
        throw new ScanError(`more than ${LIMITS.maxEntries} files`)
      }
    }
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (totalBytes > LIMITS.maxTotalBytes) {
    throw new ScanError(`${formatBytes(totalBytes)} of files, over the ${formatBytes(LIMITS.maxTotalBytes)} limit`)
  }
  const tooLarge = files.find(file => file.size > LIMITS.maxFileBytes)
  if (tooLarge !== undefined) {
    throw new ScanError(`${tooLarge.path} is ${formatBytes(tooLarge.size)}, over the ${formatBytes(LIMITS.maxFileBytes)} per-file limit`)
  }

  const contents = new Map<string, Uint8Array>()
  const read = await mapLimit(files, READ_CONCURRENCY, async (file): Promise<InventoryFile> => {
    const bytes = await host.readBytes(`${root}/${file.path}`)
    contents.set(file.path, bytes)
    return {
      kind: 'file',
      path: file.path,
      size: bytes.length,
      sha256: await sha256Hex(bytes),
      isText: looksLikeText(bytes),
    }
  })
  entries.push(...read)
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return {
    inventory: {
      root,
      entries,
      totalBytes: read.reduce((sum, file) => sum + file.size, 0),
      treeHash: await treeHash(entries),
      skipped,
    },
    contents,
  }
}

async function describeLink(host: Host, root: string, rel: string): Promise<InventoryLink> {
  const stat = await host.stat(`${root}/${rel}`, { resolve: true }).catch(() => undefined)
  const real = stat?.realPath === undefined ? undefined : normalize(stat.realPath)
  if (real === undefined) {
    return { kind: 'link', path: rel, target: '(nowhere)', isInside: false }
  }
  if (real === root || real.startsWith(`${root}/`)) {
    return { kind: 'link', path: rel, target: real.slice(root.length + 1) || '.', isInside: true }
  }
  return { kind: 'link', path: rel, target: real, isInside: false }
}

function normalize(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed
}

function looksLikeText(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, TEXT_SNIFF_BYTES)
  for (let i = 0; i < end; i += 1) {
    if (bytes[i] === 0) return false
  }
  return true
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

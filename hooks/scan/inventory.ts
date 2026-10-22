import { sha256Hex, treeHash } from './hash'
import type { Host } from './host'

/** Past these the scan stops and the verdict is "Could not verify". */
export const LIMITS = {
  maxEntries: 5000,
  /** Each link costs a `readlink` process, so links have a lower ceiling. */
  maxLinks: 500,
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
  /** The target as stored in the link (what `readlink` prints). */
  target: string
  /**
   * Where it lands: relative to the root when inside it, absolute when
   * outside, absent when it leads nowhere.
   */
  landsAt?: string
  isInside: boolean
}

export type InventoryDir = {
  kind: 'dir'
  path: string
}

export type InventoryOther = {
  kind: 'other'
  path: string
}

export type InventoryEntry = InventoryFile | InventoryLink | InventoryDir | InventoryOther

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
 * A symbolic link is recorded with its target and where it lands, and never
 * followed, so a link to `~/.ssh` is reported, not read.
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
  const links: string[] = []
  const skipped: string[] = []
  const queue: string[] = ['']

  while (queue.length > 0) {
    const dir = queue.shift() as string
    const listed = await host.list(dir === '' ? root : `${root}/${dir}`)
    for (const item of listed) {
      const rel = dir === '' ? item.name : `${dir}/${item.name}`
      if (item.isLink) {
        links.push(rel)
      } else if (item.kind === 'dir') {
        if (dir === '' && item.name === '.git') {
          skipped.push(rel)
        } else {
          entries.push({ kind: 'dir', path: rel })
          queue.push(rel)
        }
      } else if (item.kind === 'file') {
        files.push({ path: rel, size: item.size })
      } else {
        entries.push({ kind: 'other', path: rel })
      }
      if (entries.length + files.length + links.length > LIMITS.maxEntries) {
        throw new ScanError(`more than ${LIMITS.maxEntries} files and folders`)
      }
    }
  }

  if (links.length > LIMITS.maxLinks) {
    throw new ScanError(`more than ${LIMITS.maxLinks} symbolic links`)
  }
  checkSizes(files)
  entries.push(...(await mapLimit(links, READ_CONCURRENCY, rel => describeLink(host, root, rel))))

  const contents = new Map<string, Uint8Array>()
  let readBytes = 0
  const read = await mapLimit(files, READ_CONCURRENCY, async (file): Promise<InventoryFile> => {
    const full = `${root}/${file.path}`
    await assertPlainFile(host, full, file.path)
    const bytes = await host.readBytes(full)
    readBytes += bytes.length
    checkSizes([{ path: file.path, size: bytes.length }], readBytes)
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
      totalBytes: readBytes,
      treeHash: await treeHash(entries),
      skipped,
    },
    contents,
  }
}

/** Throws when a file, or all of them together, is over its limit. */
function checkSizes(files: readonly { path: string; size: number }[], total?: number): void {
  const tooLarge = files.find(file => file.size > LIMITS.maxFileBytes)
  if (tooLarge !== undefined) {
    throw new ScanError(`${tooLarge.path} is ${formatBytes(tooLarge.size)}, over the ${formatBytes(LIMITS.maxFileBytes)} per-file limit`)
  }
  const sum = total ?? files.reduce((acc, file) => acc + file.size, 0)
  if (sum > LIMITS.maxTotalBytes) {
    throw new ScanError(`${formatBytes(sum)} of files, over the ${formatBytes(LIMITS.maxTotalBytes)} limit`)
  }
}

/**
 * Refuses to read a path that is no longer the plain file the listing saw:
 * swapped for a link, or reached through one, it would be read where it lands.
 */
async function assertPlainFile(host: Host, full: string, rel: string): Promise<void> {
  const stat = await host.stat(full, { resolve: true }).catch(() => undefined)
  const real = stat?.realPath === undefined ? undefined : normalize(stat.realPath)
  if (stat === undefined || stat.isLink || stat.kind !== 'file' || real !== normalize(full)) {
    throw new ScanError(`${rel} changed while it was being scanned`)
  }
}

async function describeLink(host: Host, root: string, rel: string): Promise<InventoryLink> {
  const full = `${root}/${rel}`
  const target = await host.readLink(full).catch(() => {
    throw new ScanError(`could not read where the link ${rel} points`)
  })
  const stat = await host.stat(full, { resolve: true }).catch(() => undefined)
  const real = stat?.realPath === undefined ? undefined : normalize(stat.realPath)
  if (real === undefined) {
    return { kind: 'link', path: rel, target, isInside: false }
  }
  if (real === root || real.startsWith(`${root}/`)) {
    return { kind: 'link', path: rel, target, landsAt: real.slice(root.length + 1) || '.', isInside: true }
  }
  return { kind: 'link', path: rel, target, landsAt: real, isInside: false }
}

/**
 * Drops trailing slashes. Backslashes become slashes only in a Windows path
 * (`C:\...` or `\\server\...`): elsewhere a backslash is part of a name.
 */
function normalize(path: string): string {
  const isWindows = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
  const slashed = isWindows ? path.replace(/\\/g, '/') : path
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

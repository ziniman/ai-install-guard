// Unpacks a zip archive into a new, empty folder so the scanner can read it,
// running nothing from it. Only plain files, folders and symbolic links come
// out; links are made last and never written through, every path stays inside
// the folder, and the scanner's size and count limits hold before a byte is
// inflated. Anything the reader does not understand stops the unpack, so the
// scan says "Could not verify" rather than judge part of an archive.

import { promises as fs } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

import { LIMITS, formatBytes } from '../hooks/scan/inventory'
import { safeLine } from '../hooks/scan/safe-text'

/** The most an archive may weigh: no more than the files it may hold. */
export const MAX_ZIP_BYTES = LIMITS.maxTotalBytes

/** The most a link's stored target may hold. */
const MAX_LINK_BYTES = 4096

const EOCD = 0x06054b50
const EOCD64 = 0x06064b50
const EOCD64_LOCATOR = 0x07064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/** Unix file types, from the high half of an entry's external attributes. */
const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

/** Hosts whose external attributes carry a Unix mode: Unix and macOS. */
const UNIX_HOSTS = new Set([3, 19])

export type ZipEntry = {
  path: string
  kind: 'file' | 'dir' | 'link'
  method: number
  crc32: number
  compressedSize: number
  size: number
  localOffset: number
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

/** Whether these bytes start like a zip archive (an empty one included). */
export function looksLikeZip(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6))
}

/** Every entry the archive's central directory lists, checked and in order. */
export function readEntries(zip: Buffer): ZipEntry[] {
  const end = findEnd(zip)
  const entries: ZipEntry[] = []
  const seen = new Map<string, ZipEntry['kind']>()
  let at = end.offset
  for (let index = 0; index < end.count; index += 1) {
    need(zip, at, 46)
    if (zip.readUInt32LE(at) !== CENTRAL) throw new ZipError('the archive is damaged: a directory record is missing')
    const madeBy = zip.readUInt16LE(at + 4) >> 8
    const flags = zip.readUInt16LE(at + 8)
    const method = zip.readUInt16LE(at + 10)
    const crc32 = zip.readUInt32LE(at + 16)
    let compressedSize = zip.readUInt32LE(at + 20)
    let size = zip.readUInt32LE(at + 24)
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    const disk = zip.readUInt16LE(at + 34)
    const attributes = zip.readUInt32LE(at + 38)
    let localOffset = zip.readUInt32LE(at + 42)
    need(zip, at + 46, nameLength + extraLength + commentLength)
    const rawName = zip.subarray(at + 46, at + 46 + nameLength)
    const extra = zip.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength)
    at += 46 + nameLength + extraLength + commentLength

    // Sizes too large for 32 bits live in the Zip64 extra field, in this order.
    const wide = zip64Fields(extra)
    if (size === 0xffffffff) size = wide.shift() ?? fail('the archive is damaged: a Zip64 size is missing')
    if (compressedSize === 0xffffffff) compressedSize = wide.shift() ?? fail('the archive is damaged: a Zip64 size is missing')
    if (localOffset === 0xffffffff) localOffset = wide.shift() ?? fail('the archive is damaged: a Zip64 offset is missing')

    const name = nameOf(rawName)
    const shown = safeLine(name)
    if (disk !== 0 && disk !== 0xffff) throw new ZipError('archives split across several files are not read')
    if ((flags & 0x1) !== 0) throw new ZipError(`${shown} is encrypted, so it cannot be read`)
    const mode = UNIX_HOSTS.has(madeBy) ? attributes >>> 16 : 0
    const type = mode & S_IFMT
    const kind: ZipEntry['kind'] = type === S_IFLNK ? 'link' : type === S_IFDIR || name.endsWith('/') ? 'dir' : type === 0 || type === S_IFREG ? 'file' : fail(`${shown} is a special file (a device or a pipe), not a file or folder`)
    if (kind !== 'dir' && method !== 0 && method !== 8) throw new ZipError(`${shown} is compressed with method ${method}; only stored and deflated files are read`)
    const path = safePath(name)
    if (kind === 'link' && size > MAX_LINK_BYTES) throw new ZipError(`${shown} is a link whose target is ${formatBytes(size)} long`)
    if (kind === 'file' && size > LIMITS.maxFileBytes) {
      throw new ZipError(`${shown} is ${formatBytes(size)}, over the ${formatBytes(LIMITS.maxFileBytes)} per-file limit`)
    }

    // A path is one thing: never a file and a folder, never listed twice, and
    // never a folder beneath a file or a link.
    const before = seen.get(path)
    if (before !== undefined && !(before === 'dir' && kind === 'dir')) throw new ZipError(`${shown} is listed more than once`)
    seen.set(path, kind)
    entries.push({ path, kind, method, crc32, compressedSize, size, localOffset })
    if (entries.length > LIMITS.maxEntries) throw new ZipError(`more than ${LIMITS.maxEntries} files and folders`)
  }
  for (const entry of entries) {
    const parts = entry.path.split('/')
    for (let depth = 1; depth < parts.length; depth += 1) {
      const parent = parts.slice(0, depth).join('/')
      const kind = seen.get(parent)
      if (kind !== undefined && kind !== 'dir') throw new ZipError(`${safeLine(entry.path)} sits beneath ${safeLine(parent)}, which is a ${kind}`)
    }
  }
  const declared = entries.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0)
  if (declared > LIMITS.maxTotalBytes) throw new ZipError(`${formatBytes(declared)} of files, over the ${formatBytes(LIMITS.maxTotalBytes)} limit`)
  if (entries.filter(entry => entry.kind === 'link').length > LIMITS.maxLinks) throw new ZipError(`more than ${LIMITS.maxLinks} symbolic links`)
  return entries
}

/**
 * Unpacks `zip` into `dest`, a folder the caller has just made empty:
 * folders, then files (each created new, never opened if something is
 * there), then links, so no file is ever written through a link.
 */
export async function extractZip(zip: Buffer, dest: string): Promise<void> {
  const entries = readEntries(zip)
  const dirs = new Set<string>()
  for (const entry of entries) {
    const parts = entry.path.split('/')
    for (let depth = 1; depth < parts.length; depth += 1) dirs.add(parts.slice(0, depth).join('/'))
    if (entry.kind === 'dir') dirs.add(entry.path)
  }
  // Shallow first, so each folder is made inside one that already exists.
  for (const dir of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))) {
    await fs.mkdir(`${dest}/${dir}`, { mode: 0o700 })
  }
  let written = 0
  for (const entry of entries) {
    if (entry.kind !== 'file') continue
    const bytes = contentOf(zip, entry)
    written += bytes.length
    if (written > LIMITS.maxTotalBytes) throw new ZipError(`${formatBytes(written)} of files, over the ${formatBytes(LIMITS.maxTotalBytes)} limit`)
    await fs.writeFile(`${dest}/${entry.path}`, bytes, { flag: 'wx', mode: 0o600 })
  }
  for (const entry of entries) {
    if (entry.kind !== 'link') continue
    const target = contentOf(zip, entry).toString('utf8')
    if (target === '' || target.includes('\0')) throw new ZipError(`${safeLine(entry.path)} is a link with no usable target`)
    await fs.symlink(target, `${dest}/${entry.path}`)
  }
}

/** An entry's bytes, inflated within its declared size and checked against its CRC. */
function contentOf(zip: Buffer, entry: ZipEntry): Buffer {
  const at = entry.localOffset
  need(zip, at, 30)
  if (zip.readUInt32LE(at) !== LOCAL) throw new ZipError(`the archive is damaged: ${safeLine(entry.path)} has no file record`)
  const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28)
  need(zip, start, entry.compressedSize)
  const raw = zip.subarray(start, start + entry.compressedSize)
  let bytes: Buffer
  try {
    bytes = entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) })
  } catch {
    throw new ZipError(`${safeLine(entry.path)} could not be inflated, or holds more than its stated ${formatBytes(entry.size)}`)
  }
  if (bytes.length !== entry.size) throw new ZipError(`${safeLine(entry.path)} holds ${formatBytes(bytes.length)}, not the ${formatBytes(entry.size)} the archive states`)
  if (crc32(bytes) !== entry.crc32) throw new ZipError(`${safeLine(entry.path)} does not match its checksum`)
  return bytes
}

/**
 * A name as UTF-8. Older tools write names in a DOS code page instead; such a
 * name could be read two ways, so it is refused rather than guessed.
 */
function nameOf(raw: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    throw new ZipError(`the archive holds a name that is not UTF-8 ("${safeLine(raw.toString('latin1'))}"); pack it again with a current zip tool`)
  }
}

/**
 * A relative path with plain parts: no drive or leading slash, no `.` or `..`,
 * no empty part, no backslash (a separator on Windows, a name character
 * elsewhere, so it would land in different places) and no control character.
 */
function safePath(name: string): string {
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name
  const parts = trimmed.split('/')
  const bad =
    trimmed === '' ||
    /^[A-Za-z]:/.test(trimmed) ||
    /[\\\x00-\x1f\x7f]/.test(trimmed) ||
    parts.some(part => part === '' || part === '.' || part === '..')
  if (bad) throw new ZipError(`the archive holds the path "${safeLine(name)}", which could land outside the folder it is unpacked into`)
  return trimmed
}

/** The end-of-archive record: where the directory starts and how many entries it holds. */
function findEnd(zip: Buffer): { offset: number; count: number } {
  const lowest = Math.max(0, zip.length - 22 - 0xffff)
  for (let at = zip.length - 22; at >= lowest; at -= 1) {
    if (zip.readUInt32LE(at) !== EOCD) continue
    // The record's comment must run exactly to the end of the file.
    if (at + 22 + zip.readUInt16LE(at + 20) !== zip.length) continue
    if (zip.readUInt16LE(at + 4) !== 0 || zip.readUInt16LE(at + 6) !== 0) throw new ZipError('archives split across several files are not read')
    let count = zip.readUInt16LE(at + 10)
    let offset = zip.readUInt32LE(at + 16)
    if (count === 0xffff || offset === 0xffffffff) {
      const locator = at - 20
      if (locator < 0 || zip.readUInt32LE(locator) !== EOCD64_LOCATOR) throw new ZipError('the archive is damaged: its Zip64 record is missing')
      const record = Number(zip.readBigUInt64LE(locator + 8))
      need(zip, record, 56)
      if (zip.readUInt32LE(record) !== EOCD64) throw new ZipError('the archive is damaged: its Zip64 record is missing')
      count = Number(zip.readBigUInt64LE(record + 32))
      offset = Number(zip.readBigUInt64LE(record + 48))
    }
    if (count > LIMITS.maxEntries) throw new ZipError(`more than ${LIMITS.maxEntries} files and folders`)
    return { offset, count }
  }
  throw new ZipError('this is not a zip archive, or it is damaged')
}

/** The 64-bit values in a Zip64 extra field (id 1), in order. */
function zip64Fields(extra: Buffer): number[] {
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(at)
    const length = extra.readUInt16LE(at + 2)
    if (id === 1) {
      const values: number[] = []
      for (let field = at + 4; field + 8 <= at + 4 + length && field + 8 <= extra.length; field += 8) values.push(Number(extra.readBigUInt64LE(field)))
      return values
    }
    at += 4 + length
  }
  return []
}

function need(zip: Buffer, at: number, length: number): void {
  if (at < 0 || at + length > zip.length) throw new ZipError('the archive is damaged: a record runs past its end')
}

function fail(message: string): never {
  throw new ZipError(message)
}

let table: Uint32Array | undefined

/** CRC-32 as zip uses it (the IEEE polynomial). */
export function crc32(bytes: Uint8Array): number {
  if (table === undefined) {
    table = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = (table[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

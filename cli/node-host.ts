// The scanner's host outside Claude Code: node:fs reads, node:child_process
// runs git, and Node's fetch reads GitHub's public metadata. It answers as the
// mod's host does, so the same scan code gives the same verdicts here: a file
// is read only as itself, never through a symbolic link, a command runs by its
// argument vector with no shell, and only the programs the scanner needs run.

import { spawn } from 'node:child_process'
import { constants, promises as fs } from 'node:fs'

import type { FetchInit, FetchResult, Host, HostEntry, HostEntryKind, HostStat, RunOptions, RunResult } from '../hooks/scan/host'
import { LIMITS } from '../hooks/scan/inventory'

/** How much of each output stream a command keeps, as `$.process.run` does. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** How long a command may run when its caller names no limit, as `$.process.run`. */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * The programs the scanner starts: git to fetch one commit, sh to cap the
 * fetch's size, mktemp and rm for its temporary folder, and PowerShell for the
 * same on Windows. Anything else is refused, so no change to the scan code
 * can make this host run a program from the candidate.
 */
const PROGRAMS = new Set(['git', 'sh', 'mktemp', 'rm', 'powershell'])

/** How long a request may take, and how much of its answer is kept. */
const FETCH_TIMEOUT_MS = 30_000
const MAX_FETCH_TEXT_BYTES = 8 * 1024 * 1024

/** O_NOFOLLOW where the platform has it: opening a link then fails instead of reading where it lands. */
const NO_FOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

export function nodeHost(): Host {
  return { list, stat, readBytes, readLink: path => fs.readlink(path), run, fetch: request }
}

function kindOf(stats: { isFile(): boolean; isDirectory(): boolean }): HostEntryKind {
  return stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other'
}

async function list(path: string): Promise<HostEntry[]> {
  const names = (await fs.readdir(path)).sort()
  return Promise.all(
    names.map(async name => {
      const stats = await fs.lstat(`${path}/${name}`)
      const isLink = stats.isSymbolicLink()
      return { name, kind: isLink ? 'other' : kindOf(stats), size: isLink ? 0 : stats.size, isLink }
    }),
  )
}

/**
 * Without `resolve`, the path itself. With it, where the path lands, while
 * `isLink` still says whether the path itself is a link; a link that leads
 * nowhere has no `realPath`.
 */
async function stat(path: string, options?: { resolve: boolean }): Promise<HostStat> {
  const own = await fs.lstat(path)
  const isLink = own.isSymbolicLink()
  if (options?.resolve !== true) return { kind: isLink ? 'other' : kindOf(own), size: isLink ? 0 : own.size, isLink }
  try {
    const landed = await fs.stat(path)
    return { kind: kindOf(landed), size: landed.size, isLink, realPath: await fs.realpath(path) }
  } catch (error) {
    if (isLink) return { kind: 'other', size: 0, isLink }
    throw error
  }
}

/**
 * Reads a plain file and nothing else: a link in its place fails to open, and
 * the read stops one byte past the per-file limit so the inventory refuses a
 * file that grew after it was listed instead of holding all of it.
 */
async function readBytes(path: string): Promise<Uint8Array> {
  const handle = await fs.open(path, constants.O_RDONLY | NO_FOLLOW)
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error(`${path} is not a plain file`)
    const cap = LIMITS.maxFileBytes + 1
    const chunks: Buffer[] = []
    let size = 0
    while (size < cap) {
      const chunk = Buffer.alloc(Math.min(Math.max(stats.size - size, 64 * 1024), cap - size))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, size)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      size += bytesRead
    }
    const buffer = Buffer.concat(chunks)
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length)
  } finally {
    await handle.close()
  }
}

/**
 * Runs `argv` with no shell. Resolves with any exit code (a signal reads as
 * 1); rejects when the command cannot start or outlives its time.
 */
function run(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const [command, ...args] = argv
  if (command === undefined) return Promise.reject(new Error('no command to run'))
  if (!PROGRAMS.has(command)) return Promise.reject(new Error(`${command} is not one of the programs the scanner runs`))
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout = collect()
    const stderr = collect()
    child.stdout.on('data', stdout.add)
    child.stderr.on('data', stderr.add)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} did not finish within ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s`))
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.on('error', error => {
      clearTimeout(timer)
      reject(new Error(`could not start ${command}: ${error.message}`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? 1, stdout: stdout.text(), stderr: stderr.text() })
    })
  })
}

/** An output stream's first MAX_OUTPUT_BYTES; the rest is read and dropped. */
function collect(): { add: (chunk: Buffer) => void; text: () => string } {
  const chunks: Buffer[] = []
  let size = 0
  return {
    add: chunk => {
      if (size >= MAX_OUTPUT_BYTES) return
      const kept = chunk.subarray(0, MAX_OUTPUT_BYTES - size)
      chunks.push(kept)
      size += kept.length
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  }
}

/**
 * An https request, answered once its body is read. A request that cannot be
 * made rejects, as `$.http.fetch` does; the scan notes it and goes on.
 */
async function request(url: string, init: FetchInit = {}): Promise<FetchResult> {
  if (!url.startsWith('https://')) throw new Error(`only https requests are made, not ${url}`)
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.url.startsWith('https://')) {
    await response.body?.cancel()
    throw new Error(`${new URL(url).host} redirected to a plain http address`)
  }
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value
  })
  // Read as it arrives, and stopped once over the limit rather than held whole.
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body?.getReader()
  for (;;) {
    const next = await reader?.read()
    if (next === undefined || next.done) break
    size += next.value.length
    if (size > MAX_FETCH_TEXT_BYTES) {
      await reader?.cancel()
      throw new Error(`${new URL(url).host} answered with more than ${MAX_FETCH_TEXT_BYTES / 1024 / 1024} MB`)
    }
    chunks.push(next.value)
  }
  return { status: response.status, ok: response.ok, headers, text: Buffer.concat(chunks).toString('utf8') }
}

// AI Install Guard outside Claude Code: the same deterministic scan the mod
// runs, on a folder, a zip archive or one commit of a repository, printed as
// the plain-text report or as JSON. It is what the chat skill runs. Nothing
// from the candidate is installed, built or run; a zip is unpacked into a
// temporary folder of the guard's own, and that folder is removed afterwards.

import { webcrypto } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'

import { viewOf } from '../hooks/guard/view'
import type { Host } from '../hooks/scan/host'
import { formatReport, UNTRUSTED_NOTE } from '../hooks/scan/report'
import { looksRemote, parseRemote } from '../hooks/scan/remote'
import { safeLine } from '../hooks/scan/safe-text'
import { scanFolder, scanRemote, type ScanOptions, type ScanReport } from '../hooks/scan/scan'
import { decide, type VerdictKind } from '../hooks/scan/verdict'
import { nodeHost } from './node-host'
import { extractZip, looksLikeZip, MAX_ZIP_BYTES } from './unzip'

/** Set by the build from package.json. */
declare const GUARD_VERSION: string
const VERSION = typeof GUARD_VERSION === 'string' ? GUARD_VERSION : 'dev'

/** The verdict as the exit status, so a script can act on it without reading the report. */
const EXIT: Record<VerdictKind, number> = { safe: 0, caution: 1, reject: 2, unverified: 3 }
const USAGE_EXIT = 64

const USAGE = [
  `AI Install Guard ${VERSION}: scans a plugin, mod, skill, MCP server or marketplace without running any of it.`,
  '',
  'Usage: node scan.js [options] <folder | zip | repository>',
  '',
  '  <folder>                    A folder on this machine',
  '  <zip>                       A zip archive (.zip, .skill or .plugin), unpacked into a temporary folder first',
  '  <repository>                https://host/owner/repo, a GitHub …/tree/<ref>/<folder> link,',
  '                              github:owner/repo or owner/repo, with an optional @ref',
  '  --ref <branch|tag|commit>   For a repository: the commit to scan (the default branch otherwise)',
  '  --path <folder>             A folder inside the folder, zip or repository',
  '  --details                   Every finding with its evidence and advice',
  '  --json                      The report as JSON',
  '  --lookups                   Also check packages against OSV and the name against the official',
  '                              plugin list; this sends package and plugin names to those services',
  '',
  'Exit status: 0 No red flags, 1 Worth a look, 2 Do not install, 3 Could not verify, 64 a usage error.',
].join('\n')

/** Folders a plugin keeps at its top: a zip holding only one of them is the plugin itself, not a wrapper. */
const PLUGIN_PARTS = new Set(['.claude-plugin', 'skills', 'commands', 'agents', 'hooks', 'output-styles'])

/**
 * What makes a folder a plugin, skill or marketplace, counted as the scan's
 * context counts it: one of these files, read through a link that lands on a
 * file inside the folder; a marketplace manifest that is a plain file; or a
 * plain file somewhere beneath one of these plain folders. An empty folder,
 * or a link that leads out of the folder, makes nothing.
 */
const CANDIDATE_FILES = ['.claude-plugin/plugin.json', 'SKILL.md', 'hooks/hooks.json', '.mcp.json']
const MARKETPLACE_FILE = '.claude-plugin/marketplace.json'
const CANDIDATE_FOLDERS = ['skills', 'commands', 'agents', 'output-styles']

/** What a macOS archive adds beside the folder it packed. */
const ARCHIVE_LITTER = new Set(['__MACOSX', '.DS_Store'])

type Args = { target: string; ref?: string; path?: string; details: boolean; json: boolean; lookups: boolean }

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Args | 'help' | 'version' {
  let target: string | undefined
  let ref: string | undefined
  let path: string | undefined
  let details = false
  let json = false
  let lookups = false
  let onlyTargets = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string
    if (!onlyTargets && arg.startsWith('-')) {
      const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
      if (flag === '--') onlyTargets = true
      else if (flag === '--help' || flag === '-h') return 'help'
      else if (flag === '--version') return 'version'
      else if (flag === '--details') details = true
      else if (flag === '--json') json = true
      else if (flag === '--lookups') lookups = true
      else if (flag === '--ref' || flag === '--path') {
        const value = inline ?? argv[(index += 1)]
        if (value === undefined || value === '' || (inline === undefined && value.startsWith('--'))) throw new UsageError(`${flag} needs a value`)
        if (flag === '--ref') ref = value
        else path = value
      } else throw new UsageError(`unknown option ${safeLine(arg)}`)
      continue
    }
    if (target !== undefined) throw new UsageError('name one folder, zip or repository at a time')
    target = arg
  }
  if (target === undefined || target.trim() === '') throw new UsageError('name a folder, zip or repository to scan')
  return { target, ref, path, details, json, lookups }
}

/** Scans what `args` names. Every failure is a "Could not verify" report, never a pass. */
async function scanTarget(host: Host, args: Args): Promise<ScanReport> {
  const { target } = args
  // The outside lookups send names out, so they stay off unless asked for.
  const options = { validate: false, lookups: args.lookups }
  try {
    const local = await fs.lstat(target).catch(() => undefined)
    const shape = looksRemote(target)
    if (shape === 'remote' || (shape === 'maybe' && (local === undefined || args.ref !== undefined))) {
      return await scanRemote(host, target, parseRemote(target, { ref: args.ref, subdir: args.path }), options)
    }
    if (local === undefined) return unverified(target, `${target} does not exist, and it is not a repository address`)
    if (args.ref !== undefined) return unverified(target, '--ref applies to a repository, not to a folder or zip')
    if (local.isSymbolicLink()) return unverified(target, `${target} is a symbolic link; name the folder or zip it points to`)
    if (local.isFile()) return await scanZip(host, target, args.path, options)
    const inner = args.path === undefined ? undefined : await descend(target, args.path)
    return await scanFolder(host, inner === undefined ? target : `${target} folder ${inner.shown}`, inner?.root ?? target, options)
  } catch (error) {
    return unverified(target, error instanceof Error ? error.message : String(error))
  }
}

/**
 * Unpacks a zip into a new temporary folder and scans it. When the archive
 * holds one folder and nothing else (as GitHub's Download ZIP does), that
 * folder is its top. With no `--path`, a top that is no plugin or skill itself
 * but holds exactly one that is (a README beside the plugin's folder) gives
 * way to that one, so its skills and commands are checked as such.
 */
async function scanZip(host: Host, file: string, path: string | undefined, options: ScanOptions): Promise<ScanReport> {
  const name = basename(file)
  const tooLarge = (size: number) => unverified(name, `the archive is ${Math.ceil(size / 1024 / 1024)} MB, over the ${MAX_ZIP_BYTES / 1024 / 1024} MB limit`)
  const { size } = await fs.stat(file)
  if (size > MAX_ZIP_BYTES) return tooLarge(size)
  const bytes = await fs.readFile(file)
  // Measured again as read: it may have grown since.
  if (bytes.length > MAX_ZIP_BYTES) return tooLarge(bytes.length)
  if (!looksLikeZip(bytes)) return unverified(name, `${name} is not a zip archive; only zip archives are unpacked`)
  const dir = await fs.mkdtemp(join(tmpdir(), 'ai-install-guard-zip.'))
  try {
    await extractZip(bytes, dir)
    const wrapper = await soleFolder(dir)
    let root = wrapper === undefined ? dir : `${dir}/${wrapper}`
    let shown = wrapper === undefined ? name : `${name}/${wrapper}`
    const inner = path === undefined ? await candidateIn(root) : await descend(root, path)
    if (inner !== undefined) {
      root = inner.root
      shown = `${shown}/${inner.shown}`
    }
    const report = await scanFolder(host, shown, root, options)
    // The temporary folder is gone once this returns: name the archive instead.
    return report.inventory === undefined ? report : { ...report, inventory: { ...report.inventory, root: `${shown} (unpacked from the zip)` } }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** The one plain folder an unpacked archive holds, when it holds nothing else of note. */
async function soleFolder(dir: string): Promise<string | undefined> {
  const names = (await fs.readdir(dir)).filter(name => !ARCHIVE_LITTER.has(name))
  const only = names[0]
  if (names.length !== 1 || only === undefined || PLUGIN_PARTS.has(only)) return undefined
  return (await isPlainFolder(`${dir}/${only}`)) ? only : undefined
}

/**
 * The one folder under `root` that is a plugin, skill or marketplace, when
 * `root` is none itself. Several cannot be told apart, so the scan stops and
 * asks for one by name rather than judge them as a plain folder.
 */
async function candidateIn(root: string): Promise<{ root: string; shown: string } | undefined> {
  if (await isCandidate(root)) return undefined
  const found: string[] = []
  for (const name of (await fs.readdir(root)).sort()) {
    if (!ARCHIVE_LITTER.has(name) && (await isPlainFolder(`${root}/${name}`)) && (await isCandidate(`${root}/${name}`))) found.push(name)
  }
  if (found.length > 1) {
    const listed = found.slice(0, 5).map(name => `"${safeLine(name)}"`).join(', ')
    throw new Error(`the archive holds ${found.length} plugins or skills side by side (${listed}${found.length > 5 ? ', …' : ''}); scan one at a time with --path`)
  }
  const only = found[0]
  return only === undefined ? undefined : { root: `${root}/${only}`, shown: only }
}

async function isCandidate(dir: string): Promise<boolean> {
  const real = await fs.realpath(dir)
  for (const file of CANDIDATE_FILES) {
    const landed = await fs.realpath(`${dir}/${file}`).catch(() => undefined)
    // Inside by path.relative, which reads either separator, not by a '/' prefix.
    const inside = landed === undefined ? '' : relative(real, landed)
    if (landed !== undefined && inside !== '' && !inside.startsWith('..') && !isAbsolute(inside) && (await fs.stat(landed)).isFile()) return true
  }
  if ((await fs.lstat(`${dir}/${MARKETPLACE_FILE}`).catch(() => undefined))?.isFile() === true) return true
  for (const folder of CANDIDATE_FOLDERS) if (await holdsFile(`${dir}/${folder}`)) return true
  return false
}

/** Whether a plain folder holds a plain file at any depth, without following a link. */
async function holdsFile(dir: string): Promise<boolean> {
  if (!(await isPlainFolder(dir))) return false
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isFile()) return true
    if (entry.isDirectory() && (await holdsFile(`${dir}/${entry.name}`))) return true
  }
  return false
}

async function isPlainFolder(path: string): Promise<boolean> {
  const stats = await fs.lstat(path).catch(() => undefined)
  return stats !== undefined && stats.isDirectory() && !stats.isSymbolicLink()
}

/** A folder inside `root`, reached through plain folders only: a link on the way could lead anywhere. */
async function descend(root: string, sub: string): Promise<{ root: string; shown: string }> {
  const parts = sub.split(/[\\/]+/).filter(part => part !== '' && part !== '.')
  if (/^[\\/]|^[A-Za-z]:/.test(sub) || parts.includes('..')) throw new Error(`the folder "${safeLine(sub)}" is not inside the one being scanned`)
  let at = root
  for (const part of parts) {
    at = `${at}/${part}`
    const stats = await fs.lstat(at).catch(() => undefined)
    if (stats?.isSymbolicLink() === true) throw new Error(`"${safeLine(sub)}" passes through a symbolic link, which could lead outside the folder`)
    if (stats?.isDirectory() !== true) throw new Error(`there is no folder "${safeLine(sub)}"`)
  }
  return { root: at, shown: parts.join('/') }
}

function unverified(target: string, reason: string): ScanReport {
  return { target, results: [], verdict: decide([], reason) }
}

/** The report as JSON: the pane's compact view, every quoted text made safe. */
function jsonReport(report: ScanReport): string {
  const view = viewOf(report, 'approve')
  const { source, inventory } = report
  return JSON.stringify(
    {
      guard: 'ai-install-guard',
      version: VERSION,
      note: UNTRUSTED_NOTE,
      target: view.target,
      kind: view.kind,
      verdict: view.verdict,
      ...(source === undefined
        ? {}
        : { source: { url: safeLine(source.url), ref: source.ref === undefined ? undefined : safeLine(source.ref), refKind: source.refKind, sha: source.sha, subdir: view.subdir } }),
      root: view.root,
      treeHash: view.treeHash,
      files: inventory?.entries.filter(entry => entry.kind === 'file').length,
      bytes: inventory?.totalBytes,
      results: view.rows,
    },
    null,
    2,
  )
}

async function main(argv: readonly string[], out: (text: string) => void, err: (text: string) => void): Promise<number> {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    err(`ai-install-guard: ${error.message}\n\n${USAGE}`)
    return USAGE_EXIT
  }
  if (args === 'help') {
    out(USAGE)
    return 0
  }
  if (args === 'version') {
    out(VERSION)
    return 0
  }
  // Node 18 keeps Web Crypto off the global object; the tree hash needs it.
  if (globalThis.crypto === undefined) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  const report = await scanTarget(nodeHost(), args)
  out(args.json ? jsonReport(report) : formatReport(report, { details: args.details, version: VERSION }))
  return EXIT[report.verdict.kind]
}

main(process.argv.slice(2), text => process.stdout.write(`${text}\n`), text => process.stderr.write(`${text}\n`)).then(
  code => {
    process.exitCode = code
  },
  (error: unknown) => {
    // Fail closed: whatever went wrong, the answer is never a pass.
    process.stdout.write(`AI Install Guard\nVerdict: Could not verify\n  - ${safeLine(error instanceof Error ? error.message : String(error))}\n`)
    process.exitCode = EXIT.unverified
  },
)

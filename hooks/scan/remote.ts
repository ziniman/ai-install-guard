// Fetching a remote candidate without running any of it: the ref is resolved
// to one commit, only that commit is fetched into a folder the guard owns,
// and the checkout is confirmed to have landed on it. The checks then read
// that folder like any local one, and the folder is removed afterwards.

import { capEvidence, row, type CheckResult, type Evidence } from './checks/types'
import type { Host, RunResult } from './host'
import { LIMITS } from './inventory'
import { safeLine } from './safe-text'

/** A remote candidate as asked for: an https git URL, a ref and a folder in it. */
export type RemoteSpec = {
  url: string
  ref?: string
  subdir?: string
  /**
   * The part of a GitHub link after /tree/: a ref, which may itself hold
   * slashes, then a folder. Split once the repository's refs are known.
   */
  treePath?: string
}

/** What was actually scanned: one commit, named however it was asked for. */
export type PinnedSource = {
  url: string
  /** The ref as asked for; absent for the default branch. */
  ref?: string
  refKind: 'commit' | 'tag' | 'branch' | 'default'
  sha: string
  /** The branch the repository's HEAD names, when it says. */
  defaultBranch?: string
  subdir?: string
}

export type FetchedSource = {
  root: string
  source: PinnedSource
  /** Rows about the source itself: what was pinned and how its refs look. */
  results: CheckResult[]
  cleanup: () => Promise<void>
}

/** The most a fetched commit may weigh before the scan gives up. */
export const MAX_FETCH_BYTES = 50 * 1024 * 1024

/** How long a fetch may take, which also bounds how much it can write. */
const FETCH_TIMEOUT_MS = 120_000

/** No prompts for credentials, and no Git LFS downloads during checkout. */
const GIT_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1' }

/**
 * For the steps that touch only the local copy: none of your own git
 * configuration or attributes, so a `.gitattributes` in the candidate cannot
 * select a filter program you have configured. The network steps keep your
 * configuration for proxies and certificates.
 */
const ISOLATED_ENV: Record<string, string> = { ...GIT_ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1' }

/** Names git gives its own refs; a branch or tag with one is a trap. */
const SPECIAL_REFS = new Set(['HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'BISECT_HEAD', 'AUTO_MERGE'])

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const SHORT_SHA = /^[0-9a-f]{7,39}$/
const SHORTHAND = /^(?:github:)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:@([^\s@]{1,250}))?$/

/** Whether `target` is written as a remote source rather than a folder. */
export function looksRemote(target: string): 'remote' | 'maybe' | 'local' {
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|git@|github:)/i.test(target)) return 'remote'
  // owner/repo could also be a folder: the caller checks the disk first.
  return SHORTHAND.test(target) ? 'maybe' : 'local'
}

/**
 * Reads a remote source: `https://host/path`, a GitHub tree URL
 * (`https://github.com/o/r/tree/<ref>/<folder>`), `github:o/r` or `o/r`, each
 * with an optional `@ref`. Only https is fetched, and never with a password
 * in the URL. `ref` and `subdir` from options win over the text's own.
 */
export function parseRemote(target: string, options: { ref?: string; subdir?: string } = {}): RemoteSpec {
  const text = target.trim()
  let spec: RemoteSpec
  const shorthand = SHORTHAND.exec(text)
  if (shorthand !== null && !text.includes('://')) {
    spec = { url: `https://github.com/${shorthand[1]}/${shorthand[2]}.git`, ref: shorthand[3] }
  } else {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      throw new Error(`"${safeLine(text)}" is not a folder or a repository address`)
    }
    if (url.protocol !== 'https:') throw new Error('only https:// sources are fetched')
    if (url.username !== '' || url.password !== '') throw new Error('a source address must not carry a user name or password')
    const parts = url.pathname.split('/').filter(part => part !== '')
    if (url.hostname.toLowerCase() === 'github.com' && parts.length >= 2) {
      const repo = (parts[1] as string).replace(/\.git$/, '')
      spec = { url: `https://github.com/${parts[0]}/${repo}.git` }
      if (parts[2] === 'tree' && parts[3] !== undefined) spec.treePath = parts.slice(3).map(decodeURIComponent).join('/')
    } else {
      spec = { url: `${url.origin}${url.pathname}` }
    }
  }
  // A ref named outright replaces the link's own ref and folder.
  if (options.ref !== undefined) {
    spec.ref = options.ref
    delete spec.treePath
  }
  if (options.subdir !== undefined) spec.subdir = options.subdir
  if (spec.subdir !== undefined) spec.subdir = safeSubdir(spec.subdir)
  return spec
}

/** A folder inside the repository: relative, with no `..`, normalised. */
function safeSubdir(subdir: string): string | undefined {
  const parts = subdir.split(/[\\/]+/).filter(part => part !== '' && part !== '.')
  if (/^[\\/]|^[A-Za-z]:/.test(subdir) || parts.includes('..')) throw new Error(`the folder "${safeLine(subdir)}" is not inside the repository`)
  return parts.length === 0 ? undefined : parts.join('/')
}

/**
 * Splits a GitHub link's `<ref>/<folder>` at the longest leading part that
 * names a branch or tag, so a branch called feature/foo is not read as
 * branch feature, folder foo.
 */
export function splitTreePath(listed: RemoteRefs, treePath: string): { ref: string; subdir?: string } {
  const parts = treePath.split('/').filter(part => part !== '')
  for (let count = parts.length; count >= 1; count -= 1) {
    const ref = parts.slice(0, count).join('/')
    const known = listed.refs.has(`refs/heads/${ref}`) || listed.refs.has(`refs/tags/${ref}`) || (count === 1 && FULL_SHA.test(ref.toLowerCase()))
    if (known) return { ref, subdir: count < parts.length ? safeSubdir(parts.slice(count).join('/')) : undefined }
  }
  throw new Error(`no branch or tag of the repository matches the link's "${safeLine(treePath)}"`)
}

/** Why a ref name cannot be fetched safely, or undefined when it can. */
function unsafeRef(ref: string): string | undefined {
  if (ref.startsWith('-')) return 'starts with a dash'
  if (SPECIAL_REFS.has(ref)) return `is git's own ${ref}`
  if (/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|^\.|\/\./.test(ref)) return 'is not a valid ref name'
  return undefined
}

export type RemoteRefs = {
  head?: string
  defaultBranch?: string
  /** Full ref name to commit: a tag's own commit when the tag is annotated. */
  refs: Map<string, string>
}

export function parseLsRemote(stdout: string): RemoteRefs {
  const refs = new Map<string, string>()
  const peeled = new Map<string, string>()
  let head: string | undefined
  let defaultBranch: string | undefined
  for (const line of stdout.split('\n')) {
    const symref = /^ref: (\S+)\tHEAD$/.exec(line)
    if (symref !== null) {
      defaultBranch = symref[1]
      continue
    }
    const entry = /^([0-9a-f]{40}|[0-9a-f]{64})\t(\S+)$/.exec(line)
    if (entry === null) continue
    const [, sha, name] = entry as unknown as [string, string, string]
    if (name === 'HEAD') head = sha
    else if (name.endsWith('^{}')) peeled.set(name.slice(0, -3), sha)
    else refs.set(name, sha)
  }
  for (const [name, sha] of peeled) refs.set(name, sha)
  return { head, defaultBranch, refs }
}

/** The commit a ref names, refusing anything a name could make ambiguous. */
export function resolveRef(listed: RemoteRefs, ref: string | undefined): Pick<PinnedSource, 'sha' | 'refKind' | 'ref'> {
  if (ref === undefined) {
    if (listed.head === undefined) throw new Error('the repository has no default branch to scan')
    return { sha: listed.head, refKind: 'default' }
  }
  const lower = ref.toLowerCase()
  if (FULL_SHA.test(lower)) return { sha: lower, refKind: 'commit', ref }
  const bad = unsafeRef(ref)
  if (bad !== undefined) throw new Error(`the ref "${safeLine(ref)}" ${bad}`)
  const names = ref.startsWith('refs/') ? [ref] : [`refs/tags/${ref}`, `refs/heads/${ref}`]
  const found = names.filter(name => listed.refs.has(name))
  if (found.length > 1) throw new Error(`both a branch and a tag are named "${safeLine(ref)}"; name the commit instead`)
  const name = found[0]
  if (name === undefined) {
    if (SHORT_SHA.test(lower)) throw new Error(`"${safeLine(ref)}" looks like a short commit id; use the full 40-character id`)
    throw new Error(`the repository has no branch or tag named "${safeLine(ref)}"`)
  }
  return { sha: listed.refs.get(name) as string, refKind: name.startsWith('refs/tags/') ? 'tag' : 'branch', ref }
}

/**
 * Fetches exactly one commit into a new folder of the guard's own and checks
 * it out, with no hooks, no submodules, no LFS downloads and no filters. The
 * checkout is asserted to sit on the pinned commit: a branch named like the
 * commit, or like FETCH_HEAD, cannot swap other code in.
 */
export async function fetchPinned(host: Host, spec: RemoteSpec, onStage?: (stage: string) => Promise<void> | void): Promise<FetchedSource> {
  await onStage?.(`resolving ${safeLine(spec.url)}`)
  const listing = await git(host, ['ls-remote', '--symref', spec.url, 'HEAD', 'refs/heads/*', 'refs/tags/*'], 60_000)
  if (listing.exitCode !== 0) throw failure(listing, `could not reach ${spec.url}`)
  const listed = parseLsRemote(listing.stdout)
  const fromLink = spec.treePath !== undefined && spec.ref === undefined ? splitTreePath(listed, spec.treePath) : undefined
  const subdir = spec.subdir ?? fromLink?.subdir
  const pinned = resolveRef(listed, spec.ref ?? fromLink?.ref)
  const dir = await makeTempDir(host)
  const cleanup = () => removeTempDir(host, dir)
  try {
    const work = `${dir}/repo`
    await must(git(host, ['init', '-q', '--template=', work], 60_000, ISOLATED_ENV), 'could not prepare a folder for the fetch')
    await onStage?.(`fetching ${pinned.sha.slice(0, 12)}`)
    await must(
      // git cannot cap the size of what a fetch receives, so its time is
      // capped instead; the folder is removed whatever happens.
      git(host, ['-C', work, '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', 'fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', '-q', spec.url, pinned.sha], FETCH_TIMEOUT_MS),
      `could not fetch ${pinned.sha}`,
    )
    const counted = await must(git(host, ['-C', work, 'count-objects', '-v'], 60_000, ISOLATED_ENV), 'could not measure the fetch')
    const kib = ['size', 'size-pack'].reduce((sum, key) => sum + Number(new RegExp(`^${key}:\\s*(\\d+)`, 'm').exec(counted.stdout)?.[1] ?? 0), 0)
    if (kib * 1024 > MAX_FETCH_BYTES) throw new Error(`the commit weighs more than ${MAX_FETCH_BYTES / 1024 / 1024} MB, too much to scan`)
    // What the checkout will write, measured before it is written: a small
    // pack can hold files that compress to almost nothing.
    const tree = await must(git(host, ['-C', work, 'ls-tree', '-r', '-z', '-l', '--full-tree', pinned.sha], 60_000, ISOLATED_ENV), 'could not list the commit')
    const entries = parseLsTree(tree.stdout)
    const bytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
    if (entries.length > LIMITS.maxEntries) throw new Error(`the commit holds more than ${LIMITS.maxEntries} files`)
    if (bytes > LIMITS.maxTotalBytes) throw new Error(`the commit's files add up to more than ${LIMITS.maxTotalBytes / 1024 / 1024} MB, too much to scan`)
    await must(
      git(
        host,
        ['-C', work, '-c', 'core.autocrlf=false', '-c', 'core.symlinks=true', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', 'checkout', '-q', '--detach', pinned.sha],
        120_000,
        ISOLATED_ENV,
      ),
      `could not check out ${pinned.sha}`,
    )
    // The assertion that closes Plugin4Shell: what HEAD is, not what was asked.
    const head = (await must(git(host, ['-C', work, 'rev-parse', '--verify', 'HEAD'], 60_000, ISOLATED_ENV), 'could not read the checkout')).stdout.trim()
    if (head !== pinned.sha) throw new Error(`the checkout landed on ${safeLine(head)}, not on the pinned commit ${pinned.sha}`)
    const source: PinnedSource = { url: spec.url, ...pinned, defaultBranch: listed.defaultBranch?.replace(/^refs\/heads\//, ''), subdir: subdir }
    let root = work
    // Every step of the folder must be a plain folder: a link anywhere on the
    // way could lead out of the checkout to your own files.
    for (const part of subdir?.split('/') ?? []) {
      root = `${root}/${part}`
      const stat = await host.stat(root, { resolve: false }).catch(() => undefined)
      if (stat?.isLink === true) throw new Error(`"${safeLine(subdir ?? '')}" passes through a symbolic link, which could lead outside the repository`)
      if (stat === undefined || stat.kind !== 'dir') throw new Error(`the commit has no folder "${safeLine(subdir ?? '')}"`)
    }
    return { root, source, results: [sourceRow(source), refsRow(listed), checkoutRow(entries, subdir)], cleanup }
  } catch (error) {
    await cleanup().catch(() => undefined)
    throw error
  }
}

function git(host: Host, args: readonly string[], timeoutMs = 60_000, env: Record<string, string> = GIT_ENV): Promise<RunResult> {
  return host.run(['git', ...args], { timeoutMs, env })
}

type TreeEntry = { mode: string; type: string; oid: string; size?: number; path: string }

/** `git ls-tree -r -z -l` output: one entry per NUL, with each blob's size. */
function parseLsTree(stdout: string): TreeEntry[] {
  const out: TreeEntry[] = []
  for (const entry of stdout.split(String.fromCharCode(0))) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t([\s\S]+)$/.exec(entry)
    if (match === null) continue
    const [, mode, type, oid, size, path] = match as unknown as [string, string, string, string, string, string]
    out.push({ mode, type, oid, size: size === '-' ? undefined : Number(size), path })
  }
  return out
}

async function must(result: Promise<RunResult>, what: string): Promise<RunResult> {
  const done = await result
  if (done.exitCode !== 0) throw failure(done, what)
  return done
}

function failure(result: RunResult, what: string): Error {
  const line = result.stderr.split('\n').find(text => text.trim() !== '')
  return new Error(`${what}: ${safeLine(line?.trim().slice(0, 300) ?? `git exited with ${result.exitCode}`)}`)
}

const TEMP_NAME = /[\\/]ai-install-guard\.[A-Za-z0-9._-]{6,}$/

/** A new, empty folder under the system's temp folder, owned by the guard. */
async function makeTempDir(host: Host): Promise<string> {
  const posix = await host.run(['mktemp', '-d', '-t', 'ai-install-guard.XXXXXXXX']).catch(() => undefined)
  const made = posix !== undefined && posix.exitCode === 0 ? posix.stdout.trim() : await windowsTempDir(host)
  if (!TEMP_NAME.test(made)) throw new Error('could not make a temporary folder for the fetch')
  return made.replace(/\\/g, '/')
}

const WINDOWS_MKTEMP =
  "$p = Join-Path ([IO.Path]::GetTempPath()) ('ai-install-guard.' + [guid]::NewGuid().ToString('N').Substring(0, 12)); New-Item -ItemType Directory -Path $p | Out-Null; [Console]::Out.Write($p)"

async function windowsTempDir(host: Host): Promise<string> {
  const result = await host.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_MKTEMP]).catch(() => undefined)
  return result !== undefined && result.exitCode === 0 ? result.stdout.trim() : ''
}

/** Removes a folder this module made, and nothing else. */
async function removeTempDir(host: Host, dir: string): Promise<void> {
  if (!TEMP_NAME.test(dir)) return
  const posix = await host.run(['rm', '-rf', '--', dir]).catch(() => undefined)
  if (posix !== undefined && posix.exitCode === 0) return
  await host.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', 'Remove-Item -LiteralPath $env:GUARD_DIR -Recurse -Force'], { env: { GUARD_DIR: dir } }).catch(() => undefined)
}

function sourceRow(source: PinnedSource): CheckResult {
  const what =
    source.refKind === 'commit'
      ? 'pinned to the commit you named'
      : source.refKind === 'tag'
        ? `tag ${safeLine(source.ref ?? '')} (a tag can be moved later; this scan holds the commit)`
        : source.refKind === 'branch'
          ? `branch ${safeLine(source.ref ?? '')} (a branch moves; this scan holds the commit)`
          : `the default branch${source.defaultBranch === undefined ? '' : ` ${safeLine(source.defaultBranch)}`} (it moves; this scan holds the commit)`
  return row(
    {
      id: 'provenance.source',
      group: 'provenance',
      title: 'Source and pinned commit',
      advice: 'Everything below describes this one commit. Installing anything else needs a new scan.',
    },
    [{ file: '-', excerpt: `${safeLine(source.url)}${source.subdir === undefined ? '' : ` folder ${safeLine(source.subdir)}`} at ${source.sha}: ${what}`, status: 'info' }],
    'info',
  )
}

/**
 * Branches and tags named like a commit id, or like git's own FETCH_HEAD, are
 * how a pinned install is made to check out other code (Plugin4Shell). There
 * is no honest reason for one; a short hex name is only odd.
 */
function refsRow(listed: RemoteRefs): CheckResult {
  const evidence: Evidence[] = []
  for (const name of listed.refs.keys()) {
    const match = /^refs\/(heads|tags)\/(.+)$/.exec(name)
    if (match === null) continue
    const kind = match[1] === 'heads' ? 'branch' : 'tag'
    const short = match[2] as string
    const isDefault = name === listed.defaultBranch
    const label = `the ${isDefault ? 'default ' : ''}${kind} "${safeLine(short)}"`
    if (FULL_SHA.test(short.toLowerCase())) evidence.push({ file: '-', excerpt: `${label} is named like a commit id, which can make a pinned install check out other code`, status: 'fail' })
    else if (SPECIAL_REFS.has(short)) evidence.push({ file: '-', excerpt: `${label} is named like git's own ${short}, which can make a pinned install check out other code`, status: 'fail' })
    else if (SHORT_SHA.test(short) && /\d/.test(short) && /[a-f]/.test(short)) evidence.push({ file: '-', excerpt: `${label} is named like a short commit id`, status: 'warn' })
  }
  return row(
    {
      id: 'provenance.refs',
      group: 'provenance',
      title: 'Branch and tag names',
      advice: 'A branch named like a commit id or like FETCH_HEAD lets the repository swap in other code when a client checks out a pinned commit by name. Treat the repository as hostile.',
    },
    capEvidence(evidence, 20),
  )
}

/** What a plain checkout leaves out: submodules, whose code lives elsewhere. */
function checkoutRow(entries: readonly TreeEntry[], subdir: string | undefined): CheckResult {
  const evidence: Evidence[] = []
  for (const { mode, oid, path } of entries) {
    if (mode !== '160000') continue
    if (subdir !== undefined && path !== subdir && !path.startsWith(`${subdir}/`)) continue
    const shown = subdir === undefined ? path : path.slice(subdir.length + 1) || '.'
    evidence.push({ file: shown, excerpt: `a submodule at commit ${oid.slice(0, 12)}: its code is fetched separately and is not part of this scan`, status: 'warn' })
  }
  return row(
    {
      id: 'provenance.checkout',
      group: 'provenance',
      title: 'Code outside the commit',
      advice: 'A submodule pulls code from another repository at install time. That code was not scanned.',
    },
    capEvidence(evidence, 20),
  )
}

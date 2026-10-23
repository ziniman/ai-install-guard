// Where an install would come from: the repository, folder and commit Claude
// Code would install, read from its own plugin listing and marketplace
// catalogs. Only the `claude` command and file reads are used; nothing from
// the candidate runs.

import type { Host } from '../scan/host'
import { looksRemote, parseRemote, type RemoteSpec } from '../scan/remote'
import { safeLine } from '../scan/safe-text'
import type { InstallRequest } from './requests'

export type Target =
  /** One commit of a repository, and the folder in it. */
  | { kind: 'remote'; spec: RemoteSpec }
  /** A folder on this machine: a marketplace's own copy of a plugin, or a marketplace added from a folder. */
  | { kind: 'local'; path: string }
  /** A marketplace name: Claude Code shows its menu to pick a plugin from. */
  | { kind: 'browse' }
  | { kind: 'unverifiable'; reason: string }

/** The most a marketplace catalog may weigh before the guard stops reading it. */
const MAX_CATALOG_BYTES = 4 * 1024 * 1024

type Listed = { pluginId?: unknown; name?: unknown; marketplaceName?: unknown; source?: unknown }
type Marketplace = { name: string; installLocation?: string }

/** The target an install request names. A lookup that fails says why, as an unverifiable target. */
export async function targetOf(host: Host, request: InstallRequest): Promise<Target> {
  try {
    return request.kind === 'marketplace' ? await marketplaceTarget(host, request.source) : await pluginTarget(host, request)
  } catch (error) {
    return { kind: 'unverifiable', reason: error instanceof Error ? error.message : String(error) }
  }
}

async function pluginTarget(host: Host, request: Extract<InstallRequest, { kind: 'plugin' }>): Promise<Target> {
  const listing = await claudeJson(host, ['plugin', 'list', '--available', '--json'], 'the plugin list')
  const available: Listed[] = isRecord(listing) && Array.isArray(listing.available) ? (listing.available as Listed[]) : []
  const installed = isRecord(listing) && Array.isArray(listing.installed) ? (listing.installed as { id?: unknown }[]) : []
  const id = request.marketplace === undefined ? request.plugin : `${request.plugin}@${request.marketplace}`
  const matches = available.filter(item => item.name === request.plugin && (request.marketplace === undefined || item.marketplaceName === request.marketplace))
  // Where marketplaces live is read only when it is needed: for a relative source or a catalog file.
  let listed: Promise<Marketplace[]> | undefined
  const marketplaces = (): Promise<Marketplace[]> => (listed ??= marketplaceList(host))

  if (matches.length === 0) {
    // An installed plugin is not in the available list: its catalog says where an update comes from.
    // A marketplace named is that marketplace's plugin and no other's.
    const mine = installed.map(item => (typeof item.id === 'string' ? item.id : '')).filter(item => (request.marketplace === undefined ? item.startsWith(`${request.plugin}@`) : item === id))
    if (mine.length > 1 && request.marketplace === undefined) return ambiguous(request.plugin, mine.map(item => item.split('@')[1] ?? ''))
    const owner = mine[0]?.split('@')[1] ?? request.marketplace
    const market = (await marketplaces()).find(item => item.name === owner)
    if (market !== undefined) {
      const entry = await catalogEntry(host, market, request.plugin)
      if (entry !== undefined) return sourceTarget(host, entry, async () => market)
    }
    // `/plugin install <marketplace>` opens that marketplace's menu.
    if (request.verb === 'install' && request.marketplace === undefined && (await marketplaces()).some(item => item.name === request.plugin)) return { kind: 'browse' }
    return { kind: 'unverifiable', reason: `${safeLine(id)} is not in the marketplaces you added, so there was nothing to scan` }
  }

  // The same plugin can be listed by two marketplaces. One source between them is one target.
  const distinct = new Map(matches.map(item => [sourceKey(item), item]))
  if (distinct.size > 1) return ambiguous(request.plugin, matches.map(item => String(item.marketplaceName)))
  const entry = [...distinct.values()][0] as Listed
  return sourceTarget(host, entry, () => marketplaces().then(list => list.find(item => item.name === entry.marketplaceName)))
}

function ambiguous(plugin: string, marketplaces: readonly string[]): Target {
  const names = [...new Set(marketplaces)].map(safeLine)
  return {
    kind: 'unverifiable',
    reason: `${safeLine(plugin)} is in more than one marketplace (${names.join(', ')}); name one, as in ${safeLine(plugin)}@${names[0] ?? '<marketplace>'}`,
  }
}

/**
 * A source's identity: a relative source belongs to its marketplace, so two
 * marketplaces' `./x` are never the same; an object source is its fields in
 * name order, however a listing orders them.
 */
function sourceKey(item: Listed): string {
  if (typeof item.source === 'string') return `${String(item.marketplaceName)}:${item.source}`
  return JSON.stringify(canonical(item.source ?? null))
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isRecord(value)) return value
  return Object.keys(value)
    .sort()
    .map(key => [key, canonical(value[key])])
}

/** Where a catalog entry's `source` says the plugin comes from; `marketOf` finds its marketplace when a relative source needs it. */
async function sourceTarget(host: Host, entry: Listed, marketOf: () => Promise<Marketplace | undefined>): Promise<Target> {
  const source = entry.source
  if (typeof source === 'string') {
    if (!source.startsWith('./')) return { kind: 'unverifiable', reason: `its source "${safeLine(source)}" is not a folder inside its marketplace` }
    const market = await marketOf()
    if (market?.installLocation === undefined) return { kind: 'unverifiable', reason: 'its marketplace has no copy on this machine to read it from' }
    return { kind: 'local', path: await insideFolder(host, market.installLocation, source) }
  }
  if (!isRecord(source) || typeof source.source !== 'string') return { kind: 'unverifiable', reason: 'its catalog entry names no source' }
  const ref = text(source.sha) ?? text(source.ref)
  switch (source.source) {
    case 'url':
      return remote(text(source.url), ref)
    case 'git-subdir':
      // Without its folder the entry would name the whole repository, which is not what installs.
      if (text(source.path) === undefined) return { kind: 'unverifiable', reason: 'its catalog entry names no folder inside its repository' }
      return remote(text(source.url), ref, text(source.path))
    case 'github':
      return remote(text(source.repo) === undefined ? undefined : `https://github.com/${text(source.repo)}.git`, ref)
    default:
      return { kind: 'unverifiable', reason: `it installs from a ${safeLine(source.source)} source, which the guard cannot read yet` }
  }
}

function remote(url: string | undefined, ref: string | undefined, subdir?: string): Target {
  if (url === undefined) return { kind: 'unverifiable', reason: 'its catalog entry names no repository' }
  return { kind: 'remote', spec: parseRemote(url, { ref, subdir }) }
}

/** What `marketplace add <source>` would add: a repository, or a folder. */
async function marketplaceTarget(host: Host, source: string): Promise<Target> {
  const shape = looksRemote(source)
  if (shape === 'local' || (shape === 'maybe' && (await host.stat(source).catch(() => undefined)) !== undefined)) {
    const path = await expandHome(host, source)
    const stat = await host.stat(path).catch(() => undefined)
    if (stat === undefined) return { kind: 'unverifiable', reason: `there is no folder at ${safeLine(source)}` }
    if (stat.kind !== 'dir') return { kind: 'unverifiable', reason: `${safeLine(source)} is a file; the guard scans the folder or repository a marketplace lives in` }
    return { kind: 'local', path }
  }
  const spec = parseRemote(source)
  if (/\.json$/i.test(spec.url)) return { kind: 'unverifiable', reason: 'it adds a catalog file from a web address; the guard scans the repository a marketplace lives in' }
  return { kind: 'remote', spec }
}

async function marketplaceList(host: Host): Promise<Marketplace[]> {
  const listed = await claudeJson(host, ['plugin', 'marketplace', 'list', '--json'], 'the marketplace list')
  if (!Array.isArray(listed)) return []
  return listed.flatMap(item => (isRecord(item) && typeof item.name === 'string' ? [{ name: item.name, installLocation: text(item.installLocation) }] : []))
}

/** A plugin's entry in a marketplace's own catalog file. */
async function catalogEntry(host: Host, market: Marketplace, plugin: string): Promise<Listed | undefined> {
  if (market.installLocation === undefined) return undefined
  const path = await insideFolder(host, market.installLocation, './.claude-plugin/marketplace.json')
  const stat = await host.stat(path)
  if (stat.kind !== 'file' || stat.size > MAX_CATALOG_BYTES) throw new Error(`the catalog of ${safeLine(market.name)} is not a file the guard can read`)
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(await host.readBytes(path)))
  } catch {
    throw new Error(`the catalog of ${safeLine(market.name)} is not valid JSON`)
  }
  const plugins = isRecord(parsed) && Array.isArray(parsed.plugins) ? parsed.plugins : []
  const found = plugins.find(item => isRecord(item) && item.name === plugin)
  return isRecord(found) ? { name: plugin, marketplaceName: market.name, source: found.source } : undefined
}

/**
 * `relative` inside `folder`: no `..` above it, and no symbolic link on the
 * way, which could lead the scan (and the install) out to other files.
 */
async function insideFolder(host: Host, folder: string, relative: string): Promise<string> {
  const parts = relative.split(/[\\/]+/).filter(part => part !== '' && part !== '.')
  if (parts.includes('..')) throw new Error(`"${safeLine(relative)}" leads outside its marketplace`)
  let path = folder.replace(/[\\/]+$/, '')
  for (const part of parts) {
    path = `${path}/${part}`
    const stat = await host.stat(path, { resolve: false }).catch(() => undefined)
    if (stat === undefined) throw new Error(`its marketplace has no ${safeLine(relative)}`)
    if (stat.isLink) throw new Error(`"${safeLine(relative)}" passes through a symbolic link, which could lead outside its marketplace`)
  }
  return path
}

/** Runs `claude <args>` and reads its JSON answer. */
async function claudeJson(host: Host, args: readonly string[], what: string): Promise<unknown> {
  const result = await host.run(['claude', ...args], { timeoutMs: 60_000 }).catch((error: unknown) => {
    throw new Error(`could not read ${what}: ${error instanceof Error ? safeLine(error.message) : 'the claude command did not run'}`)
  })
  if (result.exitCode !== 0) {
    const line = result.stderr.split('\n').find(item => item.trim() !== '') ?? `claude exited with ${result.exitCode}`
    throw new Error(`could not read ${what}: ${safeLine(line.trim().slice(0, 300))}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`could not read ${what}: its answer was not valid JSON`)
  }
}

/** `~` and `~/…` as the full path of your home folder. */
export async function expandHome(host: Host, path: string): Promise<string> {
  if (path !== '~' && !path.startsWith('~/')) return path
  const { exitCode, stdout } = await host.run(['printenv', 'HOME'])
  const home = stdout.trim()
  if (exitCode !== 0 || home === '') throw new Error('could not find the home folder')
  return home + path.slice(1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

// Lookups outside the machine, off unless you turn on `outsideLookups`:
// packages checked against OSV (Google's open vulnerability database, which
// also lists packages published to steal or harm), and plugin names against
// Anthropic's official marketplace, to catch a name made to look like one of
// its plugins. Each sends names to that service, so it is your choice. A
// lookup that fails is noted and never fails the scan.

import { isRecord, parseJson, type ScanContext } from './checks/context'
import { capEvidence, row, type CheckResult, type Evidence } from './checks/types'
import type { Host } from './host'
import { safeLine } from './safe-text'

export const OSV_BATCH = 'https://api.osv.dev/v1/querybatch'
export const OSV_VULN = 'https://api.osv.dev/v1/vulns/'
/** How many advisories' details are read to tell malware from a bug. */
const MAX_DETAILS = 30
export const OFFICIAL_MARKETPLACE = 'https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json'
/** OSV takes up to 1,000 queries a request; past this many, the rest are reported as not checked. */
const BATCH = 1000
const MAX_QUERIES = 3000

type Package = { ecosystem: 'npm' | 'PyPI'; name: string; version?: string; file: string; via?: string }

export async function outsideLookups(host: Host, ctx: ScanContext): Promise<CheckResult[]> {
  if (host.fetch === undefined) return []
  return [await osvCheck(host, ctx), ...(await namesCheck(host, ctx))]
}

function failedRow(id: string, title: string, reason: string): CheckResult {
  return {
    id,
    group: 'provenance',
    title,
    status: 'info',
    severity: 'none',
    evidence: [{ file: '-', excerpt: `not checked: ${safeLine(reason)}`, status: 'info' }],
    advice: 'The lookup did not answer, so this part was not checked.',
    summary: [`Not checked: ${safeLine(reason)}`],
  }
}

const EXACT = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/

/** Runner options that take the next word as a value; `true` when that value is a package. */
const RUNNER_OPTIONS: Record<string, boolean> = {
  '-p': true, '--package': true, '--from': true, '--with': true, '-w': true, '--spec': true,
  '-c': false, '--call': false, '--node-options': false, '--registry': false, '--cache': false, '--prefix': false, '--userconfig': false, '--workspace': false,
  '--python': false, '-i': false, '--index-url': false, '--extra-index-url': false, '--index': false, '--default-index': false, '--find-links': false, '-f': false, '--pip-args': false,
}

/** The packages a candidate installs or runs: its MCP servers' and its manifests'. */
export function packagesOf(ctx: ScanContext): Package[] {
  const out: Package[] = []
  const add = (pkg: Package) => {
    if (!out.some(item => item.ecosystem === pkg.ecosystem && item.name === pkg.name && item.version === pkg.version)) out.push(pkg)
  }
  const addSpec = (spec: string, python: boolean, file: string, via: string) => {
    if (python) {
      const [name, version] = spec.split(/==|@/)
      if (name !== undefined && /^[A-Za-z0-9._-]{1,100}$/.test(name)) add({ ecosystem: 'PyPI', name, version: version !== undefined && EXACT.test(version) ? version : undefined, file, via })
      return
    }
    const at = spec.lastIndexOf('@')
    const name = at > 0 ? spec.slice(0, at) : spec
    const version = at > 0 ? spec.slice(at + 1) : undefined
    if (/^(?:@[\w.-]+\/)?[\w.-]{1,100}$/.test(name)) add({ ecosystem: 'npm', name, version: version !== undefined && EXACT.test(version) ? version : undefined, file, via })
  }
  for (const server of ctx.mcpServers) {
    const words = [server.command ?? '', ...server.args].join(' ').split(/\s+/).filter(word => word !== '')
    const base = (word: string | undefined) => word?.split(/[\\/]/).pop() ?? ''
    const runner = words.findIndex(word => /^(?:npx|bunx|pnpx|uvx)$/.test(base(word)))
    const exec = words.findIndex((word, index) => /^(?:npm|pnpm|yarn|bun)$/.test(base(word)) && /^(?:exec|dlx|x)$/.test(words[index + 1] ?? ''))
    const pipx = words.findIndex((word, index) => base(word) === 'pipx' && words[index + 1] === 'run')
    const start = runner !== -1 ? runner + 1 : exec !== -1 ? exec + 2 : pipx !== -1 ? pipx + 2 : -1
    if (start === -1) continue
    const python = runner !== -1 ? base(words[runner]) === 'uvx' : pipx !== -1
    // Options with values are skipped; those that name a package (--from,
    // --package, --with, --spec) name the package, and the word after them
    // is then only the command to run.
    let named = false
    for (let index = start; index < words.length; index += 1) {
      const word = words[index] as string
      if (word === '--') continue
      if (word.startsWith('-')) {
        const [flag, inline] = word.split('=', 2) as [string, string | undefined]
        const isPackage = RUNNER_OPTIONS[flag]
        if (isPackage === undefined) continue
        const value = inline ?? words[index + 1]
        if (inline === undefined) index += 1
        if (isPackage && value !== undefined) {
          addSpec(value, python, server.file, server.name)
          named = true
        }
        continue
      }
      if (!named) addSpec(word, python, server.file, server.name)
      break
    }
  }
  for (const file of ctx.files) {
    const name = file.path.split('/').pop() ?? ''
    if (name === 'package.json') {
      const parsed = parseJson(ctx.text(file.path))
      if (!parsed.ok || !isRecord(parsed.value)) continue
      const dir = file.path.slice(0, -'package.json'.length)
      const lock = parseJson(ctx.text(`${dir}package-lock.json`))
      const locked = lock.ok && isRecord(lock.value) && isRecord(lock.value.packages) ? lock.value.packages : {}
      for (const section of ['dependencies', 'optionalDependencies', 'devDependencies']) {
        const deps = parsed.value[section]
        if (!isRecord(deps)) continue
        for (const [dep, spec] of Object.entries(deps)) {
          const entry = locked[`node_modules/${dep}`]
          const fromLock = isRecord(entry) ? entry.version : undefined
          const version = typeof spec === 'string' && EXACT.test(spec) ? spec : typeof fromLock === 'string' && EXACT.test(fromLock) ? fromLock : undefined
          if (version !== undefined) add({ ecosystem: 'npm', name: dep, version, file: file.path, via: section === 'devDependencies' ? 'for development' : undefined })
        }
      }
    } else if (/^requirements(?:[-.\w]*)?\.txt$/.test(name)) {
      for (const line of (ctx.text(file.path) ?? '').split('\n')) {
        const pin = /^\s*([A-Za-z0-9._-]{1,100})(?:\[[^\]]*\])?\s*==\s*([\w.+!-]{1,50})\s*(?:[#;].*)?$/.exec(line)
        if (pin !== null) add({ ecosystem: 'PyPI', name: pin[1] as string, version: pin[2] as string, file: file.path })
      }
    }
  }
  return out
}

async function osvCheck(host: Host, ctx: ScanContext): Promise<CheckResult> {
  const found = packagesOf(ctx)
  const packages = found.slice(0, MAX_QUERIES)
  const base = { id: 'provenance.packages', group: 'provenance' as const, title: 'Known malicious or vulnerable packages' }
  if (packages.length === 0) return row({ ...base, advice: 'No packages to look up.' }, [])
  const fetch = host.fetch as NonNullable<Host['fetch']>
  // One list of advisory ids per package, in order, or undefined for a
  // package whose batch got no usable answer. OSV answers in batches, and a
  // batch that fails never discards what earlier batches found.
  const ids: (string[] | undefined)[] = []
  let failure: string | undefined
  for (let start = 0; start < packages.length; start += BATCH) {
    const batch = packages.slice(start, start + BATCH)
    let results: unknown
    try {
      const answer = await fetch(OSV_BATCH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: batch.map(pkg => ({ package: { name: pkg.name, ecosystem: pkg.ecosystem }, ...(pkg.version === undefined ? {} : { version: pkg.version }) })) }),
      })
      const parsed = parseJson(answer.text)
      results = answer.ok && parsed.ok && isRecord(parsed.value) ? parsed.value.results : undefined
      if (!answer.ok) failure = `OSV answered ${answer.status}`
    } catch (error) {
      failure = `could not reach OSV: ${error instanceof Error ? error.message : String(error)}`
    }
    // A reply that does not answer every package is not trusted for any of its batch.
    if (!Array.isArray(results) || results.length !== batch.length) {
      failure ??= 'OSV gave an answer that does not cover every package'
      for (let index = 0; index < batch.length; index += 1) ids.push(undefined)
      continue
    }
    for (const entry of results) {
      ids.push(isRecord(entry) && Array.isArray(entry.vulns) ? entry.vulns.map(vuln => (isRecord(vuln) && typeof vuln.id === 'string' ? vuln.id : '')).filter(id => /^[A-Z][\w.-]{2,60}$/.test(id)) : [])
    }
  }
  const unchecked = ids.filter(list => list === undefined).length
  if (unchecked === packages.length) return failedRow(base.id, base.title, failure ?? 'OSV gave no usable answer')
  // Malware is often filed as an ordinary advisory (GHSA) marked CWE-506, so
  // each id's details are read; MAL- ids are malware by definition. An id
  // whose details could not be read stays unresolved, never cleared.
  const all = [...new Set(ids.flatMap(list => list ?? []))]
  const harmful = new Set(all.filter(id => id.startsWith('MAL-')))
  const resolved = new Set(harmful)
  const wanted = all.filter(id => !id.startsWith('MAL-')).slice(0, MAX_DETAILS)
  for (let start = 0; start < wanted.length; start += 6) {
    await Promise.all(
      wanted.slice(start, start + 6).map(async id => {
        try {
          const answer = await fetch(`${OSV_VULN}${encodeURIComponent(id)}`)
          const parsed = parseJson(answer.text)
          if (!answer.ok || !parsed.ok || !isRecord(parsed.value)) return
          const details = parsed.value
          const cwes = isRecord(details.database_specific) && Array.isArray(details.database_specific.cwe_ids) ? details.database_specific.cwe_ids : []
          if (cwes.includes('CWE-506') || (typeof details.summary === 'string' && /\bmalware\b|\bmalicious\b/i.test(details.summary))) harmful.add(id)
          resolved.add(id)
        } catch {
          // Left unresolved.
        }
      }),
    )
  }
  const evidence: Evidence[] = []
  const malicious: string[] = []
  const vulnerable: string[] = []
  const unknown: string[] = []
  packages.forEach((pkg, index) => {
    const list = ids[index]
    if (list === undefined) return
    const label = `${pkg.name}${pkg.version === undefined ? '' : `@${pkg.version}`} (${pkg.ecosystem})`
    const lead = pkg.via === undefined ? '' : `${pkg.via}: `
    const bad = list.filter(id => harmful.has(id))
    const open = list.filter(id => !resolved.has(id))
    if (bad.length > 0) {
      malicious.push(label)
      evidence.push({ file: pkg.file, excerpt: `${lead}${label} is listed as malware: ${bad.slice(0, 3).join(', ')}`, status: 'fail' })
    } else if (pkg.version !== undefined && list.length > 0) {
      vulnerable.push(label)
      const note = open.length > 0 ? `; ${open.length} could not be read, and any of them may be malware` : ''
      evidence.push({ file: pkg.file, excerpt: `${lead}${label} has ${list.length} known vulnerabilit${list.length === 1 ? 'y' : 'ies'}: ${list.slice(0, 4).join(', ')}${list.length > 4 ? ' and more' : ''}${note}`, status: 'warn' })
    } else if (open.length > 0) {
      // Unpinned, so only malware counts; and these could not be ruled out.
      unknown.push(label)
      evidence.push({ file: pkg.file, excerpt: `${lead}${label} has ${open.length} advisor${open.length === 1 ? 'y' : 'ies'} whose details could not be read; any of them may be malware`, status: 'warn' })
    }
  })
  const notLooked = found.length - packages.length + unchecked
  if (notLooked > 0) evidence.push({ file: '-', excerpt: `${notLooked} package${notLooked === 1 ? ' was' : 's were'} not looked up${failure === undefined ? '' : ` (${failure})`}`, status: 'warn' })
  const checked = `Checked ${packages.length - unchecked} package${packages.length - unchecked === 1 ? '' : 's'} against OSV${notLooked > 0 ? `; ${notLooked} more ${notLooked === 1 ? 'was' : 'were'} not looked up` : ''}`
  const summary =
    malicious.length > 0
      ? [`Uses a package listed as malware: ${malicious.slice(0, 3).join(', ')}`, checked]
      : vulnerable.length + unknown.length > 0
        ? [`${vulnerable.length + unknown.length} package${vulnerable.length + unknown.length === 1 ? ' has' : 's have'} advisories: ${[...vulnerable, ...unknown].slice(0, 3).join(', ')}`, checked]
        : notLooked > 0
          ? [checked]
          : undefined
  return row(
    {
      ...base,
      advice: 'A package OSV lists as malware was published to do harm: do not install. A known vulnerability may or may not be reachable from this plugin; a newer version usually fixes it.',
      summary,
    },
    capEvidence(evidence, 20),
  )
}

/** Edit distance, stopping once it passes `limit`. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j += 1) {
      const value = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1))
      current.push(value)
      best = Math.min(best, value)
    }
    if (best > limit) return limit + 1
    previous = current
  }
  return previous[b.length] as number
}

/** A name with look-alike characters folded: 0 to o, 1 to l, separators dropped. */
function folded(name: string): string {
  return name.toLowerCase().replace(/0/g, 'o').replace(/[1|]/g, 'l').replace(/3/g, 'e').replace(/5/g, 's').replace(/[^a-z0-9]/g, '')
}

async function namesCheck(host: Host, ctx: ScanContext): Promise<CheckResult[]> {
  const names = new Set<string>()
  if (typeof ctx.manifest?.name === 'string') names.add(ctx.manifest.name)
  const market = parseJson(ctx.text('.claude-plugin/marketplace.json'))
  if (market.ok && isRecord(market.value) && Array.isArray(market.value.plugins)) {
    for (const plugin of market.value.plugins.slice(0, 200)) if (isRecord(plugin) && typeof plugin.name === 'string') names.add(plugin.name)
  }
  if (names.size === 0) return []
  const title = 'Names like official plugins'
  let official: string[]
  try {
    const answer = await (host.fetch as NonNullable<Host['fetch']>)(OFFICIAL_MARKETPLACE)
    const parsed = parseJson(answer.text)
    if (!answer.ok || !parsed.ok || !isRecord(parsed.value) || !Array.isArray(parsed.value.plugins)) return [failedRow('provenance.names', title, `the official list answered ${answer.status}`)]
    official = parsed.value.plugins.map(plugin => (isRecord(plugin) && typeof plugin.name === 'string' ? plugin.name : '')).filter(name => name !== '')
  } catch (error) {
    return [failedRow('provenance.names', title, `could not reach the official list: ${error instanceof Error ? error.message : String(error)}`)]
  }
  const evidence: Evidence[] = []
  for (const name of names) {
    if (official.includes(name)) {
      evidence.push({ file: '-', excerpt: `${safeLine(name)} has the same name as an official plugin: make sure this is that plugin, from its own source`, status: 'info' })
      continue
    }
    const mine = folded(name)
    const near = official.find(other => {
      const theirs = folded(other)
      if (theirs === mine) return true
      const limit = Math.min(mine.length, theirs.length) >= 8 ? 2 : Math.min(mine.length, theirs.length) >= 5 ? 1 : 0
      return limit > 0 && distance(mine, theirs, limit) <= limit
    })
    if (near !== undefined) evidence.push({ file: '-', excerpt: `${safeLine(name)} looks like the official plugin ${safeLine(near)}`, status: 'warn' })
  }
  return [
    row(
      {
        id: 'provenance.names',
        group: 'provenance',
        title,
        advice: "A name one letter away from an official plugin's is a common way to be installed by mistake. Check the publisher before you trust it.",
        summary: (() => {
          const near = evidence.filter(item => item.status === 'warn').map(item => item.excerpt)
          return near.length === 0 ? undefined : [`Its name looks like an official plugin's: ${near.slice(0, 3).join('; ')}${near.length > 3 ? ` and ${near.length - 3} more` : ''}`]
        })(),
      },
      capEvidence(evidence, 20),
    ),
  ]
}

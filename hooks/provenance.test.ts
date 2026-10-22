import { describe, expect, mock, test } from 'claude-code/testing'

import { buildContext } from './scan/checks/context'
import type { CheckResult } from './scan/checks/types'
import { githubProvenance } from './scan/github'
import type { FetchInit, FetchResult, Host } from './scan/host'
import { takeInventory } from './scan/inventory'
import { OFFICIAL_MARKETPLACE, OSV_BATCH, OSV_VULN, outsideLookups, packagesOf } from './scan/lookups'
import { scanFolder } from './scan/scan'
import type { PinnedSource } from './scan/remote'
import { FIXTURES } from './test-support/fixtures.gen'
import { memoryHost, serveFixture, serveUi, typed, type FixtureFiles } from './test-support/memfs'

const NOW = Date.parse('2026-10-22T12:00:00Z')
const SHA = 'a'.repeat(40)
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString()
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): FetchResult => ({ status, ok: status >= 200 && status < 300, headers, text: JSON.stringify(body) })
const b64 = (text: string) => ({ base64: btoa(text) })
const status = (results: readonly CheckResult[], id: string) => results.find(result => result.id === id)?.status

function fixture(name: string): FixtureFiles {
  const files = FIXTURES[name]
  if (files === undefined) throw new Error(`no fixture ${name}`)
  return files
}

/** A host whose network answers from a table, recording every request. */
function netHost(answers: (url: string, init?: FetchInit) => FetchResult | Error, files: FixtureFiles = fixture('clean-plugin')): Host & { asked: string[] } {
  const asked: string[] = []
  const base = memoryHost('/p', files)
  return Object.assign({}, base, {
    asked,
    fetch: async (url: string, init?: FetchInit) => {
      asked.push(url)
      const answer = answers(url, init)
      if (answer instanceof Error) throw answer
      return answer
    },
  })
}

type Repo = { repoDays: number; ownerDays: number; stars: number; people: number; fork?: boolean; archived?: boolean; verified?: boolean; compare?: string; commitStatus?: number }

function github(repo: Repo) {
  return (url: string): FetchResult => {
    const path = url.replace('https://api.github.com', '')
    if (path === '/repos/acme/notes') {
      return json({
        created_at: daysAgo(repo.repoDays), pushed_at: daysAgo(2), stargazers_count: repo.stars, forks_count: 3, archived: repo.archived === true, fork: repo.fork === true,
        parent: repo.fork === true ? { full_name: 'original/notes' } : undefined, owner: { login: 'acme', type: 'User' }, default_branch: 'main',
      })
    }
    if (path === '/users/acme') return json({ created_at: daysAgo(repo.ownerDays) })
    if (path.startsWith('/repos/acme/notes/contributors')) {
      return json([{ login: 'acme' }], 200, repo.people > 1 ? { link: `<https://api.github.com/repositories/1/contributors?per_page=1&anon=1&page=${repo.people}>; rel="last"` } : {})
    }
    if (path === `/repos/acme/notes/commits/${SHA}`) {
      return repo.commitStatus !== undefined ? json({ message: 'No commit found' }, repo.commitStatus) : json({ commit: { verification: { verified: repo.verified === true }, committer: { date: daysAgo(5) } } })
    }
    if (path.startsWith('/repos/acme/notes/compare/')) return json({ status: repo.compare ?? 'behind' })
    return json({ message: 'Not Found' }, 404)
  }
}

const SOURCE: PinnedSource = { url: 'https://github.com/acme/notes.git', sha: SHA, refKind: 'default', defaultBranch: 'main' }

describe('repository history from GitHub', () => {
  test('an established repository is only described', async () => {
    const results = await githubProvenance(netHost(github({ repoDays: 900, ownerDays: 3000, stars: 120, people: 6, verified: true })), SOURCE, NOW)
    expect(status(results, 'provenance.repository')).toBe('info')
    expect(results[0]?.summary).toEqual(['Created 2 years ago by the account acme (on GitHub since 8 years ago)', '120 stars, 3 forks, 6 contributors; last pushed 2 days ago'])
    expect(results[1]?.summary?.[0]).toBe('Signed, and GitHub verified the signature; committed 5 days ago')
  })

  test('a new account, or a new repository with one author and few stars, is a warning', async () => {
    expect(status(await githubProvenance(netHost(github({ repoDays: 900, ownerDays: 4, stars: 120, people: 6 })), SOURCE, NOW), 'provenance.repository')).toBe('warn')
    expect(status(await githubProvenance(netHost(github({ repoDays: 3, ownerDays: 3000, stars: 1, people: 1 })), SOURCE, NOW), 'provenance.repository')).toBe('warn')
    // New, but from an established account with others on it: noted only.
    expect(status(await githubProvenance(netHost(github({ repoDays: 3, ownerDays: 3000, stars: 65, people: 2 })), SOURCE, NOW), 'provenance.repository')).toBe('info')
  })

  test('a fork and an archived repository are noted', async () => {
    const results = await githubProvenance(netHost(github({ repoDays: 900, ownerDays: 3000, stars: 5, people: 2, fork: true, archived: true })), SOURCE, NOW)
    const excerpts = results[0]?.evidence.map(item => item.excerpt) ?? []
    expect(excerpts).toContain('a fork of original/notes: compare it with the original')
    expect(excerpts).toContain('archived: it gets no more fixes')
  })

  test('a commit named by id that is not on the default branch is a warning', async () => {
    const byId = { ...SOURCE, refKind: 'commit' as const }
    expect(status(await githubProvenance(netHost(github({ repoDays: 900, ownerDays: 3000, stars: 5, people: 2, compare: 'diverged' })), byId, NOW), 'provenance.commit')).toBe('warn')
    expect(status(await githubProvenance(netHost(github({ repoDays: 900, ownerDays: 3000, stars: 5, people: 2, compare: 'behind' })), byId, NOW), 'provenance.commit')).toBe('info')
    expect(status(await githubProvenance(netHost(github({ repoDays: 900, ownerDays: 3000, stars: 5, people: 2, commitStatus: 422 })), byId, NOW), 'provenance.commit')).toBe('warn')
  })

  test('a rate limit or no network is noted, never a failure', async () => {
    const limited = await githubProvenance(netHost(() => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' })), SOURCE, NOW)
    expect(limited.map(result => result.status)).toEqual(['info'])
    expect(limited[0]?.summary?.[0]).toContain('limit')
    const offline = await githubProvenance(netHost(() => new Error('getaddrinfo ENOTFOUND')), SOURCE, NOW)
    expect(offline[0]?.summary?.[0]).toContain('could not reach GitHub')
    expect(await githubProvenance(memoryHost('/p', fixture('clean-plugin')), SOURCE, NOW)).toEqual([])
    expect(await githubProvenance(netHost(github({ repoDays: 1, ownerDays: 1, stars: 0, people: 1 })), { ...SOURCE, url: 'https://git.example.org/acme/notes.git' }, NOW)).toEqual([])
  })
})

describe('outside lookups', () => {
  const ctxOf = async (files: FixtureFiles) => buildContext(await takeInventory(memoryHost('/p', { ...fixture('clean-plugin'), ...files }), '/p'))

  test('the packages a plugin runs and installs', async () => {
    const ctx = await ctxOf({
      '.mcp.json': b64(JSON.stringify({ mcpServers: { a: { command: 'npx', args: ['-y', '@acme/notes-mcp@1.2.3'] }, b: { command: 'uvx', args: ['notes-py==0.4.0'] }, c: { command: 'npm', args: ['exec', '--yes', 'other-mcp'] } } })),
      'package.json': b64(JSON.stringify({ name: 'x', dependencies: { left: '1.0.0', right: '^2.0.0', loose: '^3.0.0' } })),
      'package-lock.json': b64(JSON.stringify({ packages: { 'node_modules/right': { version: '2.1.0' } } })),
      'requirements.txt': b64('requests==2.31.0\nflask>=2\n'),
    })
    expect(packagesOf(ctx).map(pkg => `${pkg.ecosystem}:${pkg.name}@${pkg.version ?? '*'}`)).toEqual([
      'npm:@acme/notes-mcp@1.2.3', 'PyPI:notes-py@0.4.0', 'npm:other-mcp@*', 'npm:left@1.0.0', 'npm:right@2.1.0', 'PyPI:requests@2.31.0',
    ])
  })

  const osv = (results: unknown[], details: Record<string, unknown> = {}) => (url: string): FetchResult => {
    if (url === OSV_BATCH) return json({ results })
    if (url.startsWith(OSV_VULN)) return json(details[decodeURIComponent(url.slice(OSV_VULN.length))] ?? {})
    if (url === OFFICIAL_MARKETPLACE) return json({ plugins: [{ name: 'code-review' }, { name: 'github' }] })
    return json({}, 404)
  }

  test('malware fails, whether filed as MAL or as an advisory marked CWE-506', async () => {
    const ctx = await ctxOf({ '.mcp.json': b64(JSON.stringify({ mcpServers: { a: { command: 'npx', args: ['-y', 'crossenv'] }, b: { command: 'npx', args: ['-y', 'evil@1.0.0'] } } })) })
    const results = await outsideLookups(netHost(osv([{ vulns: [{ id: 'GHSA-c2m4-w5hm-vqjw' }] }, { vulns: [{ id: 'MAL-2025-1' }] }], { 'GHSA-c2m4-w5hm-vqjw': { id: 'GHSA-c2m4-w5hm-vqjw', database_specific: { cwe_ids: ['CWE-506'] } } })), ctx)
    const row = results.find(result => result.id === 'provenance.packages')
    expect(row?.status).toBe('fail')
    expect(row?.evidence.filter(item => item.status === 'fail')).toHaveLength(2)
  })

  test('a pinned version with advisories warns; an unpinned one only counts malware', async () => {
    const ctx = await ctxOf({ '.mcp.json': b64(JSON.stringify({ mcpServers: { a: { command: 'npx', args: ['-y', 'old@1.0.0'] }, b: { command: 'npx', args: ['-y', 'any'] } } })) })
    const details = { 'GHSA-aaaa-bbbb-cccc': { id: 'GHSA-aaaa-bbbb-cccc', summary: 'ReDoS in old' }, 'GHSA-dddd-eeee-ffff': { id: 'GHSA-dddd-eeee-ffff', summary: 'Prototype pollution in any' } }
    const results = await outsideLookups(netHost(osv([{ vulns: [{ id: 'GHSA-aaaa-bbbb-cccc' }] }, { vulns: [{ id: 'GHSA-dddd-eeee-ffff' }] }], details)), ctx)
    const row = results.find(result => result.id === 'provenance.packages')
    expect(row?.status).toBe('warn')
    expect(row?.evidence).toHaveLength(1)
  })

  test('a name one letter from an official plugin warns; the same name is noted', async () => {
    const near = await outsideLookups(netHost(osv([])), await ctxOf({ '.claude-plugin/plugin.json': b64(JSON.stringify({ name: 'code-reveiw', version: '1.0.0', license: 'MIT' })) }))
    expect(status(near, 'provenance.names')).toBe('warn')
    const same = await outsideLookups(netHost(osv([])), await ctxOf({ '.claude-plugin/plugin.json': b64(JSON.stringify({ name: 'github', version: '1.0.0', license: 'MIT' })) }))
    expect(status(same, 'provenance.names')).toBe('info')
    const far = await outsideLookups(netHost(osv([])), await ctxOf({}))
    expect(status(far, 'provenance.names')).toBe('pass')
  })

  test('a lookup that fails is noted, never a failure', async () => {
    const ctx = await ctxOf({ '.mcp.json': b64(JSON.stringify({ mcpServers: { a: { command: 'npx', args: ['-y', 'x@1.0.0'] } } })) })
    const results = await outsideLookups(netHost(() => new Error('offline')), ctx)
    expect(results.map(result => result.status)).toEqual(['info', 'info'])
  })
})

describe('the outsideLookups setting', () => {
  const ROOT = '/work/candidate'
  const files = { ...fixture('clean-plugin'), '.mcp.json': b64(JSON.stringify({ mcpServers: { a: { command: 'npx', args: ['-y', 'x@1.0.0'] } } })) }

  test('off by default: nothing is sent', async ($, on) => {
    const asked: string[] = []
    on('http.fetch', ($, e) => (asked.push(e.url), { value: { status: 500, ok: false, headers: {}, text: '' } }))
    mock.store(on)
    serveUi(on)
    serveFixture(on, ROOT, files)
    const answer = await $.command.run(typed('guard', `scan --details ${ROOT}`))
    expect(asked).toEqual([])
    expect(answer.text).not.toContain('Known malicious or vulnerable packages')
  })

  test('on: the packages are looked up', { options: { outsideLookups: true } }, async ($, on) => {
    const asked: string[] = []
    on('http.fetch', ($, e) => {
      asked.push(e.url)
      return { value: { status: 200, ok: true, headers: {}, text: e.url === OSV_BATCH ? JSON.stringify({ results: [{ vulns: [{ id: 'MAL-2025-9' }] }] }) : JSON.stringify({ plugins: [] }) } }
    })
    mock.store(on)
    serveUi(on)
    serveFixture(on, ROOT, files)
    const answer = await $.command.run(typed('guard', `scan --details ${ROOT}`))
    expect(asked).toContain(OSV_BATCH)
    expect(answer.text).toContain('Uses a package listed as malware: x@1.0.0 (npm)')
  })
})

describe('lookups, local review fixes', () => {
  const ctxOf = async (files: FixtureFiles) => buildContext(await takeInventory(memoryHost('/p', { ...fixture('clean-plugin'), ...files }), '/p'))
  const mcp = (servers: Record<string, unknown>) => ({ '.mcp.json': b64(JSON.stringify({ mcpServers: servers })) })

  test('runner options with values do not hide the package', async () => {
    const ctx = await ctxOf(mcp({
      a: { command: 'uvx', args: ['--python', '3.12', 'notes-mcp'] },
      b: { command: 'uvx', args: ['--from', 'notes-tools==1.0.0', 'notes'] },
      c: { command: 'npx', args: ['-y', '--package=@acme/cli@2.0.0', 'acme'] },
      d: { command: 'pipx', args: ['run', '--spec', 'tool==3.0.0', 'tool'] },
    }))
    expect(packagesOf(ctx).map(pkg => `${pkg.name}@${pkg.version ?? '*'}`)).toEqual(['notes-mcp@*', 'notes-tools@1.0.0', '@acme/cli@2.0.0', 'tool@3.0.0'])
  })

  test('development packages a lockfile pins are looked up too', async () => {
    const ctx = await ctxOf({
      'package.json': b64(JSON.stringify({ name: 'x', devDependencies: { typescript: '^5.9.3' } })),
      'package-lock.json': b64(JSON.stringify({ packages: { 'node_modules/typescript': { version: '5.9.3' } } })),
    })
    expect(packagesOf(ctx).map(pkg => `${pkg.name}@${pkg.version}:${pkg.via}`)).toEqual(['typescript@5.9.3:for development'])
  })

  test('an advisory whose details cannot be read is not cleared', async () => {
    const ctx = await ctxOf(mcp({ a: { command: 'npx', args: ['-y', 'unpinned-tool'] } }))
    const answers = (url: string): FetchResult | Error => {
      if (url === OSV_BATCH) return json({ results: [{ vulns: [{ id: 'GHSA-aaaa-bbbb-cccc' }] }] })
      if (url.startsWith(OSV_VULN)) return new Error('timed out')
      return json({ plugins: [] })
    }
    const row = (await outsideLookups(netHost(answers), ctx)).find(result => result.id === 'provenance.packages')
    expect(row?.status).toBe('warn')
    expect(row?.evidence[0]?.excerpt).toContain('may be malware')
  })

  test('a reply that does not cover every package is not trusted', async () => {
    const ctx = await ctxOf(mcp({ a: { command: 'npx', args: ['-y', 'one@1.0.0'] }, b: { command: 'npx', args: ['-y', 'two@1.0.0'] } }))
    const answers = (url: string): FetchResult => (url === OSV_BATCH ? json({ results: [{}] }) : json({ plugins: [] }))
    const row = (await outsideLookups(netHost(answers), ctx)).find(result => result.id === 'provenance.packages')
    expect(row?.status).toBe('info')
    expect(row?.summary?.[0]).toContain('does not cover every package')
  })

  test('a large manifest is looked up in batches, all of it', async () => {
    const deps = Object.fromEntries(Array.from({ length: 1500 }, (_, index) => [`pkg-${index}`, '1.0.0']))
    const ctx = await ctxOf({ 'package.json': b64(JSON.stringify({ name: 'x', dependencies: deps })) })
    let batches = 0
    const answers = (url: string, init?: FetchInit): FetchResult => {
      if (url !== OSV_BATCH) return json({ plugins: [] })
      batches += 1
      const queries = (JSON.parse(init?.body ?? '{}') as { queries: unknown[] }).queries
      return json({ results: queries.map((_, index) => (batches === 2 && index === 499 ? { vulns: [{ id: 'MAL-2026-1' }] } : {})) })
    }
    const row = (await outsideLookups(netHost(answers), ctx)).find(result => result.id === 'provenance.packages')
    expect(batches).toBe(2)
    expect(row?.status).toBe('fail')
  })

  test('the name summary stays short however many names are near', async () => {
    const plugins = Array.from({ length: 40 }, (_, index) => ({ name: `code-reveiw-${index}`, source: `./p${index}` }))
    const ctx = await ctxOf({ '.claude-plugin/marketplace.json': b64(JSON.stringify({ name: 'm', owner: { name: 'o' }, plugins })) })
    const official = { plugins: Array.from({ length: 40 }, (_, index) => ({ name: `code-review-${index}` })) }
    const row = (await outsideLookups(netHost(url => (url === OFFICIAL_MARKETPLACE ? json(official) : json({ results: [] }))), ctx)).find(result => result.id === 'provenance.names')
    expect(row?.status).toBe('warn')
    expect(row?.summary?.[0]).toContain('and 37 more')
  })
})

describe('GitHub lookups, local review fixes', () => {
  test('counts GitHub did not give are not taken as low', async () => {
    const answers = (url: string): FetchResult => {
      const path = url.replace('https://api.github.com', '')
      if (path === '/repos/acme/notes') return json({ created_at: daysAgo(3), owner: { login: 'acme' }, default_branch: 'main' })
      if (path === '/users/acme') return json({ created_at: daysAgo(3000) })
      return json({ message: 'Server Error' }, 500)
    }
    const results = await githubProvenance(netHost(answers), SOURCE, NOW)
    expect(status(results, 'provenance.repository')).toBe('info')
    // A commit lookup that failed says so rather than looking complete.
    expect(results[1]?.evidence[0]?.excerpt).toBe('not checked: GitHub answered 500')
  })

  test('a compare that does not answer is reported as not checked', async () => {
    const base = github({ repoDays: 900, ownerDays: 3000, stars: 5, people: 2 })
    const answers = (url: string): FetchResult => (url.includes('/compare/') ? json({ message: 'Server Error' }, 500) : base(url))
    const results = await githubProvenance(netHost(answers), { ...SOURCE, refKind: 'commit' }, NOW)
    expect(results[1]?.evidence.map(item => item.excerpt)).toContain('whether it is on the default branch was not checked: GitHub answered 500')
  })
})

describe('a later OSV batch that fails', () => {
  test('keeps what earlier batches found, and says what was not looked up', async () => {
    const deps = Object.fromEntries(Array.from({ length: 1500 }, (_, index) => [`pkg-${index}`, '1.0.0']))
    const ctx = buildContext(await takeInventory(memoryHost('/p', { ...fixture('clean-plugin'), 'package.json': b64(JSON.stringify({ name: 'x', dependencies: deps })) }), '/p'))
    let batches = 0
    const answers = (url: string, init?: FetchInit): FetchResult | Error => {
      if (url !== OSV_BATCH) return json({ plugins: [] })
      batches += 1
      if (batches === 2) return new Error('reset')
      const queries = (JSON.parse(init?.body ?? '{}') as { queries: unknown[] }).queries
      return json({ results: queries.map((_, index) => (index === 3 ? { vulns: [{ id: 'MAL-2026-2' }] } : {})) })
    }
    const row = (await outsideLookups(netHost(answers), ctx)).find(result => result.id === 'provenance.packages')
    expect(row?.status).toBe('fail')
    expect(row?.summary?.[1]).toBe('Checked 1000 packages against OSV; 500 more were not looked up (could not reach OSV: reset)')
  })
})

describe('lookups, PR #9 review fixes', () => {
  const ctxOf = async (files: FixtureFiles) => buildContext(await takeInventory(memoryHost('/p', { ...fixture('clean-plugin'), ...files }), '/p'))
  const mcp = (servers: Record<string, unknown>) => ({ '.mcp.json': b64(JSON.stringify({ mcpServers: servers })) })
  const names = async (servers: Record<string, unknown>) => packagesOf(await ctxOf(mcp(servers))).map(pkg => `${pkg.name}@${pkg.version ?? '*'}`)
  const table = (batch: (queries: unknown[]) => unknown, details: Record<string, unknown> = {}, official: unknown = { plugins: [] }) => (url: string, init?: FetchInit): FetchResult => {
    if (url === OSV_BATCH) return json({ results: batch((JSON.parse(init?.body ?? '{}') as { queries: unknown[] }).queries) })
    if (url.startsWith(OSV_VULN)) {
      const id = decodeURIComponent(url.slice(OSV_VULN.length))
      return json(details[id] ?? { id, summary: 'An ordinary bug' })
    }
    if (url === OFFICIAL_MARKETPLACE) return json(official)
    return json({}, 404)
  }
  const packagesRow = async (ctx: Awaited<ReturnType<typeof ctxOf>>, answers: ReturnType<typeof table>) => (await outsideLookups(netHost(answers), ctx)).find(result => result.id === 'provenance.packages')

  test('an option with a file does not hide the package, and --with only adds one', async () => {
    expect(await names({ a: { command: 'uvx', args: ['--with-requirements', 'requirements.txt', 'ruff'] } })).toEqual(['ruff@*'])
    expect(await names({ a: { command: 'uvx', args: ['--with', 'requests', 'evil-tool'] } })).toEqual(['requests@*', 'evil-tool@*'])
    expect(await names({ a: { command: 'npx', args: ['-p', '@acme/cli@1.0.0', 'acme'] } })).toEqual(['@acme/cli@1.0.0'])
    expect(await names({ a: { command: 'uvx', args: ['-p', '3.12', 'tool'] } })).toEqual(['tool@*'])
  })

  test('Python extras name the same package', async () => {
    expect(await names({ a: { command: 'uvx', args: ['httpx[cli]==0.27.0'] } })).toEqual(['httpx@0.27.0'])
  })

  test('an empty advisory answer leaves it unresolved', async () => {
    const ctx = await ctxOf(mcp({ a: { command: 'npx', args: ['-y', 'unpinned'] } }))
    const row = await packagesRow(ctx, table(() => [{ vulns: [{ id: 'GHSA-aaaa-bbbb-cccc' }] }], { 'GHSA-aaaa-bbbb-cccc': {} }))
    expect(row?.status).toBe('warn')
    expect(row?.evidence[0]?.excerpt).toContain('may be malware')
  })

  test('an advisory far down the list is still read for malware', async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `GHSA-${String(index).padStart(4, '0')}-bbbb-cccc`)
    const ctx = await ctxOf(mcp({ a: { command: 'npx', args: ['-y', 'busy@1.0.0'] } }))
    const malware = ids[44] as string
    const row = await packagesRow(ctx, table(() => [{ vulns: ids.map(id => ({ id })) }], { [malware]: { id: malware, database_specific: { cwe_ids: ['CWE-506'] } } }))
    expect(row?.status).toBe('fail')
  })

  test('a package whose answer is not an object counts as not looked up', async () => {
    const ctx = await ctxOf(mcp({ a: { command: 'npx', args: ['-y', 'one@1.0.0'] }, b: { command: 'npx', args: ['-y', 'two@1.0.0'] } }))
    const row = await packagesRow(ctx, table(() => [{}, null]))
    expect(row?.summary?.at(-1)).toContain('1 more was not looked up')
  })

  test('every marketplace name is compared', async () => {
    const plugins = Array.from({ length: 250 }, (_, index) => ({ name: index === 240 ? 'code-reveiw' : `plugin-${index}`, source: `./p${index}` }))
    const ctx = await ctxOf({ '.claude-plugin/marketplace.json': b64(JSON.stringify({ name: 'm', owner: { name: 'o' }, plugins })) })
    const results = await outsideLookups(netHost(table(() => [], {}, { plugins: [{ name: 'code-review' }] })), ctx)
    expect(status(results, 'provenance.names')).toBe('warn')
  })

  const marketplace = (count: number, extra: FixtureFiles = {}) => {
    const files: FixtureFiles = {
      ...fixture('clean-plugin'),
      '.claude-plugin/marketplace.json': b64(JSON.stringify({ name: 'm', owner: { name: 'o' }, plugins: Array.from({ length: count }, (_, index) => ({ name: `p${index}`, source: `./plugins/p${index}` })) })),
      ...extra,
    }
    for (let index = 0; index < count; index += 1) {
      for (const [path, file] of Object.entries(fixture('clean-plugin'))) files[`plugins/p${index}/${path}`] = file
      files[`plugins/p${index}/.mcp.json`] = b64(JSON.stringify({ mcpServers: { s: { command: 'npx', args: ['-y', `shared@1.0.0`] } } }))
    }
    return files
  }

  test('a scan asks the official list once, and each advisory once, however many plugins it lists', async () => {
    const host = Object.assign(memoryHost('/m', marketplace(3)), { fetch: async (url: string, init?: FetchInit) => (asked.push(url), table(() => [{ vulns: [{ id: 'GHSA-same-same-same' }] }])(url, init)) })
    const asked: string[] = []
    await scanFolder(host, 'm', '/m', { validate: false, lookups: true })
    expect(asked.filter(url => url === OFFICIAL_MARKETPLACE)).toHaveLength(1)
    expect(asked.filter(url => url.startsWith(OSV_VULN))).toHaveLength(1)
  })

  test("a listed plugin's malware gives the marketplace's package row its reason", async () => {
    const files = marketplace(1, { 'package.json': b64(JSON.stringify({ name: 'm', dependencies: { old: '1.0.0' } })) })
    const host = Object.assign(memoryHost('/m', files), {
      fetch: async (url: string, init?: FetchInit) =>
        table(queries => queries.map(query => ((query as { package: { name: string } }).package.name === 'shared' ? { vulns: [{ id: 'MAL-2026-3' }] } : { vulns: [{ id: 'GHSA-old0-old0-old0' }] })))(url, init),
    })
    const report = await scanFolder(host, 'm', '/m', { validate: false, lookups: true })
    const row = report.results.find(result => result.id === 'provenance.packages')
    expect(row?.status).toBe('fail')
    expect(row?.summary?.[0]).toBe('plugins/p0: Uses a package listed as malware: shared@1.0.0 (npm)')
  })
})

describe('GitHub, PR #9 review fixes', () => {
  test("a request that fails late keeps the warnings already found", async () => {
    const base = github({ repoDays: 900, ownerDays: 4, stars: 120, people: 6 })
    const answers = (url: string): FetchResult | Error => (url.includes('/contributors') || url.includes('/commits/') ? new Error('reset by peer') : base(url))
    const results = await githubProvenance(netHost(answers), SOURCE, NOW)
    expect(status(results, 'provenance.repository')).toBe('warn')
    expect(results[0]?.evidence.map(item => item.excerpt)).toContain('not checked, its contributors: could not reach GitHub: reset by peer')
    expect(results[1]?.evidence[0]?.excerpt).toContain('not checked')
  })
})

describe('lookups, local review of the release', () => {
  const ctxOf = async (files: FixtureFiles) => buildContext(await takeInventory(memoryHost('/p', { ...fixture('clean-plugin'), ...files }), '/p'))

  test('a package that merely ends like a file is still a package', async () => {
    const ctx = await ctxOf({ '.mcp.json': b64(JSON.stringify({ mcpServers: { a: { command: 'npx', args: ['-y', 'foo.json'] }, b: { command: 'uvx', args: ['./local/tool'] } } })) })
    expect(packagesOf(ctx).map(pkg => pkg.name)).toEqual(['foo.json'])
  })

  test('a huge marketplace is compared up to the limit, and the rest is reported', async () => {
    const plugins = Array.from({ length: 2100 }, (_, index) => ({ name: `plugin-${index}`, source: `./p${index}` }))
    const ctx = await ctxOf({ '.claude-plugin/marketplace.json': b64(JSON.stringify({ name: 'm', owner: { name: 'o' }, plugins })) })
    const results = await outsideLookups(netHost(url => (url === OFFICIAL_MARKETPLACE ? json({ plugins: [{ name: 'code-review' }] }) : json({ results: [] }))), ctx)
    const row = results.find(result => result.id === 'provenance.names')
    expect(row?.status).toBe('warn')
    expect(row?.evidence.map(item => item.excerpt)).toContain('101 more names were not compared')
  })
})

describe('lookups, PR #11 review fixes', () => {
  const ctxOf = async (files: FixtureFiles) => buildContext(await takeInventory(memoryHost('/p', { ...fixture('clean-plugin'), ...files }), '/p'))
  const names = async (servers: Record<string, unknown>) => packagesOf(await ctxOf({ '.mcp.json': b64(JSON.stringify({ mcpServers: servers })) })).map(pkg => pkg.name)

  test('a local path or git spec is what runs, and its arguments are not packages', async () => {
    expect(await names({ a: { command: 'npx', args: ['./server.js', 'stdio'] } })).toEqual([])
    expect(await names({ a: { command: 'npx', args: ['github:me/tool', 'start'] } })).toEqual([])
    expect(await names({ a: { command: 'uvx', args: ['--with-requirements', 'r.txt', './app', 'serve'] } })).toEqual([])
    expect(await names({ a: { command: 'npx', args: ['-y', '@scope/tool@1.0.0', 'start'] } })).toEqual(['@scope/tool'])
  })

  test('names left uncompared are not called look-alikes', async () => {
    const plugins = Array.from({ length: 2100 }, (_, index) => ({ name: `plugin-${index}`, source: `./p${index}` }))
    const ctx = await ctxOf({ '.claude-plugin/marketplace.json': b64(JSON.stringify({ name: 'm', owner: { name: 'o' }, plugins })) })
    const results = await outsideLookups(netHost(url => (url === OFFICIAL_MARKETPLACE ? json({ plugins: [{ name: 'code-review' }] }) : json({ results: [] }))), ctx)
    const row = results.find(result => result.id === 'provenance.names')
    expect(row?.summary).toEqual(['101 more names were not compared with the official list'])
  })

  test('a late GitHub failure is said in the summary', async () => {
    const base = github({ repoDays: 900, ownerDays: 3000, stars: 120, people: 6 })
    const answers = (url: string): FetchResult | Error => (url.includes('/contributors') ? new Error('reset by peer') : base(url))
    const results = await githubProvenance(netHost(answers), SOURCE, NOW)
    expect(results[0]?.summary?.at(-1)).toBe('Not checked: its contributors: could not reach GitHub: reset by peer')
  })
})

describe('lookups, PR #11 review round two', () => {
  test('a look-alike and names left uncompared are both in the headline, and the count survives the cap', async () => {
    const plugins = Array.from({ length: 2100 }, (_, index) => ({ name: index < 30 ? `code-reveiw-${index}` : `plugin-${index}`, source: `./p${index}` }))
    const ctx = buildContext(await takeInventory(memoryHost('/p', { ...fixture('clean-plugin'), '.claude-plugin/marketplace.json': b64(JSON.stringify({ name: 'm', owner: { name: 'o' }, plugins })) }), '/p'))
    const official = { plugins: Array.from({ length: 30 }, (_, index) => ({ name: `code-review-${index}` })) }
    const results = await outsideLookups(netHost(url => (url === OFFICIAL_MARKETPLACE ? json(official) : json({ results: [] }))), ctx)
    const row = results.find(result => result.id === 'provenance.names')
    expect(row?.summary?.[0]).toContain('; 101 more names were not compared with the official list')
    expect(row?.evidence.map(item => item.excerpt)).toContain('101 more names were not compared')
  })
})

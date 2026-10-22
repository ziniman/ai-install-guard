// What GitHub says about a repository the guard fetched from it: how old it
// and its owner are, how many people work on it, and whether the scanned
// commit is signed and part of the repository's own history. GitHub is the
// host the code came from, so asking it reveals nothing new. Every answer is
// information only, except a brand-new repository or account, and a commit
// that is not on the default branch, which are warnings. A failed lookup is
// noted and never fails the scan.

import { row, type CheckResult, type Evidence, type Status } from './checks/types'
import type { FetchResult, Host } from './host'
import type { PinnedSource } from './remote'
import { safeLine } from './safe-text'

const API = 'https://api.github.com'
const HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ai-install-guard' }
const DAY = 24 * 60 * 60 * 1000
/** Younger than this, a repository or an account is worth a warning. */
const NEW_DAYS = 30

type Json = Record<string, unknown>

class LookupError extends Error {}

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** owner/repo for a github.com source, or undefined for any other host. */
export function githubRepo(url: string): { owner: string; repo: string } | undefined {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/.exec(url)
  return match === null ? undefined : { owner: match[1] as string, repo: match[2] as string }
}

async function api(host: Host, path: string): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  if (host.fetch === undefined) throw new LookupError('no network here')
  let answer: FetchResult
  try {
    answer = await host.fetch(`${API}${path}`, { headers: HEADERS })
  } catch (error) {
    throw new LookupError(`could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`)
  }
  if ((answer.status === 403 || answer.status === 429) && (answer.headers['x-ratelimit-remaining'] === '0' || answer.status === 429)) {
    throw new LookupError("GitHub's limit for lookups without an account was reached; try again within the hour")
  }
  let body: unknown
  try {
    body = JSON.parse(answer.text)
  } catch {
    body = undefined
  }
  return { status: answer.status, body, headers: answer.headers }
}

function age(iso: unknown, now: number): number | undefined {
  if (typeof iso !== 'string') return undefined
  const time = Date.parse(iso)
  return Number.isNaN(time) ? undefined : Math.max(0, Math.floor((now - time) / DAY))
}

function spoken(days: number): string {
  if (days < 1) return 'today'
  if (days < 60) return `${days} day${days === 1 ? '' : 's'} ago`
  if (days < 730) return `${Math.round(days / 30)} months ago`
  return `${Math.round(days / 365)} years ago`
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** How many contributors, from the last page number of a one-per-page listing. */
async function contributors(host: Host, path: string): Promise<number | undefined> {
  const answer = await api(host, `${path}/contributors?per_page=1&anon=1`)
  if (answer.status === 204) return 0
  if (answer.status !== 200) return undefined
  const last = /[?&]page=(\d+)>;\s*rel="last"/.exec(answer.headers.link ?? '')
  if (last !== null) return Number(last[1])
  return Array.isArray(answer.body) ? answer.body.length : undefined
}

export async function githubProvenance(host: Host, source: PinnedSource, now = Date.now()): Promise<CheckResult[]> {
  const repo = githubRepo(source.url)
  if (repo === undefined || host.fetch === undefined) return []
  const path = `/repos/${repo.owner}/${repo.repo}`
  try {
    return await lookups(host, path, source, now)
  } catch (error) {
    const reason = error instanceof LookupError ? error.message : `the lookup failed: ${error instanceof Error ? error.message : String(error)}`
    return [
      {
        id: 'provenance.repository',
        group: 'provenance',
        title: 'Repository and its owner',
        status: 'info',
        severity: 'none',
        evidence: [{ file: '-', excerpt: `not checked: ${safeLine(reason)}`, status: 'info' }],
        advice: "The repository's history could not be read, so the verdict rests on the code alone.",
        summary: [`Not checked: ${safeLine(reason)}`],
      },
    ]
  }
}

async function lookups(host: Host, path: string, source: PinnedSource, now: number): Promise<CheckResult[]> {
  const repoAnswer = await api(host, path)
  if (repoAnswer.status === 404) throw new LookupError('GitHub does not show this repository')
  if (repoAnswer.status !== 200 || !isJson(repoAnswer.body)) throw new LookupError(`GitHub answered ${repoAnswer.status}`)
  const info = repoAnswer.body
  const owner = isJson(info.owner) ? info.owner : {}
  const login = typeof owner.login === 'string' ? owner.login : undefined
  const ownerAnswer = login === undefined ? undefined : await api(host, `/users/${encodeURIComponent(login)}`)
  const ownerInfo = ownerAnswer !== undefined && ownerAnswer.status === 200 && isJson(ownerAnswer.body) ? ownerAnswer.body : {}
  const people = await contributors(host, path)

  const repoDays = age(info.created_at, now)
  const ownerDays = age(ownerInfo.created_at, now)
  const pushedDays = age(info.pushed_at, now)
  const stars = count(info.stargazers_count)
  const forks = count(info.forks_count)
  const who = `${typeof owner.type === 'string' && owner.type === 'Organization' ? 'organization' : 'account'} ${safeLine(login ?? 'unknown')}`

  // The warning signs: an account made days ago, or a new repository with a
  // single author that hardly anyone uses. A new repository from an
  // established account, with others working on it, is only noted.
  const newAccount = ownerDays !== undefined && ownerDays < NEW_DAYS
  const loneNewRepo = repoDays !== undefined && repoDays < NEW_DAYS && (people ?? 1) <= 1 && (stars ?? 0) < 10
  const evidence: Evidence[] = []
  const note = (excerpt: string, status: Status = 'info') => evidence.push({ file: '-', excerpt, status })
  if (repoDays !== undefined) note(`created ${spoken(repoDays)}${loneNewRepo ? ', with a single contributor and few stars' : ''}`, loneNewRepo ? 'warn' : 'info')
  if (ownerDays !== undefined) note(`owned by the ${who}, created ${spoken(ownerDays)}`, newAccount ? 'warn' : 'info')
  note(`${stars ?? '?'} stars, ${forks ?? '?'} forks, ${people ?? '?'} contributor${people === 1 ? '' : 's'}`)
  if (pushedDays !== undefined) note(`last pushed ${spoken(pushedDays)}`)
  if (info.archived === true) note('archived: it gets no more fixes')
  if (info.fork === true) {
    const parent = isJson(info.parent) && typeof info.parent.full_name === 'string' ? safeLine(info.parent.full_name) : 'another repository'
    note(`a fork of ${parent}: compare it with the original`)
  }

  const young = [
    loneNewRepo && repoDays !== undefined ? `the repository is ${spoken(repoDays).replace(' ago', ' old')}, with one contributor and few stars` : '',
    newAccount && ownerDays !== undefined ? `its owner's account is ${spoken(ownerDays).replace(' ago', ' old')}` : '',
  ].filter(text => text !== '')
  const summary = [
    young.length > 0
      ? `New: ${young.join(' and ')}`
      : `${repoDays === undefined ? 'A repository' : `Created ${spoken(repoDays)}`} by the ${who}${ownerDays === undefined ? '' : ` (on GitHub since ${spoken(ownerDays)})`}`,
    `${stars ?? '?'} stars, ${forks ?? '?'} forks, ${people ?? '?'} contributor${people === 1 ? '' : 's'}${pushedDays === undefined ? '' : `; last pushed ${spoken(pushedDays)}`}`,
  ]
  const repository = row(
    {
      id: 'provenance.repository',
      group: 'provenance',
      title: 'Repository and its owner',
      advice: 'A brand-new repository or account has no track record. Most are honest, but most malicious plugins are new too: look closer before you trust one.',
      summary,
    },
    evidence,
    'info',
  )

  // The scanned commit: signed, and part of the repository's own history.
  const commitEvidence: Evidence[] = []
  const commit = await api(host, `${path}/commits/${source.sha}`)
  if (commit.status === 200 && isJson(commit.body) && isJson(commit.body.commit)) {
    const verification = isJson(commit.body.commit.verification) ? commit.body.commit.verification : {}
    const committer = isJson(commit.body.commit.committer) ? commit.body.commit.committer : {}
    const committedDays = age(committer.date, now)
    commitEvidence.push({
      file: '-',
      excerpt: verification.verified === true ? 'signed, and GitHub verified the signature' : 'not signed, or the signature could not be verified',
      status: 'info',
    })
    if (committedDays !== undefined) commitEvidence.push({ file: '-', excerpt: `committed ${spoken(committedDays)}`, status: 'info' })
  } else if (commit.status === 404 || commit.status === 422) {
    commitEvidence.push({ file: '-', excerpt: 'GitHub does not show this commit in this repository', status: 'warn' })
  }
  // A commit named by id could come from a fork in the same network (an
  // "impostor commit"); one reached through a branch or tag cannot.
  const defaultBranch = typeof info.default_branch === 'string' ? info.default_branch : undefined
  if (source.refKind === 'commit' && defaultBranch !== undefined && commit.status === 200) {
    const compared = await api(host, `${path}/compare/${encodeURIComponent(defaultBranch)}...${source.sha}`)
    const status = isJson(compared.body) && typeof compared.body.status === 'string' ? compared.body.status : undefined
    if (status === 'behind' || status === 'identical') commitEvidence.push({ file: '-', excerpt: `part of the default branch ${safeLine(defaultBranch)}`, status: 'info' })
    else if (status !== undefined) commitEvidence.push({ file: '-', excerpt: `not on the default branch ${safeLine(defaultBranch)}: it may come from another branch or from a fork`, status: 'warn' })
  }
  const commitRow = row(
    {
      id: 'provenance.commit',
      group: 'provenance',
      title: 'The scanned commit',
      advice: "A commit named by its id can come from any fork of the repository, since GitHub serves them all from one place. Prefer one on the default branch or behind a release tag.",
      summary: commitEvidence.length > 0 ? [commitEvidence.map(item => item.excerpt).join('; ').replace(/^./, char => char.toUpperCase())] : undefined,
    },
    commitEvidence,
    'info',
  )
  return [repository, commitRow]
}

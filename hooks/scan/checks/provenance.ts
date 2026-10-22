import { isRecord, parseJson, type ScanContext } from './context'
import { joinPath } from './text'
import { capEvidence, row, type CheckResult, type Evidence } from './types'

const GROUP = 'provenance' as const
const MARKETPLACE = '.claude-plugin/marketplace.json'
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const SPECIAL_REFS = /^(?:HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD|BISECT_HEAD|AUTO_MERGE)$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/

/**
 * Group 1, for a marketplace: whether each plugin it lists from elsewhere is
 * pinned to one commit (or one package version). A plugin that follows a
 * branch installs whatever the branch holds that day, not what was reviewed.
 */
export function marketplacePinsCheck(ctx: ScanContext): CheckResult[] {
  const parsed = parseJson(ctx.text(MARKETPLACE))
  if (!parsed.ok || !isRecord(parsed.value) || !Array.isArray(parsed.value.plugins)) return []
  const evidence: Evidence[] = []
  for (const plugin of parsed.value.plugins) {
    if (!isRecord(plugin)) continue
    const name = typeof plugin.name === 'string' ? plugin.name : '(unnamed)'
    const judged = judgeSource(plugin.source)
    if (judged !== undefined) evidence.push({ file: MARKETPLACE, excerpt: `${name}: ${judged.what}`, status: judged.status })
  }
  if (evidence.length === 0) return []
  return [
    row(
      {
        id: 'provenance.pins',
        group: GROUP,
        title: 'Marketplace pins',
        advice: 'Pin each plugin to a full commit id (sha) or an exact package version. A branch, a tag or a commit given as ref can change what installs after it was reviewed.',
      },
      // Every entry is judged; only the worst are listed.
      capEvidence(evidence, 30),
    ),
  ]
}

function judgeSource(source: unknown): { what: string; status: 'pass' | 'warn' | 'fail' } | undefined {
  if (typeof source === 'string') {
    // A folder in the marketplace is pinned with the marketplace itself; one
    // that climbs out of it is not part of what was pinned.
    if (source.startsWith('./') || source.startsWith('../')) {
      return joinPath('', source) === undefined ? { what: `comes from ${source}, outside the marketplace, which is not pinned with it`, status: 'warn' } : undefined
    }
    return { what: `comes from ${source} and follows its default branch`, status: 'warn' }
  }
  if (!isRecord(source)) return undefined
  const kind = typeof source.source === 'string' ? source.source : 'unknown'
  if (kind === 'npm' || kind === 'pip') {
    const version = typeof source.version === 'string' ? source.version : undefined
    const pkg = typeof source.package === 'string' ? source.package : '(package)'
    return version !== undefined && EXACT_VERSION.test(version)
      ? { what: `${kind} package ${pkg} at exactly ${version}`, status: 'pass' }
      : { what: `${kind} package ${pkg} ${version === undefined ? 'at whatever version is newest' : `at ${version}, not one exact version`}`, status: 'warn' }
  }
  const where = typeof source.repo === 'string' ? source.repo : typeof source.url === 'string' ? source.url : kind
  const sha = typeof source.sha === 'string' ? source.sha : undefined
  const ref = typeof source.ref === 'string' ? source.ref : undefined
  if (ref !== undefined && SPECIAL_REFS.test(ref)) return { what: `${where} names git's own ${ref} as its ref`, status: 'fail' }
  if (sha !== undefined) {
    return FULL_SHA.test(sha)
      ? { what: `${where} pinned to commit ${sha.slice(0, 12)}`, status: 'pass' }
      : { what: `${where} has sha "${sha.slice(0, 64)}", which is not a full commit id`, status: 'warn' }
  }
  if (ref !== undefined && FULL_SHA.test(ref)) {
    return { what: `${where} gives a commit id as its ref; a branch with that name would be checked out instead, so use sha`, status: 'warn' }
  }
  if (ref !== undefined) return { what: `${where} follows ${ref}, which its owner can move`, status: 'warn' }
  return { what: `${where} follows its default branch`, status: 'warn' }
}

/** What a README's AI Install Guard badge claims, read from its shields.io image. */
export type BadgeClaim = { file: string; line: number; claimed: 'safe' | 'caution' | 'reject' | 'unverified'; text: string }

const BADGE_IMAGE = /img\.shields\.io\/badge\/AI(?:_|%20| )Install(?:_|%20| )Guard-([^)\s"'?]{1,300})/i

/**
 * The first AI Install Guard badge in a README, outside code blocks (where a
 * README shows how to add one). A badge whose words name no verdict is read
 * as claiming the best one, since that is what it would make a reader think.
 */
export function badgeClaim(readme: { path: string; text: string } | undefined): BadgeClaim | undefined {
  if (readme === undefined) return undefined
  let inFence = false
  const lines = readme.text.split('\n')
  for (let index = 0; index < lines.length && index < 5000; index += 1) {
    const line = lines[index] as string
    if (/^[ \t]*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const found = BADGE_IMAGE.exec(line.replace(/`[^`]*`/g, ''))
    if (found === null) continue
    let message = found[1] as string
    try {
      message = decodeURIComponent(message)
    } catch {
      // Left as written.
    }
    const words = message.replace(/--/g, '\u0000').replace(/-[0-9a-f]{3,8}$|-[a-z]+$/i, '').replace(/_/g, ' ').replace(/\u0000/g, '-').toLowerCase()
    const claimed = /do not install/.test(words) ? 'reject' : /could not verify/.test(words) ? 'unverified' : /caution/.test(words) ? 'caution' : 'safe'
    return { file: readme.path, line: index + 1, claimed, text: words.slice(0, 120) }
  }
  return undefined
}

const VERDICT_RANK = { safe: 0, caution: 1, unverified: 2, reject: 3 } as const
const VERDICT_WORDS = { safe: 'Safe to install', caution: 'Install with caution', unverified: 'Could not verify', reject: 'Do not install' } as const

/**
 * The row for a README's badge, judged against this scan's own verdict. A
 * badge never improves a verdict: one that claims better than the scan finds
 * is a warning, one that matches is only noted.
 */
export function badgeRow(claim: BadgeClaim, actual: keyof typeof VERDICT_RANK): CheckResult {
  const overclaims = VERDICT_RANK[claim.claimed] < VERDICT_RANK[actual]
  return row(
    {
      id: 'provenance.badge',
      group: GROUP,
      title: 'Review badge in the README',
      advice: 'A badge is a picture anyone can paste. This scan is what counts: a badge that claims more than it finds is outdated or was never earned.',
      summary: overclaims
        ? [`The README's badge says ${VERDICT_WORDS[claim.claimed]}, but this version scans as ${VERDICT_WORDS[actual]}`, 'The badge is outdated or was never earned']
        : [`The README shows an AI Install Guard badge (${VERDICT_WORDS[claim.claimed]}); this scan agrees`],
    },
    [{ file: claim.file, line: claim.line, excerpt: `badge: ${claim.text}`, status: overclaims ? 'warn' : 'info' }],
  )
}

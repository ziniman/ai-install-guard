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
export type BadgeClaim = {
  file: string
  line: number
  claimed: 'safe' | 'caution' | 'reject' | 'unverified'
  /** The version the badge names: a short commit or `tree <hash>`, when it names one. */
  pin?: string
  text: string
}

const BADGE_IMAGE = /img\.shields\.io\/badge\/AI(?:_|%20| )Install(?:_|%20| )Guard-([^)\s"'?]{1,300})/gi
const HTML_BLOCK_START = /^ {0,3}<\/?[A-Za-z][\w-]*(?:\s|\/?>|$)/

/**
 * The strongest claim among the AI Install Guard badges a README shows, read
 * the way a Markdown renderer shows it: fenced and indented code blocks and
 * HTML comments are left out (there a badge is an example or hidden), while
 * HTML blocks and list items, where badges usually sit indented, count. A
 * badge whose words name no verdict is read as claiming the best one, since
 * that is what it would make a reader think.
 */
export function badgeClaim(readme: { path: string; text: string } | undefined): BadgeClaim | undefined {
  if (readme === undefined) return undefined
  const lines = readme.text.split('\n')
  let fence: { char: string; length: number } | undefined
  let comment = false
  let htmlBlock = false
  let indentedCode = false
  let listContext = false
  let previousBlank = true
  let best: BadgeClaim | undefined
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index] as string
    const blank = line.trim() === ''
    // Inside a list item a fence may sit as deep as the item's own content.
    const fenceIndent = listContext ? '[ \\t]{0,16}' : ' {0,3}'
    if (fence !== undefined) {
      // A fence closes only with its own character, at least as long, and nothing after.
      const close = new RegExp(`^${fenceIndent}(\`{3,}|~{3,})[ \\t]*$`).exec(line)
      if (close !== null && (close[1] as string)[0] === fence.char && (close[1] as string).length >= fence.length) fence = undefined
      continue
    }
    if (comment) {
      const end = line.indexOf('-->')
      if (end === -1) continue
      comment = false
      line = line.slice(end + 3)
    }
    const open = htmlBlock ? null : new RegExp(`^${fenceIndent}(\`{3,}|~{3,})(.*)$`).exec(line)
    // A backtick fence's info string cannot hold a backtick: ```x``` is inline code.
    if (open !== null && !((open[1] as string)[0] === '`' && (open[2] as string).includes('`'))) {
      fence = { char: (open[1] as string)[0] as string, length: (open[1] as string).length }
      continue
    }
    // An HTML comment hides what it holds only when it opens a line; inline,
    // only a closed one is a comment.
    if (/^ {0,3}<!--/.test(line) && !line.includes('-->', line.indexOf('<!--') + 4)) {
      comment = true
      continue
    }
    const indented = /^(?: {4}|\t)/.test(line)
    if (indentedCode && !blank && !indented) indentedCode = false
    if (!indentedCode && indented && previousBlank && !listContext && !htmlBlock) indentedCode = true
    if (htmlBlock && blank) htmlBlock = false
    else if (!htmlBlock && !indentedCode && HTML_BLOCK_START.test(line)) htmlBlock = true
    if (!blank && !indented) listContext = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/.test(line) || (listContext && !previousBlank)
    else if (/^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/.test(line)) listContext = true
    previousBlank = blank
    if (indentedCode) continue
    const shown = line.replace(/<!--[\s\S]*?-->/g, '').replace(/`[^`]*`/g, '')
    for (const found of shown.matchAll(BADGE_IMAGE)) {
      let message = found[1] as string
      try {
        message = decodeURIComponent(message)
      } catch {
        // Left as written.
      }
      const words = message.replace(/--/g, '\u0000').replace(/-[0-9a-f]{3,8}$|-[a-z]+$/i, '').replace(/_/g, ' ').replace(/\u0000/g, '-').toLowerCase()
      const claimed = /do not install/.test(words) ? 'reject' : /could not verify/.test(words) ? 'unverified' : /caution/.test(words) ? 'caution' : 'safe'
      const pin = /·\s*((?:tree\s+)?[0-9a-f]{7,64})\b/.exec(words)?.[1]
      if (best === undefined || VERDICT_RANK[claimed] < VERDICT_RANK[best.claimed]) best = { file: readme.path, line: index + 1, claimed, pin, text: words.slice(0, 120) }
    }
  }
  return best
}

const VERDICT_RANK = { safe: 0, caution: 1, unverified: 2, reject: 3 } as const
const VERDICT_WORDS = { safe: 'Safe to install', caution: 'Install with caution', unverified: 'Could not verify', reject: 'Do not install' } as const

/**
 * The row for a README's badge, judged against this scan's own verdict. A
 * badge never improves a verdict: one that claims better than the scan finds
 * is a warning, one that matches is only noted.
 */
export function badgeRow(claim: BadgeClaim, actual: keyof typeof VERDICT_RANK, version: { sha?: string; treeHash?: string } = {}): CheckResult {
  const overclaims = VERDICT_RANK[claim.claimed] < VERDICT_RANK[actual]
  // Which version the badge names, against the one scanned now.
  const scanned = version.sha !== undefined ? version.sha.slice(0, 7) : version.treeHash !== undefined ? `tree ${version.treeHash.slice(7, 15)}` : undefined
  const sameVersion = claim.pin !== undefined && scanned !== undefined && (claim.pin.startsWith('tree ') ? version.treeHash?.slice(7).startsWith(claim.pin.slice(5)) === true : version.sha?.startsWith(claim.pin) === true)
  const named = claim.pin === undefined ? 'names no version' : sameVersion ? `is for this version (${claim.pin})` : `is for another version (${claim.pin})`
  const summary = overclaims
    ? [`The README's badge says ${VERDICT_WORDS[claim.claimed]}, but this version scans as ${VERDICT_WORDS[actual]}`, `The badge ${named}: it is outdated or was never earned`]
    : sameVersion && claim.claimed === actual
      ? [`The README shows an AI Install Guard badge for this version (${VERDICT_WORDS[claim.claimed]}); this scan agrees`]
      : [`The README's badge says ${VERDICT_WORDS[claim.claimed]} and ${named}; this version scans as ${VERDICT_WORDS[actual]}`]
  return row(
    {
      id: 'provenance.badge',
      group: GROUP,
      title: 'Review badge in the README',
      advice: 'A badge is a picture anyone can paste. This scan is what counts: a badge that claims more than it finds is outdated or was never earned.',
      summary,
    },
    [{ file: claim.file, line: claim.line, excerpt: `badge: ${claim.text}`, status: overclaims ? 'warn' : 'info' }],
  )
}

import { isRecord, parseJson, type ScanContext } from './context'
import { sha256Hex, treeHash } from '../hash'
import type { InventoryEntry } from '../inventory'
import { joinPath } from './text'
import { RECOMMENDATION } from '../verdict'
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

// A source that follows a branch or a newest version is how most marketplaces
// work: noted, since each plugin is scanned at the commit it installs. Only a
// source that can be swapped for another one (git's own ref names, a commit id
// as a ref) is held against it.
function judgeSource(source: unknown): { what: string; status: 'pass' | 'info' | 'warn' | 'fail' } | undefined {
  if (typeof source === 'string') {
    // A folder in the marketplace is pinned with the marketplace itself; one
    // that climbs out of it is not part of what was pinned.
    if (source.startsWith('./') || source.startsWith('../')) {
      return joinPath('', source) === undefined ? { what: `comes from ${source}, outside the marketplace, which is not pinned with it`, status: 'warn' } : undefined
    }
    return { what: `comes from ${source} and follows its default branch`, status: 'info' }
  }
  if (!isRecord(source)) return undefined
  const kind = typeof source.source === 'string' ? source.source : 'unknown'
  if (kind === 'npm' || kind === 'pip') {
    const version = typeof source.version === 'string' ? source.version : undefined
    const pkg = typeof source.package === 'string' ? source.package : '(package)'
    return version !== undefined && EXACT_VERSION.test(version)
      ? { what: `${kind} package ${pkg} at exactly ${version}`, status: 'pass' }
      : { what: `${kind} package ${pkg} ${version === undefined ? 'at whatever version is newest' : `at ${version}, not one exact version`}`, status: 'info' }
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
  if (ref !== undefined) return { what: `${where} follows ${ref}, which its owner can move`, status: 'info' }
  return { what: `${where} follows its default branch`, status: 'info' }
}

/** An AI Install Guard badge's image address, whatever it says. */
const BADGE_URL = String.raw`https?:\/\/img\.shields\.io\/badge\/AI(?:_|%20| )Install(?:_|%20| )Guard-[^)\s"'<>]{0,400}`

/**
 * Every way a README carries the badge: a linked image (what /guard badge
 * gives), a bare image, an HTML image with or without its link, or the
 * definition line of a reference-style image.
 */
const BADGE_CONSTRUCT = new RegExp(
  [
    String.raw`\[\s*!\[[^\]\n]{0,500}\]\(\s*${BADGE_URL}[^)\n]{0,600}\)\s*\]\([^)\n]{0,1000}\)`,
    String.raw`!\[[^\]\n]{0,500}\]\(\s*${BADGE_URL}[^)\n]{0,600}\)`,
    String.raw`<a\b[^>]{0,1000}>\s*<img\b[^>]{0,1000}?${BADGE_URL}[^>]{0,1000}>\s*<\/a\s*>`,
    String.raw`<img\b[^>]{0,1000}?${BADGE_URL}[^>]{0,1000}>`,
    String.raw`^[ \t]{0,3}\[[^\]\n]{1,200}\]:[ \t]*${BADGE_URL}[^\n]{0,600}$`,
  ].join('|'),
  'gim',
)

/**
 * A README as the badge hash reads it: every AI Install Guard badge taken
 * out, then every run of whitespace made one space. Adding a badge, moving it
 * or swapping it for a newer one leaves this unchanged; any other edit does not.
 */
export function withoutBadges(text: string): string {
  return text.replace(BADGE_CONSTRUCT, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * The hash a README badge names: the tree hash, with the README counted
 * without its badges. A badge naming a commit can never match the commit that
 * adds it; this one names the content and stays right in that commit, until
 * anything else changes.
 */
export async function badgeHash(entries: readonly InventoryEntry[], readme: { path: string; text: string } | undefined): Promise<string> {
  if (readme === undefined) return treeHash(entries)
  return treeHash(entries, new Map([[readme.path, await sha256Hex(withoutBadges(readme.text))]]))
}

/** What a README's AI Install Guard badge claims, read from its shields.io image. */
export type BadgeClaim = {
  file: string
  line: number
  claimed: 'safe' | 'caution' | 'reject' | 'unverified'
  /**
   * The version the badge names, when it names one: its content (twelve hex,
   * the badge hash), or, on badges made before 0.4.4, a short commit or
   * `tree <hash>`.
   */
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
      // Older badges' words still count as the verdicts they named then.
      const claimed = /do not install/.test(words) ? 'reject' : /could not verify/.test(words) ? 'unverified' : /caution|review what it can do|worth a look/.test(words) ? 'caution' : 'safe'
      const pin = /·\s*((?:tree\s+)?[0-9a-f]{7,64})\b/.exec(words)?.[1]
      if (best === undefined || VERDICT_RANK[claimed] < VERDICT_RANK[best.claimed]) best = { file: readme.path, line: index + 1, claimed, pin, text: words.slice(0, 120) }
    }
  }
  return best
}

const VERDICT_RANK = { safe: 0, caution: 1, unverified: 2, reject: 3 } as const

/**
 * Whether a badge's pin names the version scanned now: its content (the badge
 * hash, twelve hex or more), or, on older badges, its commit or `tree` hash.
 */
function namesVersion(pin: string, version: { sha?: string; treeHash?: string; badgeHash?: string }): boolean {
  if (pin.startsWith('tree ')) return version.treeHash?.slice(7).startsWith(pin.slice(5)) === true
  if (pin.length >= 12 && version.badgeHash?.slice(7).startsWith(pin) === true) return true
  return version.sha?.startsWith(pin) === true
}
const VERDICT_WORDS = RECOMMENDATION

/**
 * The row for a README's badge, judged against this scan's own verdict. A
 * badge never improves a verdict: one that claims better than the scan finds
 * is a warning, one that matches is only noted.
 */
export function badgeRow(claim: BadgeClaim, actual: keyof typeof VERDICT_RANK, version: { sha?: string; treeHash?: string; badgeHash?: string } = {}): CheckResult {
  const overclaims = VERDICT_RANK[claim.claimed] < VERDICT_RANK[actual]
  const sameVersion = claim.pin !== undefined && namesVersion(claim.pin, version)
  const named = claim.pin === undefined ? 'names no version' : sameVersion ? `is for this version (${claim.pin})` : `is for another version (${claim.pin})`
  const summary = overclaims
    ? [
        `The README's badge says ${VERDICT_WORDS[claim.claimed]}, but this version scans as ${VERDICT_WORDS[actual]}`,
        // A badge for this very version that claims more was never earned; one for another may only be outdated.
        sameVersion ? `The badge ${named}, so it was never earned` : `The badge ${named}: it is outdated or was never earned`,
      ]
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

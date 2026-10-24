import type { GuardView } from '../../types'

/** Where the badge links: what it means and how to check it. */
export const BADGE_PAGE = 'https://github.com/ziniman/ai-install-guard#review-badge'

const COLOR = { safe: '2ea44f', caution: 'dbab09' } as const
const MESSAGE = { safe: 'no red flags', caution: 'worth a look' } as const

/** A shields.io static badge part: dashes and underscores doubled, spaces as underscores. */
function shieldPart(text: string): string {
  return encodeURIComponent(text.replace(/-/g, '--').replace(/_/g, '__').replace(/ /g, '_'))
}

/**
 * The README badge for the last scan: its verdict and the exact version it
 * covers. Offered for No red flags and Worth a look only, and
 * only for a scan that read the files, so it always names what was scanned.
 */
export function badgeFor(view: GuardView | undefined): { markdown: string; pin: string } | { refusal: string } {
  if (view?.verdict === undefined || view.treeHash === undefined) return { refusal: 'Scan something first: /guard scan <path | repository>.' }
  const kind = view.verdict.kind
  if (kind !== 'safe' && kind !== 'caution') return { refusal: `There is no badge for ${view.verdict.recommendation}.` }
  // Only hex from the scan goes into the badge, never text from the candidate.
  const sha = view.sha !== undefined && /^[0-9a-f]{40,64}$/.test(view.sha) ? view.sha : undefined
  const tree = /^sha256:[0-9a-f]{64}$/.test(view.treeHash) ? view.treeHash : undefined
  if (tree === undefined) return { refusal: 'The last scan has no tree hash to pin a badge to.' }
  const pin = sha !== undefined ? sha.slice(0, 7) : `tree ${tree.slice(7, 15)}`
  // A scan of one folder always says so: the rest of the commit was not
  // judged. The view holds the folder percent-encoded, whole, never cut.
  const folder = sha !== undefined ? view.subdir : undefined
  if (folder !== undefined && !/^[\w./%-]{1,400}$/.test(folder)) return { refusal: 'The folder name is too long to show in a badge.' }
  const image = `https://img.shields.io/badge/${shieldPart('AI Install Guard')}-${shieldPart(`${MESSAGE[kind]} · ${pin}`)}-${COLOR[kind]}`
  const scanned = sha !== undefined ? `commit ${sha}${folder === undefined ? '' : `, folder ${folder}`}, ${tree}` : tree
  return { markdown: `[![AI Install Guard: ${view.verdict.recommendation} at ${pin}${folder === undefined ? '' : ` in ${folder}`}](${image})](${BADGE_PAGE} "Scanned at ${scanned}")`, pin }
}

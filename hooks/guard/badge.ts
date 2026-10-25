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
 * The README badge for the last scan: its verdict and the content it covers.
 * Offered for No red flags and Worth a look only, and only for a scan that
 * read the files, so it always names what was scanned.
 *
 * It names the badge hash, the files' content with the README read without
 * its badges, never a commit: committing the badge makes a new commit, so a
 * badge naming one could never be right for the commit that holds it.
 */
export function badgeFor(view: GuardView | undefined): { markdown: string; pin: string } | { refusal: string } {
  if (view?.verdict === undefined || view.treeHash === undefined) return { refusal: 'Scan something first: /guard scan <path | repository>.' }
  const kind = view.verdict.kind
  if (kind !== 'safe' && kind !== 'caution') return { refusal: `There is no badge for ${view.verdict.recommendation}.` }
  // Only hex from the scan goes into the badge, never text from the candidate.
  const content = view.badgeHash !== undefined && /^sha256:[0-9a-f]{64}$/.test(view.badgeHash) ? view.badgeHash : undefined
  if (content === undefined) return { refusal: 'The last scan has no content hash to pin a badge to. Scan again with this version of the guard.' }
  const pin = content.slice(7, 19)
  // A scan of one folder always says so: the rest of the repository was not
  // judged. The view holds the folder percent-encoded, whole, never cut.
  const folder = view.sha !== undefined ? view.subdir : undefined
  if (folder !== undefined && !/^[\w./%-]{1,400}$/.test(folder)) return { refusal: 'The folder name is too long to show in a badge.' }
  const image = `https://img.shields.io/badge/${shieldPart('AI Install Guard')}-${shieldPart(`${MESSAGE[kind]} · ${pin}`)}-${COLOR[kind]}`
  const scanned = `content ${content}${folder === undefined ? '' : ` in folder ${folder}`}, read without this badge`
  return { markdown: `[![AI Install Guard: ${view.verdict.recommendation} at ${pin}${folder === undefined ? '' : ` in ${folder}`}](${image})](${BADGE_PAGE} "Scanned ${scanned}")`, pin }
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { GuardRequest, GuardRow, GuardStatus, GuardView } from '../../types'
import { GROUPS } from '../scan/checks/types'
import { safeLine } from '../scan/safe-text'
import { countsText, locate } from '../scan/verdict'
import { badgeFor } from './badge'
import { changedSinceScan } from '../gate/recheck'
import { modHost } from '../mod-host'
import { loadReport, recordDecision, saveLastView } from './decisions'
import { grantPass, takePass } from './passes'
import { ownVersion } from './version'
import { needsConfirmation, PANE_ID, primaryLabel } from './view'

const viewAtom = atom({ plugin: 'ai-install-guard', key: 'view' } as const, null)


const ICON: Record<GuardStatus, string> = { fail: '✖', warn: '⚠', pass: '✔', info: '·' }
const COLOR: Record<GuardStatus, string> = { fail: 'error', warn: 'warning', pass: 'success', info: 'subtle' }
const VERDICT_COLOR = { safe: 'success', caution: 'warning', reject: 'error', unverified: 'warning' } as const

type PaneInput = RenderInput<'Pane'>

/** The pane's tree for the scan in state, or a note when there is none. */
export async function drawPane($: EngineInterface, e: PaneInput): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const view = await read($, viewAtom)
  const width = Math.max(20, e.props.bodyColumns)

  if (view === null) {
    return (
      <Box flexDirection="column" width={width}>
        <Text dimColor>No scan yet. Run /guard scan &lt;path&gt;.</Text>
      </Box>
    )
  }

  const header = [
    view.kind === undefined ? undefined : `${/^(?:[aeiou]|MCP\b)/i.test(view.kind) ? 'An' : 'A'} ${view.kind}`,
    view.sha === undefined ? undefined : `commit ${view.sha.slice(0, 12)}`,
    view.treeHash === undefined ? undefined : `tree ${view.treeHash.slice(7, 19)}`,
  ]
    .filter(part => part !== undefined)
    .join(' · ')

  const rowsOf = (group: string): GuardRow[] => view.rows.filter(row => row.group === group)
  const isOpen = (row: GuardRow): boolean => view.details || view.expanded.includes(row.id)
  const toggle = (id: string) => () =>
    update($, viewAtom, current =>
      current === null ? current : { ...current, expanded: current.expanded.includes(id) ? current.expanded.filter(item => item !== id) : [...current.expanded, id] },
    )
  const codeOpen = (row: GuardRow): boolean => (view.codeOpen ?? []).includes(row.id)
  const toggleCode = (id: string) => () =>
    update($, viewAtom, current => {
      if (current === null) return current
      const open = current.codeOpen ?? []
      return { ...current, codeOpen: open.includes(id) ? open.filter(item => item !== id) : [...open, id] }
    })

  // A press counts only on the scan it was drawn from, and only once: the
  // first press claims the decision, and a scan that took the pane since, or
  // a second press, changes nothing.
  const claim = async (): Promise<GuardView | undefined> => {
    let claimed: GuardView | undefined
    await update($, viewAtom, latest => {
      claimed = undefined
      if (latest === null || latest.scanId !== view.scanId || latest.verdict === undefined || latest.decision !== undefined || latest.deciding === true) return latest
      claimed = { ...latest, deciding: true }
      return claimed
    })
    return claimed
  }
  /** Puts `next` in the pane while it still shows this scan; false once another scan has taken it. */
  const replaceOwn = async (next: GuardView): Promise<boolean> => {
    let ours = false
    await update($, viewAtom, latest => {
      ours = latest !== null && latest.scanId === view.scanId
      return ours ? next : latest
    })
    return ours
  }
  const release = (current: GuardView) => replaceOwn({ ...current, deciding: false })
  /**
   * Saves this scan's outcome for /guard report; should a newer scan take
   * the pane meanwhile, its view is saved instead, so the reopened report is
   * always the pane's.
   */
  const saveOwn = async (outcome: GuardView): Promise<void> => {
    await saveLastView($, outcome).catch(() => undefined)
    const now = await read($, viewAtom).catch(() => null)
    if (now !== null && now.scanId !== outcome.scanId) await saveLastView($, now).catch(() => undefined)
  }
  const movedOn = 'the pane has moved on to another scan'

  const decide = (decision: 'approved' | 'rejected', overridden: boolean) => async () => {
    const current = await claim()
    if (current === undefined || current.verdict === undefined) return
    const held = current.action === 'install' ? current.request : undefined
    // A scan that never read the files has no tree hash to pin a decision to:
    // nothing is remembered, and nothing claims otherwise. A held install the
    // person allows anyway goes through once, as that exact command.
    if (current.treeHash === undefined) {
      if (held !== undefined && decision === 'approved') {
        // The pass is spent on this request: the reopened report shows it allowed, not the buttons again.
        const allowed = { ...current, decision, decidedAt: Date.now(), confirming: false, deciding: false }
        if (!(await replaceOwn(allowed))) {
          $.ui.toast(`AI Install Guard: nothing was allowed: ${movedOn}`)
          return
        }
        await grantPass($, { origin: held.origin, args: held.args })
        await saveOwn(allowed)
        await carryOut($, held, allowed)
        return
      }
      $.ui.toast(held !== undefined ? 'AI Install Guard: rejected; nothing was installed' : 'AI Install Guard: closed; the scan read nothing, so there is no decision to remember')
      if (await release(current)) await closeOwn($, current)
      return
    }
    const decidedAt = Date.now()
    try {
      await recordDecision($, {
        target: current.target,
        root: current.root,
        sha: current.sha,
        treeHash: current.treeHash,
        verdict: current.verdict.recommendation,
        verdictKind: current.verdict.kind,
        decision,
        overridden,
        decidedAt,
      })
    } catch {
      // Nothing was saved: say so, and leave the pane open to try again.
      $.ui.toast('AI Install Guard: could not save the decision; nothing was recorded')
      await release(current)
      return
    }
    const decided = { ...current, decision, decidedAt, confirming: false, deciding: false }
    // The decision is saved for its version either way; the pane, the
    // reopened report and the install are this scan's only while it has the pane.
    if (!(await replaceOwn(decided))) {
      $.ui.toast(`AI Install Guard: ${decision} ${current.target}, but ${movedOn}${held !== undefined && decision === 'approved' ? '; run the install again and it goes through' : ''}`)
      return
    }
    // The reopened report shows the outcome, not the buttons again.
    await saveOwn(decided)
    // The approval is saved for this exact version, so the install, asked for
    // again, now goes through: the gate looks the version up again first.
    if (held !== undefined && decision === 'approved') {
      await carryOut($, held, decided)
      return
    }
    $.ui.toast(`AI Install Guard: ${decision === 'approved' ? 'approved' : 'rejected'} ${current.target}${held === undefined ? '' : '; nothing was installed'}`)
    await closeOwn($, decided)
  }

  const primary = async () => {
    const current = await read($, viewAtom)
    if (current === null || current.scanId !== view.scanId) return
    if (needsConfirmation(current)) {
      await update($, viewAtom, latest => (latest === null || latest.scanId !== view.scanId ? latest : { ...latest, confirming: true }))
      return
    }
    await decide('approved', false)()
  }

  const copyBadge = async () => {
    const made = badgeFor(view)
    if ('refusal' in made) {
      $.ui.toast(`AI Install Guard: ${made.refusal}`)
      return
    }
    const result = await $.ui.copy({ text: made.markdown, surface: e.surface })
    $.ui.toast(result.isCopied ? 'AI Install Guard: badge copied; paste it near the top of your README' : 'AI Install Guard: could not copy the badge here')
  }
  const offersBadge = view.treeHash !== undefined && view.badgeHash !== undefined && (view.verdict?.kind === 'safe' || view.verdict?.kind === 'caution')

  const copy = async () => {
    // Only this scan's own report: never another scan's in its place.
    const text = await loadReport($, view.scanId)
    const result = await $.ui.copy({ text: text ?? 'No report yet.', surface: e.surface })
    $.ui.toast(result.isCopied ? 'AI Install Guard: report copied' : 'AI Install Guard: could not copy the report here')
  }

  const verdict = view.verdict
  // The version of the guard that is running, so a screenshot or a shared report says which one judged.
  const version = await ownVersion($)
  // The engine marks nothing when a pane's tree is taller than its window, so
  // the counts say when more lies below it. The rows are counted without
  // wrapping, so the note may go a row early, never stay when nothing is left.
  const shownGroups = GROUPS.filter(group => rowsOf(group.id).length > 0)
  const leastRows = verdict === undefined ? 0 : treeRows(view, header !== '', offersBadge, shownGroups.map(group => rowsOf(group.id).length))
  const moreBelow = leastRows > e.props.scroll.offset + e.props.scroll.bodyRows
  // The decision sits right under the verdict, above the counts and the
  // rows, so a long report never pushes Install and Reject out of sight.
  return (
    <Box flexDirection="column" width={width}>
      <Text bold wrap="wrap">
        AI Install Guard{version === undefined ? '' : ` ${version}`} · {view.target}
      </Text>
      {header !== '' && (
        <Text dimColor wrap="wrap">
          {header}
        </Text>
      )}

      {view.request !== undefined && (
        <Text dimColor wrap="wrap">
          {requestLine(view.request)}
        </Text>
      )}

      {verdict === undefined ? (
        <Text color="suggestion" wrap="truncate-end">
          Scanning: {view.stage}…
        </Text>
      ) : (
        <Box key="verdict" flexDirection="column" borderStyle="round" borderColor={VERDICT_COLOR[verdict.kind]} paddingX={1} marginTop={1}>
          <Text bold color={VERDICT_COLOR[verdict.kind]}>
            {verdict.recommendation}
          </Text>
          {verdict.reasons.map(reason => (
            <Text wrap="wrap">
              {reason}
            </Text>
          ))}
          {(verdict.access ?? []).length > 0 && (
            <Text dimColor wrap="wrap">
              It can: {(verdict.access ?? []).join(' · ')}
            </Text>
          )}
        </Box>
      )}

      {verdict !== undefined && view.decision === undefined && !view.confirming && view.deciding !== true && (
        <Box key="actions" flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
          {(view.treeHash !== undefined || (view.action === 'install' && view.request !== undefined)) && (
            <Button key="install" label={primaryLabel(view)} hotkey="i" variant={needsConfirmation(view) ? 'secondary' : 'primary'} onPress={primary} />
          )}
          <Button key="reject" label="Reject" hotkey="r" variant={needsConfirmation(view) ? 'primary' : 'secondary'} onPress={decide('rejected', false)} />
          <Button key="details" label={view.details ? 'Fewer details' : 'Details'} hotkey="d" onPress={() => update($, viewAtom, current => (current === null ? current : { ...current, details: !current.details }))} />
          <Button key="copy" label="Copy report" hotkey="c" onPress={copy} />
          {offersBadge && <Button key="badge" label="Copy badge" hotkey="b" onPress={copyBadge} />}
        </Box>
      )}

      {verdict !== undefined && view.confirming && view.deciding !== true && (
        <Box key="confirm-row" flexDirection="column" marginTop={1}>
          <Text color="warning" wrap="wrap">
            The verdict is {verdict.recommendation}. {primaryLabel(view)}?
          </Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key="confirm" label={`Yes, ${primaryLabel(view).toLowerCase()}`} hotkey="y" onPress={decide('approved', true)} />
            <Button key="cancel" label="Cancel" hotkey="n" variant="primary" onPress={() => update($, viewAtom, current => (current === null ? current : { ...current, confirming: false }))} />
          </Box>
        </Box>
      )}

      {view.decision !== undefined && (
        <Text color={view.decision === 'approved' ? 'success' : 'error'}>
          {view.treeHash === undefined ? 'Allowed once' : view.decision === 'approved' ? 'Approved' : 'Rejected'}
          {view.decidedAt === undefined ? '' : ` on ${new Date(view.decidedAt).toISOString().slice(0, 10)}`}
          {view.treeHash === undefined ? '. Nothing could be pinned, so nothing is remembered; the same install is held again next time.' : '. The decision is saved for this exact version; /guard forget clears it.'}
        </Text>
      )}
      {view.decision !== undefined && offersBadge && (
        <Box key="after-decision" flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
          <Button key="badge" label="Copy badge" hotkey="b" onPress={copyBadge} />
        </Box>
      )}

      {verdict !== undefined && (
        <Box key="counts" flexDirection="column" marginTop={1}>
          <Box flexDirection="row" columnGap={2}>
            <Text>{countsText(verdict.counts)}</Text>
            {moreBelow && (
              <Text dimColor wrap="truncate-end">
                ↓ scroll for the checks
              </Text>
            )}
          </Box>
          {view.rows.length > 0 && (
            <Text dimColor wrap="wrap">
              Quoted text comes from the scanned files and is untrusted.
            </Text>
          )}
        </Box>
      )}

      {shownGroups.map(group => (
        <Box key={`group-${group.id}`} flexDirection="column" marginTop={1}>
          <Text bold>{group.title}</Text>
          {rowsOf(group.id).map(row => {
            const first = row.evidence[0]
            const headline = row.summary?.[0]
            const summary = headline !== undefined ? `: ${headline}` : first === undefined ? '' : `: ${locate(first.file, first.line)}${first.excerpt}`
            const places = row.evidence.length + row.more
            // With a summary, the code lines are one step further in.
            const showCode = row.summary === undefined || codeOpen(row)
            return (
              <Box key={`row-${row.id}`} flexDirection="column">
                <Button key={`toggle-${row.id}`} plain onPress={toggle(row.id)}>
                  <Text color={COLOR[row.status]}>{ICON[row.status]}</Text> {row.title}
                  <Text dimColor>{truncate(summary, width - row.title.length - 4)}</Text>
                </Button>
                {isOpen(row) && (
                  <Box key={`detail-${row.id}`} flexDirection="column" paddingLeft={2}>
                    {row.summary?.map((line, index) => (
                      <Text wrap="wrap" bold={index === 0}>
                        {line}
                      </Text>
                    ))}
                    {(row.status === 'fail' || row.status === 'warn') && (
                      <Text dimColor wrap="wrap">
                        {row.advice}
                      </Text>
                    )}
                    {row.summary !== undefined && places > 0 && (
                      <Button key={`code-${row.id}`} plain onPress={toggleCode(row.id)}>
                        <Text color="suggestion">
                          {codeOpen(row) ? 'Hide the code' : `Show the code (${places} place${places === 1 ? '' : 's'})`}
                        </Text>
                      </Button>
                    )}
                    {showCode &&
                      row.evidence.map(item => (
                        <Text wrap="wrap" color={item.status === undefined ? undefined : COLOR[item.status]}>
                          {locate(item.file, item.line)}
                          {item.excerpt}
                        </Text>
                      ))}
                    {showCode && row.more > 0 && <Text dimColor>… and {row.more} more in the copied report</Text>}
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
      ))}

    </Box>
  )
}

/**
 * The fewest rows the pane's tree takes once there is a verdict, each line
 * counted as one row: the title, header and held command, the verdict box,
 * the buttons (or the decision and its badge row), the counts and their
 * note, and each group of check rows.
 */
export function treeRows(view: GuardView, hasHeader: boolean, offersBadge: boolean, groupSizes: readonly number[]): number {
  const verdict = view.verdict
  if (verdict === undefined) return 0
  const top = 1 + (hasHeader ? 1 : 0) + (view.request === undefined ? 0 : 1)
  // A margin, the border's two rows, the verdict, its reasons and the It can line.
  const box = 1 + 2 + 1 + verdict.reasons.length + ((verdict.access ?? []).length > 0 ? 1 : 0)
  // Decided, the line saying so, and the Copy badge row under it with its margin when one is offered.
  const decision = view.decision !== undefined ? 1 + (offersBadge ? 2 : 0) : view.confirming ? 3 : view.deciding === true ? 0 : 2
  const counts = 1 + 1 + (view.rows.length > 0 ? 1 : 0)
  const groups = groupSizes.reduce((sum, size) => sum + 2 + size, 0)
  return top + box + decision + counts + groups
}

/**
 * Closes the pane while it shows this scan. Closing is a step of its own, so
 * a newer scan may take the pane in that moment: while that scan still runs
 * or waits for a decision it gets the pane back at once, so its verdict is
 * never left hidden; one already decided closed the pane itself.
 */
async function closeOwn($: EngineInterface, view: GuardView): Promise<void> {
  const before = await read($, viewAtom).catch(() => null)
  if (before !== null && before.scanId !== view.scanId) return
  await $.ui.close({ id: PANE_ID })
  const after = await read($, viewAtom).catch(() => null)
  const waiting = after !== null && after.scanId !== view.scanId && after.decision === undefined && after.deciding !== true
  if (waiting) await $.ui.open({ id: PANE_ID, title: 'AI Install Guard', focus: true }).catch(() => undefined)
}

/** What the held install is, in the person's or Claude's own words. */
function requestLine(request: GuardRequest): string {
  if (request.display !== undefined) return safeLine(request.display)
  return request.origin === 'tool' ? `Claude asked to run: ${safeLine(request.args)}` : `Held until you decide: /plugin ${safeLine(request.args)}`
}

/**
 * Carries out a held install the person approved. Their own /plugin command
 * runs again once the version it would install is checked to be the one
 * scanned; a command Claude ran is Claude's to run again, once the person
 * tells it to, and its gate checks the version then.
 */
async function carryOut($: EngineInterface, held: GuardRequest, view: GuardView): Promise<void> {
  await closeOwn($, view)
  if (held.origin === 'tool') {
    $.ui.toast(held.subject === 'write' ? `AI Install Guard: approved ${held.label}. Tell Claude to make the change again; it goes through now` : `AI Install Guard: approved ${held.label}. Tell Claude to run the install again; it goes through now`)
    return
  }
  // The plugin's own command does not pass through its own gate, so the
  // version is looked up again here: a commit that moved since the scan is
  // not installed on the strength of the old one's verdict.
  const changed = await changedSinceScan(modHost($), view).catch((error: unknown) => `the guard could not look it up again (${error instanceof Error ? error.message : String(error)})`)
  if (changed !== undefined) {
    await takePass($, { origin: 'command', args: held.args }).catch(() => undefined)
    $.ui.toast(`AI Install Guard: nothing was installed: ${safeLine(changed)}. Run /plugin ${safeLine(held.args)} again to scan it`)
    return
  }
  $.ui.toast(`AI Install Guard: approved; installing ${held.label}`)
  try {
    await $.command.run({ command: 'plugin', args: held.args })
  } catch {
    $.ui.toast(`AI Install Guard: approved, but the install did not start. Run /plugin ${safeLine(held.args)} again; it goes through now`)
  } finally {
    // A pass the gate did not use up is not left for a later command.
    await takePass($, { origin: 'command', args: held.args }).catch(() => undefined)
  }
}

function truncate(text: string, room: number): string {
  if (room <= 1) return ''
  return text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`
}

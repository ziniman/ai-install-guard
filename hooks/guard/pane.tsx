import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { GuardRow, GuardStatus, GuardView } from '../../types'
import { GROUPS } from '../scan/checks/types'
import { locate } from '../scan/verdict'
import { badgeFor } from './badge'
import { recordDecision, saveLastView } from './decisions'
import { needsConfirmation, PANE_ID, primaryLabel } from './view'

const viewAtom = atom({ plugin: 'ai-install-guard', key: 'view' } as const, null)

export const REPORT_TEXT = 'last-report-text'

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
    view.kind === undefined ? undefined : `A ${view.kind}`,
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

  const decide = (decision: 'approved' | 'rejected', overridden: boolean) => async () => {
    const current = await read($, viewAtom)
    if (current === null || current.verdict === undefined) return
    // A scan that never read the files has no tree hash to pin a decision to:
    // the pane closes, nothing is remembered, and nothing claims otherwise.
    if (current.treeHash === undefined) {
      $.ui.toast('AI Install Guard: closed; the scan read nothing, so there is no decision to remember')
      await $.ui.close({ id: PANE_ID })
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
      return
    }
    const decided = { ...current, decision, decidedAt, confirming: false }
    await update($, viewAtom, () => decided)
    // The reopened report shows the outcome, not the buttons again.
    await saveLastView($, decided).catch(() => undefined)
    $.ui.toast(`AI Install Guard: ${decision === 'approved' ? 'approved' : 'rejected'} ${current.target}`)
    await $.ui.close({ id: PANE_ID })
  }

  const primary = async () => {
    const current = await read($, viewAtom)
    if (current === null) return
    if (needsConfirmation(current)) {
      await update($, viewAtom, latest => (latest === null ? latest : { ...latest, confirming: true }))
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
  const offersBadge = view.treeHash !== undefined && (view.verdict?.kind === 'safe' || view.verdict?.kind === 'caution')

  const copy = async () => {
    const text = await $.store.get(REPORT_TEXT)
    const result = await $.ui.copy({ text: typeof text === 'string' ? text : 'No report yet.', surface: e.surface })
    $.ui.toast(result.isCopied ? 'AI Install Guard: report copied' : 'AI Install Guard: could not copy the report here')
  }

  const verdict = view.verdict
  return (
    <Box flexDirection="column" width={width}>
      <Text bold wrap="truncate-end">
        AI Install Guard · {view.target}
      </Text>
      {header !== '' && (
        <Text dimColor wrap="truncate-end">
          {header}
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
            <Text wrap="truncate-end">
              {reason}
            </Text>
          ))}
        </Box>
      )}

      {verdict !== undefined && (
        <Text>
          {verdict.counts.pass} passed · {verdict.counts.warn} warning{verdict.counts.warn === 1 ? '' : 's'} · {verdict.counts.fail} failed
        </Text>
      )}
      {verdict !== undefined && view.rows.length > 0 && (
        <Text dimColor wrap="truncate-end">
          Quoted text comes from the scanned files and is untrusted.
        </Text>
      )}

      {GROUPS.filter(group => rowsOf(group.id).length > 0).map(group => (
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

      {verdict !== undefined && view.decision === undefined && !view.confirming && (
        <Box key="actions" flexDirection="row" gap={1} marginTop={1}>
          {view.treeHash !== undefined && (
            <Button key="install" label={primaryLabel(view)} hotkey="i" variant={needsConfirmation(view) ? 'secondary' : 'primary'} onPress={primary} />
          )}
          <Button key="reject" label="Reject" hotkey="r" variant={needsConfirmation(view) ? 'primary' : 'secondary'} onPress={decide('rejected', false)} />
          <Button key="details" label={view.details ? 'Fewer details' : 'Details'} hotkey="d" onPress={() => update($, viewAtom, current => (current === null ? current : { ...current, details: !current.details }))} />
          <Button key="copy" label="Copy report" hotkey="c" onPress={copy} />
          {offersBadge && <Button key="badge" label="Copy badge" hotkey="b" onPress={copyBadge} />}
        </Box>
      )}

      {verdict !== undefined && view.confirming && (
        <Box key="confirm-row" flexDirection="column" marginTop={1}>
          <Text color="warning" wrap="wrap">
            The verdict is {verdict.recommendation}. {primaryLabel(view)}?
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="confirm" label={`Yes, ${primaryLabel(view).toLowerCase()}`} hotkey="y" onPress={decide('approved', true)} />
            <Button key="cancel" label="Cancel" hotkey="n" variant="primary" onPress={() => update($, viewAtom, current => (current === null ? current : { ...current, confirming: false }))} />
          </Box>
        </Box>
      )}

      {view.decision !== undefined && (
        <Text color={view.decision === 'approved' ? 'success' : 'error'}>
          {view.decision === 'approved' ? 'Approved' : 'Rejected'}
          {view.decidedAt === undefined ? '' : ` on ${new Date(view.decidedAt).toISOString().slice(0, 10)}`}. The decision is saved for this exact version; /guard forget clears it.
        </Text>
      )}
    </Box>
  )
}

function truncate(text: string, room: number): string {
  if (room <= 1) return ''
  return text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`
}

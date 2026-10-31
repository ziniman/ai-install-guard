import type { EngineInterface, Register } from 'claude-code'
import { atom, update } from 'claude-code'

import { BROWSE_NOTE, judge, judgeShell, judgeWrite } from './gate/gate'
import { servingTool, toolRefusal } from './gate/configured'
import { checkAtStart, waitingReport, type StartCheck } from './gate/installed'
import { failedLoad, heldToast, judgeLoad, release, remember, reviewHeld, toReview, type HeldMod } from './gate/load'
import { NAMES_CLAUDE, readShellChange, type ShellChange } from './gate/shell-change'
import { failedSkill, judgeByName, judgeSkill } from './gate/skill'
import { readPluginArgs, readShellCommand } from './gate/requests'
import { claudeConfigDir, keptAt, landsAt, normalizePath, readWrite, type WriteInput, type WriteReading } from './gate/writes'
import { expandHome } from './gate/resolve'
import { badgeFor } from './guard/badge'
import { forgetDecisions, loadDecisions, loadLastView, loadReport } from './guard/decisions'
import { drawPane } from './guard/pane'
import { showScan } from './guard/run'
import { PANE_ID } from './guard/view'
import { modHost } from './mod-host'
import { sha256Hex } from './scan/hash'
import type { Host } from './scan/host'
import { looksRemote, parseRemote, type RemoteSpec } from './scan/remote'
import { safeLine } from './scan/safe-text'

// Claude Code reads every state reference from the file that uses it, so each
// module declares its own atom for the pane's view.
const viewAtom = atom({ plugin: 'ai-install-guard', key: 'view' } as const, null)

const USAGE = [
  'Usage:',
  '  /guard scan <path>            Scan a local plugin, mod or skill folder without installing it',
  '  /guard scan <repository>      Fetch one commit of a repository and scan it: https://host/owner/repo,',
  '                                github:owner/repo or owner/repo, with an optional @ref',
  '      --ref <branch|tag|commit>   The commit to scan (the default branch otherwise)',
  '      --path <folder>             A folder inside the repository',
  '      --details                   The full report as text',
  '  /guard report                 Reopen the last report',
  '  /guard badge                  A README badge for the last scan (No red flags or Worth a look)',
  '  /guard list                   Your approved and rejected versions',
  '  /guard held                   The mods kept from loading, and the plugins and configuration that wait for you, the next one in the pane',
  '  /guard forget <name>          Forget decisions about a name, so it is judged again',
].join('\n')

export const register: Register = (on, options) => {
  // Off unless you turn it on: the lookups send package and plugin names out.
  const lookups = options.outsideLookups === true

  /** The folder Claude's shell commands run in, as the session last said: where a relative path in one lands. */
  let cwd: string | undefined
  /** The folder the session started in, whose `.claude` (and those above it) Claude Code loads skills from. */
  let projectDir: string | undefined
  const skillFolders = (): string[] => [projectDir, cwd].filter((folder): folder is string => folder !== undefined)
  /** The mods kept from loading in this session, for the pane and /guard held. */
  const held: HeldMod[] = []
  /** The folders of held mods already named to the person, so a reload, which starts the session's hooks again, does not name them twice. */
  const announced = new Set<string>()
  /** Whether the session has started, so a mod kept out at a reload can be shown at once. */
  let started = false
  /** The plugins on in this session, and the parts of your configuration, that you have not approved, as the session-start check found them. */
  let found: StartCheck = { plugins: [], configs: [] }
  /** The session-start check once it has begun, so a reload, which starts the session's hooks again, does not run it twice, and /guard held can wait for it. */
  let checking: Promise<void> | undefined

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    projectDir = e.cwd
    await $.command.register({
      name: 'guard',
      description: 'Scan a plugin, mod, skill or MCP server without installing it',
      argumentHint: 'scan <path | repository> | report | badge | list | held | forget <name>',
    })
    started = true
    // The mods kept out as the session loaded: all of them named, each once, and the first you have not rejected in the pane.
    const fresh = held.filter(mod => !announced.has(mod.root))
    for (const mod of fresh) announced.add(mod.root)
    if (fresh.length > 0) $.ui.toast(heldToast(fresh))
    const first = toReview(fresh)
    if (first !== undefined) await reviewHeld($, first, lookups).catch(() => undefined)
    // Gate F: every plugin installed and on, and every MCP server and settings
    // file in your configuration, compared with what you approved, beside the
    // session rather than before its first prompt. Only with a person at the
    // prompt: a headless run has no pane to show what it finds.
    if (e.isInteractive && checking === undefined) {
      const place = async () => ({ cwd: e.cwd, configDir: await claudeFolder($) })
      checking = checkAtStart($, { held, own: $.plugin.root, paneTaken: first !== undefined, lookups, place }).then(check => {
        found = check
      })
    }
    return next(e)
  })

  // Gate D: a mod about to load, however it got there (the /plugin menu, an
  // update, files changed in place). It joins only when its folder holds
  // exactly files the person approved; anything else is kept out and shown
  // in the pane.
  on('plugin.register', async ($, e, next) => {
    const judged = await judgeLoad($, e)
    if (judged.kind === 'allow') {
      // Approved since it was held, it loads at this reload and is no longer kept out.
      release(held, e.root)
      return next(e)
    }
    if (judged.held !== undefined) {
      remember(held, judged.held)
      // At a reload the session is running and the pane can show it now; at start, session.start does.
      if (started) {
        announced.add(judged.held.root)
        const review = toReview([judged.held])
        if (review !== undefined) await reviewHeld($, review, lookups).catch(() => undefined)
      }
    }
    return { refuse: judged.reason }
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // Kept out all the same, with what failed in the refusal and in /guard held.
    try {
      const { reason, ...mod } = failedLoad(e, next.error)
      remember(held, mod)
      return { refuse: reason }
    } catch {
      return { refuse: 'AI Install Guard kept this mod from loading: the guard failed before it could check it.' }
    }
  })

  on('command.run', { command: 'guard' }, async ($, e) => {
    const { sub, rest, details, ref, path, error } = splitArgs(e.args)
    if (error !== undefined) return { text: `AI Install Guard: ${error}\n\n${USAGE}` }
    if (sub === 'scan' && rest !== '') return { text: await scan($, rest, details, { ref, path }, lookups) }
    if (sub === 'report') return { text: await reopen($) }
    if (sub === 'badge') return { text: await badge($) }
    if (sub === 'list') return { text: await list($) }
    if (sub === 'held') {
      // A check still running at the start of the session is waited for, so the list is whole.
      await checking
      return { text: await waitingReport($, held, found, lookups, { cwd: projectDir ?? '', configDir: await claudeFolder($) }) }
    }
    if (sub === 'forget' && rest !== '') {
      const count = (await forgetDecisions($, rest, await landedName($, rest))).length
      return { text: `AI Install Guard: forgot ${count} decision${count === 1 ? '' : 's'} about ${safeLine(rest)}.` }
    }
    return { text: USAGE }
  }).catch(() => ({ text: 'AI Install Guard: the command failed before it could answer.' }))

  // Gate A: the person's own /plugin install and /plugin marketplace add. An
  // install is answered in the command's place, so nothing installs, until
  // the person approves that exact version.
  on('command.run', { command: 'plugin' }, async ($, e, next) => {
    const reading = readPluginArgs(e.args)
    if (reading.kind === 'pass') {
      if (reading.browse) $.ui.toast(BROWSE_NOTE)
      return next(e)
    }
    const judged = await judge($, reading, { origin: 'command', args: e.args, label: reading.label }, lookups)
    if (judged.kind === 'hold') return { text: judged.text }
    if (judged.note !== undefined) $.ui.toast(judged.note)
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { text: 'AI Install Guard stopped this install: it failed before it could check it, so nothing was installed.' }))

  // A `cd` in one shell command carries over to the next: the session says where it went.
  on('classic.CwdChanged', ($, e, next) => {
    cwd = e.new_cwd
    return next(e)
  }).catch(($, e, next) => next(e))

  // Gate B: Claude installing a plugin or adding a marketplace with the claude
  // command, or changing where Claude Code loads from with any other command
  // (a redirection, cp, git clone, curl -o, unzip). The command is refused,
  // with a reason Claude reads, until the person approves what it adds.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const reading = readShellCommand(e.command)
    if (reading.kind === 'pass') {
      const gate = await gateShell($, e.command, cwd, lookups)
      if ('deny' in gate) return { deny: gate.deny }
      try {
        return await next(e)
      } finally {
        gate.release()
      }
    }
    const judged = await judge($, reading, { origin: 'tool', args: e.command, label: reading.label }, lookups)
    if (judged.kind === 'hold') return { deny: judged.text }
    if (judged.note !== undefined) $.ui.toast(judged.note)
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'AI Install Guard stopped this command: it may install a plugin or change where Claude Code loads from, and the guard failed before it could check it. Nothing was installed or written.' }))

  // Gate C: Claude writing or editing a file where Claude Code loads skills,
  // commands, agents, MCP servers and plugins from. Any other file goes on at
  // once; one of these is scanned as it would be once written.
  const writeRefused = { deny: 'AI Install Guard stopped this change: it writes where Claude Code loads skills, MCP servers or plugins from, and the guard failed before it could check it. Nothing was written.' }
  // A change that goes on keeps its place claimed until it is written, so a second change there waits its turn.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const gate = await gateWrite($, { tool: 'Write', file_path: e.file_path, content: e.content }, lookups, await claudeFolder($))
    if ('deny' in gate) return { deny: gate.deny }
    try {
      return await next(e)
    } finally {
      gate.release()
    }
  }).catch(($, e, next) => (next.called ? next(e) : writeRefused))
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const gate = await gateWrite($, { tool: 'Edit', file_path: e.file_path, old_string: e.old_string, new_string: e.new_string, ...(e.replace_all === undefined ? {} : { replace_all: e.replace_all }) }, lookups, await claudeFolder($))
    if ('deny' in gate) return { deny: gate.deny }
    try {
      return await next(e)
    } finally {
      gate.release()
    }
  }).catch(($, e, next) => (next.called ? next(e) : writeRefused))

  // Gate E: a skill or command that came with no install. Its inline commands
  // run as Claude Code expands it, before skill.prompt, so the person's /name
  // and Claude's Skill tool are judged first, by the files Claude Code may
  // load that name from. Nothing runs while one is held.
  on('command.run', async ($, e, next) => {
    const judged = await judgeByName($, e.command, skillFolders(), lookups, await claudeFolder($))
    if (judged.kind === 'hold') return { text: judged.toPerson }
    if (judged.note !== undefined) $.ui.toast(judged.note)
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { text: `AI Install Guard stopped /${safeLine(e.command)}: it failed before it could check the skill by that name, so nothing in it ran.` }))
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const judged = await judgeByName($, e.skill, skillFolders(), lookups, await claudeFolder($))
    if (judged.kind === 'hold') return { deny: judged.text }
    if (judged.note !== undefined) $.ui.toast(judged.note)
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `AI Install Guard stopped the skill ${safeLine(e.skill)}: it failed before it could check it, so nothing in it ran. Tell the person.` }))
  // And as its instructions load for the model, the net for a skill found
  // anywhere else (a subagent's preload): the model reads why in place of them.
  on('skill.prompt', async ($, e, next) => {
    const judged = await judgeSkill($, e, lookups, await claudeFolder($))
    if (judged.kind === 'hold') return { text: judged.text }
    if (judged.note !== undefined) $.ui.toast(judged.note)
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { text: failedSkill(e, next.error) }))

  // A server you rejected started with the session, before the guard could
  // look: its tools are refused from then on, by the start of their names.
  on('tool.call', async ($, e, next) => {
    if (servingTool(found.configs, e.tool).length === 0) return next(e)
    const refused = toolRefusal(found.configs, e.tool, await loadDecisions($))
    return refused === undefined ? next(e) : { deny: refused }
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // A tool a server found unapproved may serve is refused when the guard cannot tell whether you rejected it.
    if (servingTool(found.configs, e.tool).length === 0) return next(e)
    return { deny: 'AI Install Guard stopped this tool: it may come from an MCP server the person rejected, and the guard failed before it could check. Tell the person.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, ($, e) => drawPane($, e))
}

/** Where CLAUDE_CONFIG_DIR keeps Claude's own folder, when it moves it from ~/.claude: looked up once, when first needed. */
let configDir: Promise<string | undefined> | undefined

function claudeFolder($: EngineInterface): Promise<string | undefined> {
  configDir ??= claudeConfigDir(modHost($)).catch(() => undefined)
  return configDir
}

/**
 * Where a change is being judged or made right now: a skill's folder, or the
 * file. Two changes to one skill at once would each be judged without the
 * other, so the second is held until the first is written.
 */
const changing = new Set<string>()

/**
 * Where a path typed to /guard forget really is, as written changes are kept
 * (`keptAt`), from the home folder for `~`. Undefined for a bare name.
 */
async function landedName($: EngineInterface, name: string): Promise<string | undefined> {
  const host = modHost($)
  try {
    return await keptAt(host, await expandHome(host, name.replace(/^~\\/, '~/')))
  } catch {
    // Without the home folder, the name as typed is all there is to match.
    return undefined
  }
}

/**
 * Gate C's judgement of one write: the refusal Claude reads, or a release to
 * call once the write is done. A file outside the places Claude Code loads
 * from claims nothing.
 */
async function gateWrite($: EngineInterface, input: WriteInput, lookups: boolean, configDir: string | undefined): Promise<{ deny: string } | { release: () => void }> {
  const free = { release: () => undefined }
  const reading = await readWrite(modHost($), input, configDir)
  if (reading.kind === 'pass') return free
  const path = safeLine(normalizePath(input.file_path))
  // Claimed where the change really lands, so a link to the same skill or file is the same place,
  // and without regard to case, since a disk that ignores case has one file under both names.
  const place = normalizePath(await landsAt(modHost($), (reading.kind === 'prompt' ? reading.folder : undefined) ?? input.file_path.replace(/\\/g, '/'))).toLowerCase()
  if (changing.has(place)) return { deny: `AI Install Guard held this change: another change to ${reading.label} is being checked or written. Nothing was written. Make one change at a time, then make this one again.` }
  changing.add(place)
  const release = () => {
    changing.delete(place)
  }
  try {
    const judged = await judgeOne($, input, reading, path, lookups)
    if (judged !== undefined) {
      release()
      return judged
    }
    return { release }
  } catch (error) {
    release()
    throw error
  }
}

/**
 * Gate B's judgement of a shell command that is no install: the refusal
 * Claude reads, or a release to call once it has run. A command that changes
 * nothing where Claude Code loads from claims nothing and goes on at once.
 */
async function gateShell($: EngineInterface, command: string, cwd: string | undefined, lookups: boolean): Promise<{ deny: string } | { release: () => void }> {
  const free = { release: () => undefined }
  let change: ShellChange
  try {
    change = await readShellChange(modHost($), command, cwd, () => claudeFolder($))
  } catch {
    // This runs before every shell command: one that cannot be read fails only when it names Claude's own folder.
    if (!NAMES_CLAUDE.test(command)) return free
    return { deny: 'AI Install Guard stopped this command: it names a place Claude Code loads from, and the guard failed before it could read what it changes there. Nothing was written.' }
  }
  if (change.kind === 'pass') return free
  const place = change.claim
  if (place !== undefined && changing.has(place)) return { deny: `AI Install Guard held this command: another change to ${change.label.replace(/^a change to /, '')} is being checked or written. Nothing was written. Make one change at a time, then run this one again.` }
  if (place !== undefined) changing.add(place)
  const release = () => {
    if (place !== undefined) changing.delete(place)
  }
  try {
    const judged = await judgeShell($, change, command, lookups)
    if (judged.kind === 'hold') {
      release()
      return { deny: judged.text }
    }
    if (judged.note !== undefined) $.ui.toast(judged.note)
    return { release }
  } catch (error) {
    release()
    throw error
  }
}

/** The judgement of a write already read and claimed: its refusal, or undefined when it may go on. */
async function judgeOne($: EngineInterface, input: WriteInput, reading: Exclude<WriteReading, { kind: 'pass' }>, path: string, lookups: boolean): Promise<{ deny: string } | undefined> {
  // The same change, and only it, is what an approval or a one-time pass lets through.
  const args = `${input.tool} ${path} ${await sha256Hex(JSON.stringify(input))}`
  const display = `Claude asked to ${input.tool === 'Write' ? 'write' : 'edit'} ${path}`
  const judged = await judgeWrite($, reading, { origin: 'tool', args, label: reading.label, subject: 'write', display }, lookups)
  if (judged.kind === 'hold') return { deny: judged.text }
  if (judged.note !== undefined) $.ui.toast(judged.note)
  return undefined
}

/**
 * Scans a folder with the pane showing progress and then the verdict. The
 * command's own answer, which the model also reads, is one line: the quoted
 * findings stay in the pane. Where no pane can show (a headless run), or with
 * --details, the answer is the full text report.
 */
async function scan($: EngineInterface, target: string, details: boolean, flags: { ref?: string; path?: string }, lookups: boolean): Promise<string> {
  const host = modHost($)
  const shown = await showScan(
    $,
    target,
    async () => {
      const spec = await remoteSpecFor(host, target, flags)
      return spec === undefined ? { folder: await expandHome(host, target) } : { remote: spec }
    },
    { action: 'approve', lookups },
  )
  if (shown.kind === 'failed') return shown.reason
  // Where no pane shows, the answer is the whole report: findings and advice.
  if (!shown.placed || details) return shown.text
  return `AI Install Guard: ${shown.report.verdict.recommendation} for ${safeLine(target)}. The report is in the pane; /guard report reopens it.`
}

async function reopen($: EngineInterface): Promise<string> {
  const view = await loadLastView($)
  if (view === undefined) return 'AI Install Guard: no report yet. Run /guard scan <path>.'
  await update($, viewAtom, () => ({ ...view, confirming: false, deciding: false }))
  const opened = await $.ui.open({ id: PANE_ID, title: 'AI Install Guard', focus: true }).catch(() => ({ isPlaced: false }))
  if (opened.isPlaced) return `AI Install Guard: reopened the report for ${safeLine(view.target)}.`
  return (await loadReport($, view.scanId)) ?? 'AI Install Guard: the last report is no longer stored.'
}

async function badge($: EngineInterface): Promise<string> {
  const view = await loadLastView($)
  const made = badgeFor(view)
  if ('refusal' in made) return `AI Install Guard: ${made.refusal}`
  return [
    `AI Install Guard: a README badge for ${view?.target ?? 'the last scan'} at ${made.pin}. Paste it near the top of your README:`,
    '',
    made.markdown,
    '',
    "It names the content that was scanned, with the README read without its badge, so it stays right in the commit that adds it. Any other change needs a new scan and a new badge; the guard checks a badge against its own scan and never trusts it.",
  ].join('\n')
}

async function list($: EngineInterface): Promise<string> {
  const decisions = await loadDecisions($)
  if (decisions.length === 0) return 'AI Install Guard: no decisions yet.'
  const lines = decisions.map(item => {
    const when = new Date(item.decidedAt).toISOString().slice(0, 10)
    const how = item.decision === 'approved' ? (item.overridden ? 'approved against the verdict' : 'approved') : 'rejected'
    return `  ${when}  ${how.padEnd(28)} ${safeLine(item.target)}  (${item.verdict}, tree ${item.treeHash.slice(7, 19)})`
  })
  return ['AI Install Guard: your decisions, newest first', ...lines].join('\n')
}

/**
 * `scan --details --ref v1 "my folder"` → `{ sub: 'scan', details: true, ref: 'v1', rest: 'my folder' }`.
 * Options count only as their own tokens right after the subcommand, so a
 * quoted path that contains one is left whole.
 */
export function splitArgs(args: string): { sub: string; rest: string; details: boolean; ref?: string; path?: string; error?: string } {
  const trimmed = args.trim()
  const space = trimmed.search(/\s/)
  const sub = space === -1 ? trimmed : trimmed.slice(0, space)
  let rest = space === -1 ? '' : trimmed.slice(space).trim()
  let details = false
  let ref: string | undefined
  let path: string | undefined
  for (;;) {
    const option = /^(--details|--ref|--path)(?:\s+|$)/.exec(rest)
    if (option === null) break
    rest = rest.slice(option[0].length)
    if (option[1] === '--details') {
      details = true
      continue
    }
    const value = /^("[^"]*"|'[^']*'|\S+)\s*/.exec(rest)
    if (value === null || (value[1] as string).startsWith('--')) return { sub: sub.toLowerCase(), rest: '', details, error: `${option[1]} needs a value` }
    rest = rest.slice(value[0].length)
    if (option[1] === '--ref') ref = unquote(value[1] as string)
    else path = unquote(value[1] as string)
  }
  return { sub: sub.toLowerCase(), rest: unquote(rest), details, ref, path }
}

/**
 * The remote source `target` names, or undefined for a local folder. A bare
 * owner/repo is a folder when one exists by that name and no --ref or --path
 * says otherwise.
 */
async function remoteSpecFor(host: Host, target: string, flags: { ref?: string; path?: string }): Promise<RemoteSpec | undefined> {
  const shape = looksRemote(target)
  const asked = flags.ref !== undefined || flags.path !== undefined
  if (shape === 'local') {
    if (asked) throw new Error('--ref and --path apply to a repository, not to a folder')
    return undefined
  }
  if (shape === 'maybe' && !asked && (await host.stat(target).catch(() => undefined)) !== undefined) return undefined
  return parseRemote(target, { ref: flags.ref, subdir: flags.path })
}

function unquote(text: string): string {
  return /^(["']).*\1$/.test(text) ? text.slice(1, -1) : text
}

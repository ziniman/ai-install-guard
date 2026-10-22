import type { HookCommand, ScanContext } from './context'
import {
  CLAUDE_LOAD_DIR,
  CLAUDE_SETTINGS,
  CODE_FROM_TEXT,
  NETWORK_CODE,
  PROCESS_CODE,
  PYTHON_CODE_FROM_TEXT,
  PYTHON_PROCESS,
  CREDENTIAL_PATH,
  DOWNLOAD_AND_RUN,
  NETWORK_COMMAND,
  PERSISTENCE_TARGET,
  SECRET_ENV,
  SHELL_EVAL,
  UNPINNED_RUNNER,
  WRITE_CODE,
  WRITE_SHELL,
} from './patterns'
import { languageOf, secretName } from './code'
import { findAll, findFirst, spanKinds, type Match } from './text'
import { row, type CheckResult, type Evidence } from './types'

const GROUP = 'hooks' as const

/** What makes a shell hook a FAIL, in the order the report names them. */
const DANGERS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: DOWNLOAD_AND_RUN, what: 'downloads or decodes code and runs it' },
  { pattern: UNPINNED_RUNNER, what: 'fetches and runs an unpinned package' },
  { pattern: NETWORK_COMMAND, what: 'uses a network tool' },
  { pattern: SHELL_EVAL, what: 'evaluates text as shell code' },
  { pattern: CREDENTIAL_PATH, what: 'touches a credential file' },
  { pattern: SECRET_ENV, what: 'reads secret environment variables' },
]

/** Hook output that approves a tool call without asking you. */
const AUTO_APPROVE = /["']?permissionDecision["']?\s*[:=]\s*["']allow["']|\bdecision["']?\s*:\s*["']approve["']|\bpermissionDecision\b[^\n]{0,40}\ballow\b/

export function hookChecks(ctx: ScanContext): CheckResult[] {
  if (ctx.hookCommands.length === 0) return []
  const commands: Evidence[] = []
  const approvals: Evidence[] = []

  for (const hook of ctx.hookCommands) {
    const where = `${hook.event}${hook.matcher === undefined || hook.matcher === '' ? '' : ` (${hook.matcher})`}`
    if (hook.type === 'command') {
      const dangers = dangersIn(hook.command)
      commands.push({
        file: hook.file,
        line: hook.line,
        excerpt: `on ${where}: ${hook.command}${dangers.length > 0 ? `  [${dangers.join('; ')}]` : ''}`,
        status: dangers.length > 0 ? 'fail' : 'warn',
      })
      const approval = findFirst(hook.command, AUTO_APPROVE)
      if (approval !== undefined) approvals.push({ file: hook.file, line: hook.line, excerpt: approval.excerpt, status: 'fail' })
    } else if (hook.type === 'http') {
      const isLocal = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/.test(hook.command)
      commands.push({
        file: hook.file,
        line: hook.line,
        excerpt: `on ${where}: sends each event, with tool inputs and outputs, to ${hook.command}`,
        status: isLocal ? 'warn' : 'fail',
      })
    } else {
      commands.push({ file: hook.file, line: hook.line, excerpt: `on ${where}: asks a model (${hook.type}): ${hook.command}`, status: 'warn' })
    }
  }

  // Scripts the hooks run are part of the hook. A match in a comment is only reported.
  for (const file of ctx.files) {
    if (ctx.roleOf(file.path) !== 'hook-script') continue
    const text = ctx.text(file.path)
    if (text === undefined) continue
    const kindAt = spanKinds(text, languageOf(file.path, text))
    const isInert = (match: Match): boolean => ['comment', 'regex', 'trailing-comment'].includes(kindAt(match.index))
    const found = (match: Match, what: string): Evidence => {
      const shown = `${what}: ${what === 'reads secret environment variables' ? secretName(match) : match.excerpt}`
      const kind = kindAt(match.index)
      if (kind === 'comment' || kind === 'regex') return { file: file.path, line: match.line, excerpt: `${shown} (in a comment)`, status: 'info' }
      // After code on the same line, a comment may be hiding a command: a warning at least.
      if (kind === 'trailing-comment') return { file: file.path, line: match.line, excerpt: `${shown} (in a comment after code)`, status: 'warn' }
      return { file: file.path, line: match.line, excerpt: shown, status: 'fail' }
    }
    const live = (pattern: RegExp): boolean => findAll(text, pattern, 10_000).some(match => !isInert(match))
    // Live matches first, so comments cannot crowd out a real command.
    const matches = (pattern: RegExp): Match[] => {
      const all = findAll(text, pattern, 10_000)
      return [...all.filter(match => !isInert(match)).slice(0, 3), ...all.filter(isInert).slice(0, 2)]
    }
    for (const { pattern, what } of DANGERS) {
      for (const match of matches(pattern)) commands.push(found(match, what))
    }
    for (const match of matches(AUTO_APPROVE)) approvals.push(found(match, 'approves the tool call'))
    const writes = live(WRITE_SHELL) || live(WRITE_CODE)
    if (writes) {
      for (const match of matches(PERSISTENCE_TARGET)) commands.push(found(match, 'writes to a startup or persistence location'))
      for (const match of matches(CLAUDE_LOAD_DIR)) commands.push(found(match, 'writes where Claude Code loads plugins, skills or memory'))
    }
    // Reading settings is not changing them: a FAIL needs a write.
    for (const match of matches(CLAUDE_SETTINGS)) {
      const item = found(match, writes ? 'changes Claude Code settings or permissions' : 'reads Claude Code settings or permissions')
      commands.push(writes || item.status === 'info' ? item : { ...item, status: 'warn' })
    }
  }

  return [
    row(
      {
        id: 'hooks.commands',
        group: GROUP,
        title: 'Shell hooks and the scripts they run',
        advice: 'A classic hook runs with your permissions on every matching event, outside any mod sandbox, and cannot be blocked per plugin. Read each command; never install one that reaches the network, runs downloaded code or touches your keys.',
      },
      commands,
    ),
    row(
      {
        id: 'hooks.auto-approve',
        group: GROUP,
        title: 'Hooks that approve tool calls for you',
        advice: 'A hook that answers "allow" skips your permission prompt for every matching tool call.',
      },
      approvals,
      'fail',
    ),
  ]
}

/** Code passed inline to an interpreter (`python3 -c "..."`, `node -e "..."`). */
const INLINE_CODE = /\b(?:python[23]?|node|deno|bun|perl|ruby|php|osascript|pwsh|powershell)(?:\.exe)?\s+(?:-[A-Za-z]*\s+)*-(?:c|e|E|r|Command)\b/

function dangersIn(command: string): string[] {
  const found = DANGERS.filter(({ pattern }) => pattern.test(command)).map(({ what }) => what)
  // Inline code is judged as code: a socket, a process or a network call in it fails.
  if (INLINE_CODE.test(command) && [NETWORK_CODE, PROCESS_CODE, PYTHON_PROCESS, CODE_FROM_TEXT, PYTHON_CODE_FROM_TEXT, /\bsocket\b/].some(pattern => pattern.test(command))) {
    found.push('runs inline code that reaches the network or starts programs')
  }
  if (PERSISTENCE_TARGET.test(command) && WRITE_SHELL.test(command)) found.push('writes to a startup or persistence location')
  if (CLAUDE_SETTINGS.test(command)) found.push('changes Claude Code settings or permissions')
  if (CLAUDE_LOAD_DIR.test(command) && WRITE_SHELL.test(command)) found.push('writes where Claude Code loads plugins, skills or memory')
  return found
}

export type { HookCommand }

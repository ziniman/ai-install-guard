import type { HookCommand, ScanContext } from './context'
import {
  CLAUDE_LOAD_DIR,
  CLAUDE_SETTINGS,
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
import { findAll, findFirst } from './text'
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
const AUTO_APPROVE = /["']?permissionDecision["']?\s*[:=]\s*["']allow["']|["']decision["']\s*:\s*["']approve["']|\bpermissionDecision\b[^\n]{0,40}\ballow\b/

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
      const isLocal = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//.test(hook.command)
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

  // Scripts the hooks run are part of the hook.
  for (const file of ctx.files) {
    if (ctx.roleOf(file.path) !== 'hook-script') continue
    const text = ctx.text(file.path)
    if (text === undefined) continue
    for (const { pattern, what } of DANGERS) {
      for (const match of findAll(text, pattern, 3)) {
        commands.push({ file: file.path, line: match.line, excerpt: `${what}: ${match.excerpt}`, status: 'fail' })
      }
    }
    for (const match of findAll(text, AUTO_APPROVE, 3)) {
      approvals.push({ file: file.path, line: match.line, excerpt: match.excerpt, status: 'fail' })
    }
    const writes = WRITE_SHELL.test(text) || WRITE_CODE.test(text)
    for (const match of findAll(text, PERSISTENCE_TARGET, 3)) {
      if (writes) commands.push({ file: file.path, line: match.line, excerpt: `writes to a startup or persistence location: ${match.excerpt}`, status: 'fail' })
    }
    for (const match of findAll(text, CLAUDE_SETTINGS, 3)) {
      commands.push({ file: file.path, line: match.line, excerpt: `changes Claude Code settings or permissions: ${match.excerpt}`, status: 'fail' })
    }
    for (const match of findAll(text, CLAUDE_LOAD_DIR, 3)) {
      if (writes) commands.push({ file: file.path, line: match.line, excerpt: `writes where Claude Code loads plugins, skills or memory: ${match.excerpt}`, status: 'fail' })
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

function dangersIn(command: string): string[] {
  const found = DANGERS.filter(({ pattern }) => pattern.test(command)).map(({ what }) => what)
  if (PERSISTENCE_TARGET.test(command) && WRITE_SHELL.test(command)) found.push('writes to a startup or persistence location')
  if (CLAUDE_SETTINGS.test(command)) found.push('changes Claude Code settings or permissions')
  if (CLAUDE_LOAD_DIR.test(command) && WRITE_SHELL.test(command)) found.push('writes where Claude Code loads plugins, skills or memory')
  return found
}

export type { HookCommand }

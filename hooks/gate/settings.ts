// What a change to a Claude Code settings file lets Claude do: permissions,
// hooks and the other commands settings run, environment variables, MCP
// approvals and plugins. Judged from the file before and after the change: a
// change that only narrows what runs is noted, one that widens it is held.

import { belongsTo } from '../scan/checks/mcp'
import { dangersIn } from '../scan/checks/hooks'
import { wideShellGrant } from '../scan/checks/prompts'
import type { Evidence, Status } from '../scan/checks/types'
import { safeLine } from '../scan/safe-text'

/** Settings that change nothing Claude may run or reach. */
const PLAIN = new Set([
  '$schema', 'theme', 'model', 'outputStyle', 'language', 'cleanupPeriodDays', 'includeCoAuthoredBy', 'verbose', 'autoUpdates', 'autoUpdatesChannel',
  'preferredNotifChannel', 'editorMode', 'spinnerTipsEnabled', 'alwaysThinkingEnabled', 'companyAnnouncements', 'feedbackSurveyRate', 'respectGitignore',
  'forceLoginMethod', 'forceLoginOrgUUID', 'statusLineEnabled', 'messageIdleNotifThresholdMs', 'showTurnDuration',
])

/**
 * A shell rule held to a program and a fixed next word that is no option:
 * `Bash(npm test:*)`, not `Bash(python3 -c:*)`, and with no shell operator
 * that would let it run more (`Bash(npm test; curl …:*)`).
 */
const NARROWED = /^Bash\(\s*[^\s:()*;&|<>$`]+\s+[^\s:()*;&|<>$`-][^:()*;&|<>$`\n]*(?::\s*\*)?\s*\)$/i

/** Programs that run the command they are given: held to one word, they are still free to run anything. */
const RUNNERS = new Set(['sudo', 'doas', 'su', 'env', 'eval', 'exec', 'command', 'builtin', 'time', 'timeout', 'nice', 'nohup', 'xargs', 'watch', 'npx', 'bunx', 'pnpx', 'uvx', 'pipx', 'stdbuf', 'setsid', 'chroot', 'flock'])

/**
 * Why a shell rule lets any command run, or undefined when it is held to one:
 * a program that runs whatever it is given, a package manager's `run` or
 * `exec` with no script named, or what the scan holds of any rule not held
 * to one program and a fixed next word.
 */
function shellReach(rule: string): string | undefined {
  const words = (/^Bash\s*\(([\s\S]*)\)$/i.exec(rule.trim())?.[1] ?? '').replace(/:\s*\*\s*$/, '').trim().split(/\s+/)
  const program = (words[0] ?? '').split('/').pop()?.toLowerCase() ?? ''
  if (RUNNERS.has(program)) return 'a program that runs the command it is given: any command through it'
  if (/^(?:npm|pnpm|yarn|bun|uv)$/.test(program) && /^(?:run|run-script|exec|x|dlx)$/.test(words[1] ?? '') && words.length < 3) return 'a package manager running any script or package'
  // A program held to one subcommand (`npm test`, `npm run lint`) is narrowed; one free to take any is not.
  return NARROWED.test(rule) ? undefined : wideShellGrant(rule)
}

/** Settings that run a command: the command they run. */
const HELPERS: Record<string, string> = {
  apiKeyHelper: 'to make the API key',
  awsAuthRefresh: 'to refresh AWS sign-in',
  awsCredentialExport: 'to export AWS credentials',
  otelHeadersHelper: 'to make telemetry headers',
}

/** Environment variables that change where Claude's traffic goes, or what code runs. */
const REDIRECTS = /^(?:ANTHROPIC_(?:BEDROCK_|VERTEX_)?BASE_URL|[A-Z_]*_BASE_URL|HTTPS?_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|REQUESTS_CA_BUNDLE)$/i
const RUNS = /^(?:NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|PATH|PYTHONPATH|PYTHONSTARTUP|BASH_ENV|ENV|PERL5OPT|RUBYOPT|JAVA_TOOL_OPTIONS|CLAUDE_CODE_SHELL_PREFIX|SHELL)$/i

/**
 * What the change from `before` to `after` widens, narrows or leaves alone,
 * as evidence: a red flag for what lets anything run or leave unasked, worth
 * a look for any other new power, and a note for what only narrows. A
 * setting the guard does not know is worth a look when it changes.
 */
export function settingsChange(before: Record<string, unknown>, after: Record<string, unknown>, file: string): Evidence[] {
  const out: Evidence[] = []
  const note = (excerpt: string, status: Status): void => {
    out.push({ file, excerpt: safeLine(excerpt).slice(0, 300), status })
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[key]
    const now = after[key]
    if (stable(was) === stable(now) || PLAIN.has(key)) continue
    if (key === 'permissions') permissions(record(was), record(now), note)
    else if (key === 'hooks') hooks(record(was), record(now), note)
    else if (key === 'env') env(record(was), record(now), note)
    // A helper taken away runs nothing more.
    else if (Object.hasOwn(HELPERS, key)) now === undefined ? note(`no longer runs a command ${HELPERS[key]}`, 'info') : command(now, `runs ${typeof now === 'string' ? now : '(not text)'} ${HELPERS[key]}`, note)
    else if (key === 'statusLine') record(now).command === undefined ? note('no longer runs a command for the status line', 'info') : command(record(now).command, `runs ${String(record(now).command)} for the status line`, note)
    // The names are matched as escaped patterns, which the guard's own scan reads as inert, not as settings changed.
    else if (/^enableAllProjectMcpServers(?![\s\S])/.test(key)) note(now === true ? 'approves every MCP server a project names, without asking' : 'asks again before a project MCP server starts', now === true ? 'fail' : 'info')
    else if (/^enabledMcpjsonServers(?![\s\S])/.test(key)) for (const name of added(list(was), list(now))) note(`approves the project MCP server ${name} without asking`, 'warn')
    else if (key === 'disabledMcpjsonServers') for (const name of added(list(now), list(was))) note(`no longer turns off the project MCP server ${name}`, 'warn')
    else if (key === 'enabledPlugins') {
      for (const [name, on] of Object.entries(record(now))) if (on === true && record(was)[name] !== true) note(`turns on the plugin ${name} without /plugin install, so the guard did not scan it`, 'warn')
    } else if (key === 'extraKnownMarketplaces') {
      // A marketplace added, or one kept under its name but pointed somewhere else.
      for (const [name, source] of Object.entries(record(now))) {
        if (!Object.hasOwn(record(was), name)) note(`adds the marketplace ${name}`, 'warn')
        else if (stable(record(was)[name]) !== stable(source)) note(`changes where the marketplace ${name} comes from`, 'warn')
      }
    }
    // Hooks can guard as well as act: turning them all off can take a guard away.
    else if (key === 'disableAllHooks') note(now === true ? 'turns every hook off, any that guard tool calls included' : 'turns hooks back on', 'warn')
    else note(`changes ${key}, a setting the guard does not judge`, now === undefined ? 'info' : 'warn')
  }
  return out
}

type Note = (excerpt: string, status: Status) => void

function permissions(was: Record<string, unknown>, now: Record<string, unknown>, note: Note): void {
  for (const rule of added(list(was.allow), list(now.allow))) {
    const wide = shellReach(rule)
    if (wide !== undefined) note(`allows ${rule} without asking: ${wide}`, 'fail')
    else note(`allows ${rule} without asking`, 'warn')
  }
  for (const rule of added(list(now.allow), list(was.allow))) note(`no longer allows ${rule} without asking`, 'info')
  for (const kind of ['deny', 'ask'] as const) {
    for (const rule of added(list(now[kind]), list(was[kind]))) note(`no longer ${kind === 'deny' ? 'blocks' : 'asks before'} ${rule}`, 'warn')
    for (const rule of added(list(was[kind]), list(now[kind]))) note(`${kind === 'deny' ? 'blocks' : 'asks before'} ${rule}`, 'info')
  }
  if (stable(was.defaultMode) !== stable(now.defaultMode)) {
    const mode = String(now.defaultMode ?? 'default')
    const status: Status = /^(?:bypassPermissions|dontAsk)$/.test(mode) ? 'fail' : mode === 'acceptEdits' ? 'warn' : 'info'
    note(`sets the default permission mode to ${mode}`, status)
  }
  for (const dir of added(list(was.additionalDirectories), list(now.additionalDirectories))) note(`lets Claude work in ${dir}`, 'warn')
  if (stable(was.disableBypassPermissionsMode) !== stable(now.disableBypassPermissionsMode)) {
    note(now.disableBypassPermissionsMode === 'disable' ? 'turns off the mode that skips permission checks' : 'lets the mode that skips permission checks be used again', now.disableBypassPermissionsMode === 'disable' ? 'info' : 'warn')
  }
  const known = new Set(['allow', 'deny', 'ask', 'defaultMode', 'additionalDirectories', 'disableBypassPermissionsMode'])
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (!known.has(key) && stable(was[key]) !== stable(now[key])) note(`changes permissions.${key}, which the guard does not judge`, 'warn')
  }
}

/** Every hook added, changed or taken away, judged by what it runs; the same hook under another matcher runs for more, so it counts. */
function hooks(was: Record<string, unknown>, now: Record<string, unknown>, note: Note): void {
  // A hook taken away may have been one that guarded tool calls, for every
  // tool or for the ones its matcher names: the same hook kept for another
  // matcher no longer covers these.
  for (const [event, groups] of Object.entries(was)) {
    const after = new Set(hookItems(now[event]).map(entry => stable(entry)))
    for (const entry of hookItems(groups)) {
      if (after.has(stable(entry))) continue
      const matcher = typeof entry.matcher === 'string' && entry.matcher !== '' ? ` for ${entry.matcher}` : ''
      note(`no longer runs ${String(entry.hook.command ?? entry.hook.url ?? entry.hook.prompt ?? 'a hook')} on ${event}${matcher}`, 'warn')
    }
  }
  for (const [event, groups] of Object.entries(now)) {
    const before = new Set(hookItems(was[event]).map(entry => stable(entry)))
    for (const entry of hookItems(groups)) {
      if (before.has(stable(entry))) continue
      const item = entry.hook
      const type = typeof item.type === 'string' ? item.type : 'command'
      if (type === 'command') command(item.command, `runs ${String(item.command ?? '(nothing)')} on ${event}`, note)
      else if (type === 'http') note(`sends each ${event} event to ${String(item.url ?? '(no address)')}`, isLocal(item.url) ? 'warn' : 'fail')
      else note(`asks a model (${type}) on ${event}: ${String(item.prompt ?? '')}`, 'warn')
    }
  }
}

/** The hooks a settings event lists, each with the matcher of its group: what it runs, and for which tools. */
function hookItems(groups: unknown): { matcher: unknown; hook: Record<string, unknown> }[] {
  if (!Array.isArray(groups)) return []
  return groups.flatMap(group => (Array.isArray(record(group).hooks) ? (record(group).hooks as unknown[]).map(hook => ({ matcher: record(group).matcher ?? null, hook: record(hook) })) : []))
}

function env(was: Record<string, unknown>, now: Record<string, unknown>, note: Note): void {
  for (const [name, value] of Object.entries(now)) {
    if (stable(was[name]) === stable(value)) continue
    const text = String(value)
    if (REDIRECTS.test(name)) {
      // Claude's own API at its own address is where it goes anyway.
      const host = hostOf(text)
      const own = /^ANTHROPIC_BASE_URL$/i.test(name) && host !== undefined && belongsTo('ANTHROPIC_API_KEY', host)
      note(`sets ${name} to ${text}${own ? '' : ', which sends Claude\'s traffic or trust somewhere else'}`, own ? 'info' : 'fail')
    } else if (RUNS.test(name)) note(`sets ${name} to ${text}, which changes what code runs`, 'fail')
    else note(`sets the environment variable ${name}`, 'warn')
  }
}

/** A command a setting runs: a red flag when it reaches out or runs downloaded code, else worth a look. */
function command(value: unknown, what: string, note: Note): void {
  if (typeof value !== 'string') {
    note(what, 'warn')
    return
  }
  const dangers = dangersIn(value)
  note(`${what}${dangers.length === 0 ? '' : `  [${dangers.join('; ')}]`}`, dangers.length === 0 ? 'warn' : 'fail')
}

function hostOf(address: string): string | undefined {
  try {
    return new URL(address).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function isLocal(address: unknown): boolean {
  const host = typeof address === 'string' ? hostOf(address) : undefined
  return host !== undefined && /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(host)
}

function added(was: readonly string[], now: readonly string[]): string[] {
  const before = new Set(was)
  return now.filter(item => !before.has(item))
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => (typeof item === 'string' ? item : JSON.stringify(item))) : []
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** JSON with every object's keys in order, so the same value compares equal however it is written. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

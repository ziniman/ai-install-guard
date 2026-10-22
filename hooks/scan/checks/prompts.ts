import { languageOf, secretName } from './code'
import { isCodeFile, isLive, type ScanContext } from './context'
import { CREDENTIAL_PATH, DOWNLOAD_AND_RUN, NETWORK_COMMAND, NETWORK_CODE, SECRET_ENV, UNPINNED_RUNNER } from './patterns'
import { basename, dirname, findAll, findFirst, spanKinds } from './text'
import { row, type CheckResult, type Evidence, type Status } from './types'

const GROUP = 'prompts' as const

/** Phrases that try to take over the model or hide from the person. */
const INJECTION: readonly RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|system|original)\s+(?:instructions?|prompts?|messages?|rules|guidelines|directions)/i,
  /\bdisregard\s+(?:(?:all|any)\s+)?(?:(?:the|your)\s+)?(?:(?:previous|prior|above|earlier|system|original)\s+)?(?:instructions?|prompts?|rules|guidelines)\b/i,
  /\bforget\s+(?:all\s+|everything\s+)?(?:about\s+)?(?:your|the|previous|prior)\s+(?:instructions?|rules|guidelines)/i,
  /\b(?:do\s+not|don['’]t|never)\s+(?:tell|inform|show|mention|reveal|disclose|alert|notify|warn)\s+(?:this\s+to\s+|it\s+to\s+|anything\s+to\s+)?(?:the\s+)?user\b/i,
  /\bwithout\s+(?:telling|asking|informing|notifying|alerting|showing|warning)\s+(?:the\s+)?user\b/i,
  /\b(?:silently|secretly|quietly|covertly|discreetly|invisibly)\s+(?:run|execute|send|upload|post|install|delete|remove|read|copy|modify|fetch|download|exfiltrate|transmit|forward|add|write|change|append|collect)\b/i,
  /\b(?:override|bypass|disable|circumvent|skip)\s+(?:the\s+|all\s+|any\s+|your\s+)?(?:permission|permissions|safety|security|sandbox|approval|approvals|guardrails?|confirmation)\b/i,
  /\bexfiltrat\w*/i,
  /\b(?:send|post|upload|forward|transmit)\s+(?:it|them|this|that|everything|all|the\s+\w+(?:\s+\w+)?)\s+to\s+(?:https?:\/\/|the\s+(?:url|endpoint|server|webhook)|this\s+(?:url|endpoint|server|webhook))/i,
  /\byou\s+are\s+now\s+(?:in\s+)?(?:developer|god|jailbreak|unrestricted|dan)\b/i,
  /\b(?:new|updated|real|actual)\s+system\s+(?:prompt|instructions?)\s*:/i,
  /<\s*\/?\s*(?:system|system-reminder|system_prompt|assistant)\s*>/i,
]

/** Text that talks to a security scanner instead of to a person. */
const SCANNER_ADDRESS: readonly RegExp[] = [
  /\bnote\s+(?:to|for)\s+(?:the\s+|any\s+)?(?:security\s+|ai\s+|automated\s+)?(?:scanners?|reviewers?|auditors?|analy[sz]ers?)\b/i,
  /\b(?:security\s+)?(?:scanners?|reviewers?|auditors?|analy[sz]ers?|llms?|language\s+models?|ai\s+(?:assistants?|models?|reviewers?))\b[^\n]{0,80}?\b(?:report|mark|classify|treat|consider|rate|flag|score)\b[^\n]{0,40}?\b(?:safe|pass(?:ed|ing)?|clean|benign|trusted|harmless|low[- ]risk|no\s+(?:issues|findings))\b/i,
  /\b(?:this|the)\s+(?:plugin|skill|mod|code|package|repo(?:sitory)?|extension)\s+(?:is|has\s+been)\s+(?:completely\s+|totally\s+|fully\s+|100%\s+)?(?:safe|benign|harmless|verified|audited|approved)\b[^\n]{0,60}?\b(?:report|mark|pass|ignore|skip|approve)\b/i,
]

const READ_VERB = /\b(?:cat|read|open|print|show|copy|upload|send|include|paste|output|display|load|attach|collect)\b/i

const REMOTE_INSTRUCTIONS =
  /\b(?:fetch|download|read|load|get|curl|retrieve|visit|open)\b[^\n]{0,80}?https?:\/\/\S{1,500}[^\n]{0,80}?\b(?:follow|execute|run|apply|obey|use|do)\b[^\n]{0,30}?\b(?:instructions?|steps|commands?|directions|it|them)\b|\bfollow\s+(?:the\s+)?(?:instructions?|steps|directions)\s+(?:at|from|in|on)\s+https?:\/\//i

/** Claude Code's own commands, which a skill or command should not shadow. */
const BUILT_IN_COMMANDS = new Set([
  'add-dir', 'agents', 'bug', 'clear', 'compact', 'config', 'context', 'cost', 'doctor', 'exit', 'export', 'feedback', 'help',
  'hooks', 'ide', 'init', 'install-github-app', 'login', 'logout', 'mcp', 'memory', 'model', 'output-style', 'permissions',
  'plugin', 'plugins', 'pr-comments', 'privacy-settings', 'release-notes', 'resume', 'review', 'rewind', 'sandbox',
  'security-review', 'skills', 'status', 'statusline', 'tasks', 'terminal-setup', 'theme', 'todos', 'upgrade', 'usage', 'vim',
])

const CLAIMS_ANTHROPIC = /\b(?:by|from|made\s+by|official(?:ly)?|verified\s+by|endorsed\s+by|approved\s+by)\s+anthropic\b|\banthropic[-\s]?(?:official|verified|certified)\b|\bofficial\s+claude\b/i

/**
 * What is wrong with a piece of model-facing text on its own (a prompt or
 * agent hook): injection fails when it reaches out, reading credentials
 * fails, anything else is a warning, as any model hook is.
 */
export function promptConcerns(text: string): { status: Status; reasons: string[] } {
  const reachesOut = NETWORK_COMMAND.test(text) || NETWORK_CODE.test(text) || /https?:\/\//.test(text) || CREDENTIAL_PATH.test(text)
  const reasons: string[] = []
  let status: Status = 'warn'
  if (INJECTION.some(pattern => pattern.test(text))) {
    reasons.push('prompt injection')
    if (reachesOut) status = 'fail'
  }
  if (CREDENTIAL_PATH.test(text) && READ_VERB.test(text)) {
    reasons.push('reads credentials')
    status = 'fail'
  }
  if (SCANNER_ADDRESS.some(pattern => pattern.test(text))) reasons.push('talks to the scanner')
  return { status, reasons }
}

export function promptChecks(ctx: ScanContext): CheckResult[] {
  const injection: Evidence[] = []
  const credentials: Evidence[] = []
  const tools: Evidence[] = []
  const remote: Evidence[] = []
  const names: Evidence[] = []

  for (const path of ctx.prompts) {
    const text = ctx.text(path)
    if (text === undefined) continue
    const live = isLive(ctx.roleOf(path))
    const cap = (status: Status): Status => (live ? status : 'info')
    const reachesOut = NETWORK_COMMAND.test(text) || NETWORK_CODE.test(text) || /https?:\/\//.test(text) || CREDENTIAL_PATH.test(text)

    for (const pattern of INJECTION) {
      for (const match of findAll(text, pattern, 3)) {
        const hidden = isInsideComment(text, match.line) ? ' (inside an HTML comment, hidden when rendered)' : ''
        injection.push({ file: path, line: match.line, excerpt: `${match.excerpt}${hidden}`, status: cap(reachesOut ? 'fail' : 'warn') })
      }
    }
    const hiddenInstructions = findAll(text, /<!--[\s\S]{0,5000}?-->/g, 10_000)
      .filter(comment => comment.text.length > 40 && /\b(?:run|execute|send|call|use|read|write|ignore|always|never|must)\b/i.test(comment.text))
      .slice(0, 5)
    for (const comment of hiddenInstructions) {
      injection.push({ file: path, line: comment.line, excerpt: `instructions inside an HTML comment, hidden when rendered: ${comment.excerpt}`, status: cap('warn') })
    }

    for (const match of findAll(text, CREDENTIAL_PATH, 5)) {
      const lineText = text.split('\n')[match.line - 1] ?? ''
      credentials.push({ file: path, line: match.line, excerpt: match.excerpt, status: cap(READ_VERB.test(lineText) ? 'fail' : 'warn') })
    }
    for (const match of findAll(text, SECRET_ENV, 5)) {
      const lineText = text.split('\n')[match.line - 1] ?? ''
      credentials.push({ file: path, line: match.line, excerpt: `names ${secretName(match)}`, status: cap(/\b(?:echo|print|printenv|cat|send|include|output)\b/i.test(lineText) ? 'fail' : 'warn') })
    }

    for (const match of findAll(text, REMOTE_INSTRUCTIONS, 3)) {
      remote.push({ file: path, line: match.line, excerpt: match.excerpt, status: cap('warn') })
    }
    // Telling the model to download and run code fails; a sentence warning
    // against it ("never run curl | sh") is still a warning, since negation
    // is easy to fake ("don't hesitate to run ...").
    for (const match of findAll(text, DOWNLOAD_AND_RUN, 3)) {
      const warnsAgainst = isNegated(text, match.index)
      remote.push({
        file: path,
        line: match.line,
        excerpt: `${warnsAgainst ? 'mentions' : 'tells the model to'} download and run code: ${match.excerpt}`,
        status: cap(warnsAgainst ? 'warn' : 'fail'),
      })
    }
    // An unpinned package runner counts only as a command (in a code span or
    // block), not prose about one ("npx is a package runner").
    for (const match of findAll(text, UNPINNED_RUNNER, 3, index => inCodeSpan(text, index))) {
      remote.push({ file: path, line: match.line, excerpt: `tells the model to run an unpinned package: ${match.excerpt}`, status: cap('warn') })
    }

    const front = frontmatter(text)
    for (const key of ['allowed-tools', 'tools']) {
      const value = front[key]
      if (value === undefined) continue
      for (const tool of toolList(value)) {
        const verdict = judgeTool(tool)
        if (verdict !== undefined) tools.push({ file: path, line: lineOfKey(text, key), excerpt: `${key}: ${tool} (${verdict.why})`, status: cap(verdict.status) })
      }
    }
    const mode = front.permissionMode ?? front['permission-mode']
    if (mode !== undefined && /\b(?:bypassPermissions|acceptEdits)\b/i.test(mode)) {
      tools.push({ file: path, line: lineOfKey(text, 'permissionMode'), excerpt: `permissionMode: ${mode}`, status: cap('fail') })
    }

    const name = (front.name ?? basename(path).replace(/\.(md|mdx|markdown)$/i, '')).trim().toLowerCase()
    const commandName = /(^|\/)SKILL\.md$/i.test(path) ? (front.name ?? basename(dirname(path))).toLowerCase() : name
    if (BUILT_IN_COMMANDS.has(commandName)) {
      names.push({ file: path, excerpt: `named /${commandName}, the same as a Claude Code command`, status: cap('warn') })
    }
    const claim = findFirst(`${front.name ?? ''}\n${front.description ?? ''}`, CLAIMS_ANTHROPIC)
    if (claim !== undefined) names.push({ file: path, excerpt: `claims to come from Anthropic: ${claim.excerpt}`, status: cap('warn') })
    if (/(^|\/)SKILL\.md$/i.test(path) && front.name !== undefined && front.name.trim() !== basename(dirname(path)) && dirname(path) !== '') {
      names.push({ file: path, excerpt: `skill name "${front.name.trim()}" differs from its folder "${basename(dirname(path))}"`, status: 'info' })
    }
  }

  const manifestName = typeof ctx.manifest?.name === 'string' ? ctx.manifest.name : ''
  const manifestText = `${manifestName}\n${typeof ctx.manifest?.description === 'string' ? ctx.manifest.description : ''}`
  const claim = findFirst(manifestText, CLAIMS_ANTHROPIC)
  if (claim !== undefined || /\banthropic\b/i.test(manifestName)) {
    names.push({ file: '.claude-plugin/plugin.json', excerpt: `presents itself as Anthropic's: ${claim?.excerpt ?? manifestName}`, status: 'warn' })
  }

  // Text aimed at the scanner, anywhere in the candidate but its own patterns and comments.
  const addressed: Evidence[] = []
  for (const file of ctx.files) {
    const text = ctx.text(file.path)
    if (text === undefined) continue
    const kindAt = isCodeFile(file.path, text) ? spanKinds(text, languageOf(file.path, text)) : undefined
    const status: Status = ctx.roleOf(file.path) === 'test' ? 'info' : 'warn'
    const seen = new Set<number>()
    for (const pattern of SCANNER_ADDRESS) {
      for (const match of findAll(text, pattern, 2)) {
        const kind = kindAt?.(match.index)
        if (kind === 'regex' || kind === 'comment' || seen.has(match.line)) continue
        seen.add(match.line)
        addressed.push({ file: file.path, line: match.line, excerpt: match.excerpt, status })
      }
    }
  }

  const results = [
    row({ id: 'prompts.injection', group: GROUP, title: 'Prompt injection', advice: 'Skills, commands and agents are instructions the model follows. Text that tells it to ignore you, hide what it does or send data out is an attack, more so when it names a URL or your keys.' }, injection),
    row({ id: 'prompts.credentials', group: GROUP, title: 'Instructions that touch credentials', advice: 'A skill has no reason to read your keys, tokens or browser data. Do not install one that asks the model to.' }, credentials),
    row({ id: 'prompts.tools', group: GROUP, title: 'Tool permissions it grants itself', advice: 'allowed-tools runs those tools without asking you. Bash with no pattern, a wildcard, an interpreter or a package runner is the same as giving it your shell.' }, tools),
    row({ id: 'prompts.remote', group: GROUP, title: 'Remote instructions and code', advice: 'Instructions or code loaded from a URL at run time can change after this scan, so they were never checked. Prefer skills that ship everything they run.' }, remote),
    row({ id: 'prompts.names', group: GROUP, title: 'Names and claims', advice: 'A name that shadows a built-in command or claims to be from Anthropic is a common way to be trusted by mistake.' }, names),
    row({ id: 'prompts.scanner', group: GROUP, title: 'Text addressed to a security scanner', advice: 'Legitimate plugins do not talk to scanners. This text cannot change the verdict here; treat it as a sign of intent.' }, addressed),
  ]
  return ctx.prompts.length === 0 ? results.filter(result => result.id === 'prompts.names' || result.id === 'prompts.scanner') : results
}

/** Programs that run anything they are given, fetch and run packages, or reach the network. */
const SHELL_WIDE = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd', 'osascript',
  'python', 'node', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'awk', 'gawk',
  'eval', 'exec', 'env', 'xargs', 'sudo', 'su', 'doas', 'nohup', 'timeout', 'watch',
  'npx', 'bunx', 'pnpx', 'uvx', 'pipx', 'npm', 'pnpm', 'yarn', 'uv',
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'scp', 'sftp', 'telnet',
])

/** Whether a negation (never, don't, do not, avoid) sits right before `index`. */
function isNegated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 40), index).split(/[.!?\n]/).pop() ?? ''
  return /\b(?:never|not|don['’]t|do not|avoid|instead of)\b(?:\W+\w+){0,3}\W*$/i.test(before)
}

/** Whether `index` falls inside a Markdown code span or fenced block. */
function inCodeSpan(text: string, index: number): boolean {
  const fences = (text.slice(0, index).match(/^[ \t]*(?:```|~~~)/gm) ?? []).length
  if (fences % 2 === 1) return true
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  const ticks = (text.slice(lineStart, index).match(/`/g) ?? []).length
  return ticks % 2 === 1 || /^[ \t]*\$\s/.test(text.slice(lineStart, index))
}

function judgeTool(tool: string): { status: Status; why: string } | undefined {
  const bash = /^Bash\s*(?:\(([\s\S]*)\))?$/i.exec(tool.trim())
  if (bash === null) return undefined
  const pattern = bash[1]?.trim()
  // Bash with no pattern runs any command unasked, exactly as Bash(*) does.
  if (pattern === undefined) return { status: 'fail', why: 'any shell command: no pattern narrows it' }
  if (/^\*+\s*(?::\s*\*+)?$/.test(pattern) || pattern === '') return { status: 'fail', why: 'a wildcard: any shell command' }
  // The program the pattern allows, without its path: `/bin/sh:*` is `sh`.
  const program = basename(/^[^\s:]+/.exec(pattern)?.[0] ?? '').toLowerCase()
  if (SHELL_WIDE.has(program) || /^python\d*(?:\.\d+)?$/.test(program)) {
    return { status: 'fail', why: 'an interpreter, package runner or network tool: any command through it' }
  }
  return undefined
}

function frontmatter(text: string): Record<string, string> {
  const match = /^\ufeff?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text)
  if (match === null) return {}
  const out: Record<string, string> = {}
  let lastKey: string | undefined
  for (const line of (match[1] as string).split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (pair !== null) {
      lastKey = pair[1] as string
      out[lastKey] = unquote((pair[2] as string).trim())
    } else if (lastKey !== undefined && /^[ \t]*-[ \t]+/.test(line)) {
      // A YAML list item, indented or at column 0 under its key.
      out[lastKey] = `${out[lastKey] ?? ''}${out[lastKey] ? ', ' : ''}${unquote(line.replace(/^[ \t]*-[ \t]+/, '').trim())}`
    }
  }
  return out
}

/** YAML's surrounding quotes, removed: `"help"` → `help`. */
function unquote(value: string): string {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value
}

/** `Bash(git:*), Read` or `[Bash, Read]` → the tool names, keeping each pattern whole. */
function toolList(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const char of value.replace(/^\[|\]$/g, '')) {
    if (char === '(') depth += 1
    if (char === ')') depth = Math.max(0, depth - 1)
    if ((char === ',' || (char === ' ' && depth === 0 && current.trim() !== '' && !current.endsWith('('))) && depth === 0) {
      if (current.trim() !== '') out.push(current.trim().replace(/^["']|["']$/g, ''))
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim() !== '') out.push(current.trim().replace(/^["']|["']$/g, ''))
  return out
}

function lineOfKey(text: string, key: string): number | undefined {
  return findFirst(text, new RegExp(`^${key}\\s*:`, 'm'))?.line
}

function isInsideComment(text: string, line: number): boolean {
  const lines = text.split('\n')
  const before = lines.slice(0, line).join('\n')
  return before.lastIndexOf('<!--') > before.lastIndexOf('-->')
}

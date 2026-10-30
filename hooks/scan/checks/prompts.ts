import { languageOf, secretName } from './code'
import { isCodeFile, isLive, type ScanContext } from './context'
import { CREDENTIAL_PATH, DOWNLOAD_AND_RUN, NETWORK_COMMAND, NETWORK_CODE, SECRET_ENV, UNPINNED_RUNNER } from './patterns'
import { belongsTo } from './mcp'
import { basename, dirname, findAll, findFirst, judgedMatches, lineIndex, spanKinds, type Match } from './text'
import { row, type CheckResult, type Evidence, type Status } from './types'

const GROUP = 'prompts' as const

/** Phrases that only an attack needs: overriding the model's instructions or posing as the system. */
const INJECTION: readonly RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|system|original)\s+(?:instructions?|prompts?|messages?|rules|guidelines|directions)/i,
  /\bdisregard\s+(?:(?:all|any)\s+)?(?:(?:the|your)\s+)?(?:(?:previous|prior|above|earlier|system|original)\s+)?(?:instructions?|prompts?|rules|guidelines)\b/i,
  /\bforget\s+(?:all\s+|everything\s+)?(?:about\s+)?(?:your|the|previous|prior)\s+(?:instructions?|rules|guidelines)/i,
  /\b(?:override|bypass|disable|circumvent|skip)\s+(?:the\s+|all\s+|any\s+|your\s+)?(?:permission|permissions|safety|security|sandbox|approval|approvals|guardrails?|confirmation)\b/i,
  /\b(?:send|post|upload|forward|transmit)\s+(?:it|them|this|that|everything|all|the\s+\w+(?:\s+\w+)?)\s+to\s+(?:https?:\/\/|the\s+(?:url|endpoint|server|webhook)|this\s+(?:url|endpoint|server|webhook))/i,
  /\byou\s+are\s+now\s+(?:in\s+)?(?:developer|god|jailbreak|unrestricted|dan)\b/i,
  /\b(?:new|updated|real|actual)\s+system\s+(?:prompt|instructions?)\s*:/i,
  /<\s*\/?\s*(?:system|system-reminder|system_prompt|assistant)\s*>/i,
]

/**
 * Phrases an attack uses to hide what it does, which ordinary text uses too
 * ("retries that give up without informing the user", "data exfiltration" in
 * a list of what a skill must not do). They count only when the same
 * paragraph names a way out: an address, a network tool, a credential.
 */
const HIDING: readonly RegExp[] = [
  /\b(?:do\s+not|don['’]t|never)\s+(?:tell|inform|show|mention|reveal|disclose|alert|notify|warn)\s+(?:this\s+to\s+|it\s+to\s+|anything\s+to\s+)?(?:the\s+)?user\b/i,
  /\bwithout\s+(?:telling|asking|informing|notifying|alerting|showing|warning)\s+(?:the\s+)?user\b/i,
  /\b(?:silently|secretly|quietly|covertly|discreetly|invisibly)\s+(?:run|execute|send|upload|post|install|delete|remove|read|copy|modify|fetch|download|exfiltrate|transmit|forward|add|write|change|append|collect)\b/i,
  /\bexfiltrat\w*/i,
]

/** Telling the model to keep something to itself, which a hidden comment has no other reason to do. */
const CONCEALMENT = /\b(?:never|don['’]t|do\s+not|without)\s+(?:mention(?:ing)?|tell(?:ing)?|say(?:ing)?|reveal(?:ing)?|disclos(?:e|ing)|show(?:ing)?|report(?:ing)?)\b/i

/** A remote address: anything but this machine. */
const REMOTE_ADDRESS = /\bhttps?:\/\/(?!(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?![\w.-]))[^\s'"`<>)]{1,300}/i

/** The closing mark for each opening quote. */
const CLOSING: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’', '`': '`', '«': '»' }

/**
 * Whether the phrase at `index`, `length` long, is quoted: inside a pair of
 * quote marks or backticks that closes soon after it, in the same
 * paragraph. A quoted "ignore previous instructions" is someone writing
 * about the phrase. An opening quote that never closes, or a quotation
 * that itself names an address, a network tool or a credential, is not a
 * mention: that is an instruction with quote marks around it.
 */
function isQuoted(text: string, index: number, length: number, frontEnd = 0): boolean {
  let head = text.slice(text.lastIndexOf('\n', index - 1) + 1, index)
  // In frontmatter the quotes around a YAML value are syntax, not quoting: the
  // model reads a quoted description all the same.
  if (index < frontEnd) head = head.replace(/^\s*(?:-\s+)?(?:[\w-]+\s*:\s*)?["']/, '')
  const open = openQuote(head) ?? (index < frontEnd ? undefined : openQuote(previousLine(text, index, head)))
  if (open === undefined) return false
  const after = text.slice(index + length, index + length + 200).split(/\n[ \t]*\n/)[0] ?? ''
  const close = after.indexOf(CLOSING[open.mark] ?? open.mark)
  if (close === -1) return false
  return !namesWayOut(`${open.text}${text.slice(index, index + length)}${after.slice(0, close)}`)
}

/** The quote left open at the end of `head`, and what it holds so far. */
function openQuote(head: string): { mark: string; text: string } | undefined {
  const last = head.at(-1) ?? ''
  if (Object.hasOwn(CLOSING, last)) return { mark: last, text: '' }
  for (const mark of ['"', '`']) {
    const count = head.split(mark).length - 1
    if (count % 2 === 1) return { mark, text: head.slice(head.lastIndexOf(mark) + 1) }
  }
  const curly = head.lastIndexOf('“')
  if (curly > head.lastIndexOf('”')) return { mark: '“', text: head.slice(curly + 1) }
  return undefined
}

/**
 * A quote opened at the end of the line before (`"ignore` then `previous
 * instructions"`) still holds a phrase that begins this line.
 */
function previousLine(text: string, index: number, head: string): string {
  if (head.trim() !== '') return ''
  const lineStart = text.lastIndexOf('\n', index - 1)
  if (lineStart <= 0) return ''
  const before = text.slice(text.lastIndexOf('\n', lineStart - 1) + 1, lineStart)
  return before.trim() === '' ? '' : `${before} `
}

/** The paragraph around `index`: the lines between the nearest blank lines. */
function paragraphAt(text: string, index: number): string {
  const before = text.slice(0, index)
  const start = Math.max(before.lastIndexOf('\n\n'), before.lastIndexOf('\n\r\n'))
  const end = text.indexOf('\n\n', index)
  return text.slice(start === -1 ? 0 : start, end === -1 ? text.length : end).slice(0, 5000)
}

/** Whether text names a way out: a remote address, a network tool or command, a credential. */
function namesWayOut(text: string): boolean {
  return REMOTE_ADDRESS.test(text) || NETWORK_COMMAND.test(text) || NETWORK_CODE.test(text) || CREDENTIAL_PATH.test(text) || SECRET_ENV.test(text)
}

/**
 * A plain `<system>` is a placeholder as often as a tag (`legacy/<system>`):
 * it counts only when a closing `</system>` follows. The other names, and
 * any closing tag, count wherever they are.
 */
function isTagAt(text: string, index: number): boolean {
  const open = /^<\s*system\s*>/i.exec(text.slice(index, index + 40))
  if (open === null) return true
  return /<\s*\/\s*system\s*>/i.test(text.slice(index + open[0].length, index + 20_000))
}

/** The end of a Markdown file's YAML frontmatter, or 0 when it has none. */
function frontmatterEnd(text: string): number {
  return /^\ufeff?---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/.exec(text)?.[0].length ?? 0
}

type Phrase = { match: Match; status: Status; note: string }

/**
 * Every injection phrase in a prompt, judged: quoted text is a mention; an
 * attack-only phrase fails when the prompt reaches out and warns otherwise;
 * a hiding phrase warns, or fails, only with a way out in its paragraph and
 * not when the sentence warns against it ("do not silently fetch").
 */
function injectionPhrases(text: string, reachesOut: boolean): Phrase[] {
  const frontEnd = frontmatterEnd(text)
  const quoted = ' (quoted: written about, not used)'
  const out: Phrase[] = []
  for (const pattern of INJECTION) {
    const judge = (index: number, found: string): { status: Status; note: string } => {
      if (!isTagAt(text, index)) return { status: 'pass', note: '' }
      if (isQuoted(text, index, found.length, frontEnd)) return { status: 'info', note: quoted }
      return { status: reachesOut ? 'fail' : 'warn', note: '' }
    }
    for (const { match, judgement } of judgedMatches(text, pattern, judge, 3)) out.push({ match, ...judgement })
  }
  for (const pattern of HIDING) {
    const judge = (index: number, found: string): { status: Status; note: string } => {
      if (isQuoted(text, index, found.length, frontEnd)) return { status: 'info', note: quoted }
      if (!/^(?:do\s+not|don|never)/i.test(found) && isNegated(text, index)) return { status: 'info', note: ' (warns against it)' }
      if (!namesWayOut(paragraphAt(text, index))) return { status: 'info', note: ' (nothing in its paragraph sends data or touches credentials)' }
      return { status: 'fail', note: '' }
    }
    for (const { match, judgement } of judgedMatches(text, pattern, judge, 3)) out.push({ match, ...judgement })
  }
  return out
}

/** Text that talks to a security scanner instead of to a person. */
const SCANNER_ADDRESS: readonly RegExp[] = [
  /\bnote\s+(?:to|for)\s+(?:the\s+|any\s+)?(?:security\s+|ai\s+|automated\s+)?(?:scanners?|reviewers?|auditors?|analy[sz]ers?)\b/i,
  // "Reviewer" or "auditor" alone is usually a person; it counts only as a tool.
  /\b(?:(?:security|ai|automated|static|code)\s+(?:scanners?|reviewers?|auditors?|analy[sz]ers?)|scanners?|analy[sz]ers?|llms?|language\s+models?|ai\s+(?:assistants?|models?))\b[^\n]{0,80}?\b(?:report|mark|classify|treat|consider|rate|flag|score)\b[^\n]{0,40}?\b(?:safe|pass(?:ed|ing)?|clean|benign|trusted|harmless|low[- ]risk|no\s+(?:issues|findings))\b/i,
  /\b(?:this|the)\s+(?:plugin|skill|mod|code|package|repo(?:sitory)?|extension)\s+(?:is|has\s+been)\s+(?:completely\s+|totally\s+|fully\s+|100%\s+)?(?:safe|benign|harmless|verified|audited|approved)\b[^\n]{0,60}?\b(?:report|mark|pass|ignore|skip|approve)\b/i,
]

const READ_VERB = /\b(?:cat|read|open|print|show|copy|upload|send|include|paste|output|display|load|attach|collect)\b/i

/** A command a skill or command runs as Claude Code expands it: `!` and the command in backquotes, of any length. */
const INLINE_COMMAND = /!`[^`]+`/g

/** An inline command that only prints its words: echo or printf, with no pipe, chaining, redirection or substitution. */
const PRINTS_ONLY = /^!`\s*(?:echo|printf)\b[^`|;&<>$()\n]*`$/

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
  const phrases = injectionPhrases(text, reachesOut).filter(phrase => phrase.status !== 'info')
  if (phrases.length > 0) {
    reasons.push('prompt injection')
    if (phrases.some(phrase => phrase.status === 'fail')) status = 'fail'
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
  const toolAccess = new Set<string>()
  const remote: Evidence[] = []
  const names: Evidence[] = []

  for (const path of ctx.prompts) {
    const text = ctx.text(path)
    if (text === undefined) continue
    const live = isLive(ctx.roleOf(path))
    const cap = (status: Status): Status => (live ? status : 'info')
    const reachesOut = NETWORK_COMMAND.test(text) || NETWORK_CODE.test(text) || /https?:\/\//.test(text) || CREDENTIAL_PATH.test(text)

    const inCode = codeSpans(text)
    for (const { match, status, note } of injectionPhrases(text, reachesOut)) {
      const hidden = isInsideComment(text, match.line) ? ' (inside an HTML comment, hidden when rendered)' : ''
      injection.push({ file: path, line: match.line, excerpt: `${match.excerpt}${note}${hidden}`, status: cap(status) })
    }
    // A comment is hidden when the Markdown is rendered, but the model reads
    // it. One that tells it to reach out or touch credentials is a warning;
    // an author's note is only reported. In a code block it is shown as code.
    const comments = findAll(text, /<!--[\s\S]{0,5000}?-->/g, 10_000, index => !inCode(index))
      .filter(comment => comment.text.length > 40 && /\b(?:run|execute|send|call|use|read|write|ignore|always|never|must)\b/i.test(comment.text))
    const risky = (comment: Match) => namesWayOut(comment.text) || DOWNLOAD_AND_RUN.test(comment.text) || [...INJECTION, ...HIDING, ...SCANNER_ADDRESS, CONCEALMENT].some(pattern => pattern.test(comment.text))
    for (const comment of [...comments.filter(risky), ...comments.filter(comment => !risky(comment))].slice(0, 5)) {
      injection.push(
        risky(comment)
          ? { file: path, line: comment.line, excerpt: `instructions inside an HTML comment, hidden when rendered: ${comment.excerpt}`, status: cap('warn') }
          : { file: path, line: comment.line, excerpt: `a note inside an HTML comment, hidden when rendered; it names no address, credential or command: ${comment.excerpt}`, status: 'info' },
      )
    }

    // Naming a credential file is not reading it: a fail needs a verb that reads it on the same line.
    const lines = text.split('\n')
    const lineOf = lineIndex(text)
    // The whole command: `cat \` on one line can read the key named on the next.
    const readsAt = (index: number) => ({ status: cap(READ_VERB.test(statementAt(lines, lineOf(index))) ? 'fail' : 'info') })
    for (const { match, judgement } of judgedMatches(text, CREDENTIAL_PATH, readsAt, 5)) {
      credentials.push({ file: path, line: match.line, excerpt: judgement.status === 'fail' ? match.excerpt : `names ${match.text.trim()}: ${match.excerpt}`, status: judgement.status })
    }
    const secretAt = (index: number, found: string) => secretUse(lines, { index, line: lineOf(index), text: found, excerpt: '' }, cap)
    for (const { match } of judgedMatches(text, SECRET_ENV, secretAt, 5)) credentials.push({ file: path, line: match.line, ...secretUse(lines, match, cap) })

    // A local address (a preview server the skill starts) is not remote.
    const remoteOnly = (index: number) => !/^[^\n]{0,120}?https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?![\w.-])/i.test(text.slice(index, index + 200))
    for (const match of findAll(text, REMOTE_INSTRUCTIONS, 3, remoteOnly)) {
      remote.push({ file: path, line: match.line, excerpt: match.excerpt, status: cap('warn') })
    }
    // Telling the model to download and run code fails; a sentence warning
    // against it ("never run curl | sh") is still a warning, since negation
    // is easy to fake ("don't hesitate to run ..."). A well-known installer
    // (Homebrew's, rustup's) is a step down: worth a look, not a red flag.
    const downloadAt = (index: number) => {
      const warnsAgainst = isNegated(text, index)
      const installer = knownInstaller(text.slice(index, index + 600).split('\n')[0] ?? '')
      return { warnsAgainst, installer, status: cap(installer === undefined ? (warnsAgainst ? 'warn' : 'fail') : warnsAgainst ? 'info' : 'warn') }
    }
    for (const { match, judgement } of judgedMatches(text, DOWNLOAD_AND_RUN, downloadAt, 3)) {
      const what = judgement.installer === undefined ? 'download and run code' : `download and run ${judgement.installer}`
      remote.push({ file: path, line: match.line, excerpt: `${judgement.warnsAgainst ? 'mentions' : 'tells the model to'} ${what}: ${match.excerpt}`, status: judgement.status })
    }
    // An unpinned package runner counts only as a command (in a code span or
    // block), not prose about one ("npx is a package runner"). It runs the
    // newest version of a package, as most setup instructions do: noted.
    for (const match of findAll(text, UNPINNED_RUNNER, 3, inCode)) {
      remote.push({ file: path, line: match.line, excerpt: `runs a package at whatever version is newest: ${match.excerpt}`, status: 'info' })
    }

    const front = frontmatter(text)
    const counts = cap('warn') === 'warn'
    // `!` and a command in backquotes runs as Claude Code expands the skill, before
    // the model reads it, and what it prints becomes part of the instructions.
    // Every one is read, however many come first; only the evidence shown is capped.
    let fetches = 0
    let runs = 0
    for (const match of findAll(text, INLINE_COMMAND, Number.POSITIVE_INFINITY)) {
      // Text from the internet: any program given an address that is not this machine, since too many can fetch one
      // (curl, git clone, a package manager) to list them. Only printing it, and nothing else, is not.
      if (REMOTE_ADDRESS.test(match.text) && !PRINTS_ONLY.test(match.text)) {
        if (fetches++ < 5) remote.push({ file: path, line: match.line, excerpt: `runs a command as it loads that puts text from the internet into its instructions: ${match.excerpt}`, status: cap('warn') })
        continue
      }
      if (runs++ < 5) tools.push({ file: path, line: match.line, excerpt: `runs a shell command as it loads, before Claude reads it: ${match.excerpt}`, status: 'info' })
      if (counts) toolAccess.add(`run shell commands as it loads, in ${whereItRuns(path, front)}`)
    }
    for (const key of ['allowed-tools', 'tools']) {
      const value = front[key]
      if (value === undefined) continue
      for (const tool of toolList(value)) {
        const verdict = judgeTool(tool)
        if (verdict === undefined) continue
        tools.push({ file: path, line: lineOfKey(text, key), excerpt: `${key}: ${tool} (${verdict.why})`, status: cap(verdict.status) })
        // Running the shell unasked is what the command can do, said plainly; it does not make it unsafe.
        if (counts) toolAccess.add(`run any shell command without asking, in ${whereItRuns(path, front)}`)
      }
    }
    const mode = front.permissionMode ?? front['permission-mode']
    if (mode !== undefined && /\b(?:bypassPermissions|acceptEdits)\b/i.test(mode)) {
      const bypass = /\bbypassPermissions\b/i.test(mode)
      tools.push({ file: path, line: lineOfKey(text, 'permissionMode'), excerpt: `permissionMode: ${mode}`, status: cap(bypass ? 'warn' : 'info') })
      if (counts) toolAccess.add(`${bypass ? 'run any tool without asking' : 'edit files without asking'}, in ${whereItRuns(path, front)}`)
    }

    const name = (front.name ?? basename(path).replace(/\.(md|mdx|markdown)$/i, '')).trim().toLowerCase()
    const commandName = /(^|\/)SKILL\.md$/i.test(path) ? (front.name ?? basename(dirname(path))).toLowerCase() : name
    // Claude Code's own command wins the bare name; a plugin's is still reached as /plugin:name.
    if (BUILT_IN_COMMANDS.has(commandName)) {
      names.push({ file: path, excerpt: `named /${commandName}, the same as a Claude Code command, which keeps the bare name`, status: 'info' })
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
    row({ id: 'prompts.tools', group: GROUP, title: 'Tool permissions it grants itself', advice: 'allowed-tools runs those tools without asking you. Bash with no pattern, a wildcard, an interpreter or a package runner is the same as giving it your shell.', access: [...toolAccess] }, tools, 'info'),
    row({ id: 'prompts.remote', group: GROUP, title: 'Remote instructions and code', advice: 'Instructions or code loaded from a URL at run time can change after this scan, so they were never checked. Prefer skills that ship everything they run.' }, remote),
    row({ id: 'prompts.names', group: GROUP, title: 'Names and claims', advice: 'A name that shadows a built-in command or claims to be from Anthropic is a common way to be trusted by mistake.' }, names),
    row({ id: 'prompts.scanner', group: GROUP, title: 'Text addressed to a security scanner', advice: 'Legitimate plugins do not talk to scanners. This text cannot change the verdict here; treat it as a sign of intent.' }, addressed),
  ]
  return ctx.prompts.length === 0 ? results.filter(result => result.id === 'prompts.names' || result.id === 'prompts.scanner') : results
}

/**
 * Install scripts that projects tell people to pipe into a shell: well known,
 * still code from the internet. Matched by exact host and the installer's
 * own path, so neither a look-alike host (get.docker.com.example) nor
 * another file on the same host counts.
 */
const INSTALLERS: readonly { host: string; path: RegExp; name: string }[] = [
  { host: 'raw.githubusercontent.com', path: /^\/Homebrew\/install\/(?:HEAD|master|main)\/install\.sh$/, name: "Homebrew's installer" },
  { host: 'sh.rustup.rs', path: /^\/?$/, name: "rustup's installer" },
  { host: 'raw.githubusercontent.com', path: /^\/nvm-sh\/nvm\/(?:v\d+\.\d+\.\d+|master)\/install\.sh$/, name: "nvm's installer" },
  { host: 'get.docker.com', path: /^\/?$/, name: "Docker's installer" },
  { host: 'bun.sh', path: /^\/install$/, name: "Bun's installer" },
  { host: 'deno.land', path: /^\/install\.sh$/, name: "Deno's installer" },
  { host: 'astral.sh', path: /^\/uv\/(?:\d+\.\d+\.\d+\/)?install\.sh$/, name: "uv's installer" },
  { host: 'install.python-poetry.org', path: /^\/?$/, name: "Poetry's installer" },
  { host: 'get.pnpm.io', path: /^\/install\.sh$/, name: "pnpm's installer" },
  { host: 'ollama.com', path: /^\/install\.sh$/, name: "Ollama's installer" },
  { host: 'claude.ai', path: /^\/install\.sh$/, name: "Claude Code's installer" },
  { host: 'tailscale.com', path: /^\/install\.sh$/, name: "Tailscale's installer" },
]

/**
 * The well-known installer a download-and-run command fetches, if every
 * address in it is that installer: one more address could be what runs.
 */
function knownInstaller(command: string): string | undefined {
  const addresses = Array.from(command.matchAll(/\b[a-z][\w+.-]*:\/\/[^\s'"`)]{1,300}/gi), found => found[0])
  if (addresses.length === 0) return undefined
  const names = new Set<string | undefined>(addresses.map(installerAt))
  return names.size === 1 ? [...names][0] : undefined
}

function installerAt(address: string): string | undefined {
  try {
    const url = new URL(address)
    // Only https, with no credentials, port, query or fragment to change what is fetched.
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.search !== '' || url.hash !== '') return undefined
    return INSTALLERS.find(entry => url.hostname === entry.host && entry.path.test(url.pathname))?.name
  } catch {
    return undefined
  }
}

/**
 * The lines a backslash at a line's end joins into one command, around `line`:
 * a curl split over several lines, its key on one of them.
 */
function statementAt(lines: readonly string[], line: number): string {
  let first = line - 1
  let last = line - 1
  while (first > 0 && /\\\s*$/.test(lines[first - 1] ?? '') && line - first < 20) first -= 1
  while (last < lines.length - 1 && /\\\s*$/.test(lines[last] ?? '') && last - line < 20) last += 1
  return lines.slice(first, last + 1).join('\n')
}

/**
 * What a prompt does with a secret it names: sending it anywhere but its own
 * service fails; printing it, where the transcript keeps it, is a warning;
 * naming it (a .env example, a setup step) is only noted.
 */
function secretUse(lines: readonly string[], match: Match, cap: (status: Status) => Status): { excerpt: string; status: Status } {
  const name = secretName(match)
  const statement = statementAt(lines, match.line)
  const hosts = Array.from(statement.matchAll(new RegExp(REMOTE_ADDRESS.source, 'gi')), found => {
    try {
      return new URL(found[0]).hostname.toLowerCase()
    } catch {
      return ''
    }
  }).filter(host => host !== '')
  const sends = NETWORK_COMMAND.test(statement) || /\b(?:send|upload|post|forward|transmit)\b/i.test(statement)
  const elsewhere = hosts.filter(host => !belongsTo(name, host))
  if (sends && elsewhere.length > 0) return { excerpt: `sends ${name} to ${elsewhere.slice(0, 2).join(', ')}: ${match.excerpt}`, status: cap('fail') }
  // Sent with no address written down (`$ENDPOINT`), it can go anywhere.
  if (sends && hosts.length === 0) return { excerpt: `sends ${name} to an address the command does not name: ${match.excerpt}`, status: cap('warn') }
  if (/\b(?:echo|print|printenv|cat)\b/i.test(statement)) return { excerpt: `prints ${name}, where the transcript keeps it: ${match.excerpt}`, status: cap('warn') }
  return { excerpt: `names ${name}${hosts.length > 0 && sends ? `, used with ${hosts.slice(0, 2).join(', ')}, the service it belongs to` : ''}`, status: 'info' }
}

/** Programs that run anything they are given, fetch and run packages, or reach the network. */
const SHELL_WIDE = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd', 'osascript',
  'python', 'node', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'awk', 'gawk',
  'eval', 'exec', 'env', 'xargs', 'sudo', 'su', 'doas', 'nohup', 'timeout', 'watch',
  'npx', 'bunx', 'pnpx', 'uvx', 'pipx', 'npm', 'pnpm', 'yarn', 'uv',
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'scp', 'sftp', 'telnet',
])

/**
 * Whether the words right before `index` tell the reader not to run what
 * follows: the nearest negation ("never run this:", "avoid", "do not use")
 * within three words. "Don't hesitate to run" or "never forget to run" urge
 * the reader on, so they are not a negation.
 */
function isNegated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 40), index).split(/[.!?\n]/).pop() ?? ''
  const last = Array.from(before.matchAll(/\b(?:never|not|don['’]t|do not|avoid|instead of)\b/gi)).at(-1)
  if (last === undefined) return false
  const rest = before.slice(last.index ?? 0)
  if (/^(?:never|not|don['’]t|do not)\s+(?:ever\s+)?(?:hesitate|forget|fail|neglect|wait)\b/i.test(rest)) return false
  return /^(?:never|not|don['’]t|do not|avoid|instead of)(?:\W+\w+){0,3}\W*$/i.test(rest)
}

/**
 * A lookup for whether an index falls inside a Markdown code span or fenced
 * block. Fences, line breaks and backticks are found once per text, so
 * asking about many matches stays linear.
 */
function codeSpans(text: string): (index: number) => boolean {
  const positions = (pattern: RegExp) => Array.from(text.matchAll(pattern), match => match.index ?? 0)
  const fences = positions(/^[ \t]*(?:```|~~~)/gm)
  const breaks = positions(/\n/g)
  const ticks = positions(/`/g)
  const prompts = new Map<number, boolean>()
  return index => {
    if (countBefore(fences, index) % 2 === 1) return true
    const line = countBefore(breaks, index)
    const lineStart = line === 0 ? 0 : (breaks[line - 1] as number) + 1
    if ((countBefore(ticks, index) - countBefore(ticks, lineStart)) % 2 === 1) return true
    let prompt = prompts.get(lineStart)
    if (prompt === undefined) {
      const shell = /[ \t]*\$\s/y
      shell.lastIndex = lineStart
      prompt = shell.test(text)
      prompts.set(lineStart, prompt)
    }
    return prompt
  }
}

/** How many of the sorted `positions` come before `index`. */
function countBefore(positions: number[], index: number): number {
  let low = 0
  let high = positions.length
  while (low < high) {
    const mid = (low + high) >> 1
    if ((positions[mid] as number) < index) low = mid + 1
    else high = mid
  }
  return low
}

/** Whether an allowed-tools or permission rule lets Claude run any shell command, and why. */
export function wideShellGrant(tool: string): string | undefined {
  return judgeTool(tool)?.why
}

function judgeTool(tool: string): { status: Status; why: string } | undefined {
  const bash = /^Bash\s*(?:\(([\s\S]*)\))?$/i.exec(tool.trim())
  if (bash === null) return undefined
  const pattern = bash[1]?.trim()
  // Bash with no pattern runs any command unasked, exactly as Bash(*) does: a
  // power the author chose, shown as what it can do rather than held against it.
  if (pattern === undefined) return { status: 'info', why: 'any shell command: no pattern narrows it' }
  if (/^\*+\s*(?::\s*\*+)?$/.test(pattern) || pattern === '') return { status: 'info', why: 'a wildcard: any shell command' }
  // The program the pattern allows, without its path: `/bin/sh:*` is `sh`.
  const program = basename(/^[^\s:]+/.exec(pattern)?.[0] ?? '').toLowerCase()
  if (SHELL_WIDE.has(program) || /^python\d*(?:\.\d+)?$/.test(program)) {
    return { status: 'info', why: 'an interpreter, package runner or network tool: any command through it' }
  }
  return undefined
}

/** Where a granted tool is used, in words: /review-pr, the pdf skill, the reviewer agent. */
function whereItRuns(path: string, front: Record<string, string>): string {
  const file = basename(path).replace(/\.(?:md|mdx|markdown)$/i, '')
  if (/(^|\/)SKILL\.md$/i.test(path)) return `the ${(front.name ?? basename(dirname(path))).trim().slice(0, 60)} skill`
  if (/(^|\/)agents\//.test(path)) return `the ${(front.name ?? file).trim().slice(0, 60)} agent`
  return `/${file.slice(0, 60)}`
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

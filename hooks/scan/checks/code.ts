import { safeLine } from '../safe-text'
import { isCodeFile, isLive, isMarkdown, isRecord, parseJson, type FileRole, type ScanContext } from './context'
import {
  CLAUDE_LOAD_DIR,
  CLAUDE_SETTINGS,
  CODE_FROM_TEXT,
  COLLECTION_HOST,
  CREDENTIAL_PATH,
  DECODE,
  DOWNLOAD_AND_RUN,
  NETWORK_CODE,
  NETWORK_COMMAND,
  PERSISTENCE_TARGET,
  PROCESS_CODE,
  PYTHON_CODE_FROM_TEXT,
  PYTHON_PROCESS,
  SECRET_ENV,
  SHELL_EVAL,
  WRITE_CODE,
  WRITE_SHELL,
} from './patterns'
import { basename, extension, findAll, findFirst, spanKinds, type Match, type SpanKind } from './text'
import { row, worse, type CheckResult, type Evidence, type Status } from './types'

const GROUP = 'code' as const

const CONFIG_EXTENSIONS = new Set(['json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'plist', 'xml'])
const LOCKFILES = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock)$|\.map$/
const JS_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts'])
const SHELL_EXTENSIONS = new Set(['sh', 'bash', 'zsh', 'fish', 'ksh'])
/** Names worth hiding by splitting them across strings. */
const SPLIT_NAMES = /\b(?:curl|wget|netcat|ncat|socat|child_process|execSync|spawnSync|execFile|eval|Function|subprocess|system|popen|powershell|bash|zsh|ssh|id_rsa|id_ed25519|credentials|Keychains|ANTHROPIC_API_KEY|GITHUB_TOKEN)\b|\.ssh\b|\.aws\b/

const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare', 'prepublish']

export function codeChecks(ctx: ScanContext): CheckResult[] {
  return [hiddenCheck(ctx), execCheck(ctx), obfuscationCheck(ctx), credentialsCheck(ctx), persistenceCheck(ctx), installScriptsCheck(ctx), registriesCheck(ctx), domainsCheck(ctx)]
}

type Language = 'js' | 'python' | 'shell' | 'other'

/** `#!/bin/bash` → bash, `#!/usr/bin/env -S node --flag` → node. */
export function interpreterOf(text: string): string {
  const line = /^#!\s*(\S+)((?:[ \t]+\S+)*)/.exec(text)
  if (line === null) return ''
  const program = basename(line[1] as string)
  if (program !== 'env') return program
  const args = (line[2] ?? '').trim().split(/\s+/).filter(arg => arg !== '' && !arg.startsWith('-') && !arg.includes('='))
  return basename(args[0] ?? '')
}

export function languageOf(path: string, text: string): Language {
  const ext = extension(path)
  if (JS_EXTENSIONS.has(ext)) return 'js'
  if (ext === 'py') return 'python'
  if (SHELL_EXTENSIONS.has(ext)) return 'shell'
  const shebang = interpreterOf(text)
  if (/^(?:node|deno|bun)$/.test(shebang)) return 'js'
  if (/^python/.test(shebang)) return 'python'
  if (/^(?:ba|z|da|k|fi)?sh$/.test(shebang)) return 'shell'
  return 'other'
}

type CodeFile = {
  path: string
  text: string
  role: FileRole
  language: Language
  /** What the character at an index is: code, string, comment or pattern. */
  kindAt: (index: number) => SpanKind
}

/** Text files the code checks read: code and config, never lockfiles. */
function codeFiles(ctx: ScanContext): CodeFile[] {
  const out: CodeFile[] = []
  for (const file of ctx.files) {
    if (!file.isText || LOCKFILES.test(file.path)) continue
    const text = ctx.text(file.path)
    if (text === undefined) continue
    if (isCodeFile(file.path, text) || CONFIG_EXTENSIONS.has(extension(file.path)) || basename(file.path).startsWith('.')) {
      const language = languageOf(file.path, text)
      const kindAt = isCodeFile(file.path, text) ? spanKinds(text, language) : () => 'string' as const
      out.push({ path: file.path, text, role: ctx.roleOf(file.path), language, kindAt })
    }
  }
  return out
}

/**
 * A match inside a comment or a regular expression describes text rather
 * than doing anything, so it is only reported.
 */
function judged(file: CodeFile, match: Match, status: Status, excerpt: string): Evidence {
  const kind = file.kindAt(match.index)
  const inert = kind === 'comment' || kind === 'regex'
  const capped = isLive(file.role) && !inert ? status : 'info'
  return { file: file.path, line: match.line, excerpt: inert ? `${excerpt} (in a ${kind === 'regex' ? 'pattern' : 'comment'})` : excerpt, status: capped }
}

/** Matches of `pattern` in the file's code and strings, not its comments or patterns. */
function active(file: CodeFile, pattern: RegExp, limit = 20): Match[] {
  return findAll(file.text, pattern, 10_000)
    .filter(match => {
      const kind = file.kindAt(match.index)
      return kind === 'code' || kind === 'string'
    })
    .slice(0, limit)
}

function writesFiles(file: CodeFile): boolean {
  if (file.language === 'shell') return active(file, WRITE_SHELL, 1).length > 0
  return active(file, WRITE_CODE, 1).length > 0
}

function capFor(role: FileRole): (status: Status) => Status {
  return status => (isLive(role) ? status : 'info')
}

const TAGS = /[\u{e0000}-\u{e007f}]+/gu
const VARIATION_SUPPLEMENT = /[\u{e0100}-\u{e01ef}]{2,}/gu
const BIDI = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g
const ZERO_WIDTH = /[\u200b-\u200d\u2060-\u2064\u180e\u00ad\u034f\u115f\u1160\u3164\uffa0]|(?!^)\ufeff/g
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g

function hiddenCheck(ctx: ScanContext): CheckResult {
  const evidence: Evidence[] = []
  for (const file of ctx.files) {
    const text = file.isText ? ctx.text(file.path) : undefined
    if (text === undefined) continue
    const role = ctx.roleOf(file.path)
    const cap = (status: Status): Status => (role === 'test' ? 'info' : role === 'doc' && status === 'fail' ? 'warn' : status)
    const isCode = isCodeFile(file.path, text)

    for (const match of findAll(text, TAGS, 5)) {
      evidence.push({ file: file.path, line: match.line, excerpt: `${[...match.text].length} invisible tag characters spelling "${decodeTags(match.text)}"`, status: cap('fail') })
    }
    for (const match of findAll(text, VARIATION_SUPPLEMENT, 3)) {
      evidence.push({ file: file.path, line: match.line, excerpt: `${[...match.text].length} invisible variation selectors in a row (a way to smuggle data)`, status: cap('fail') })
    }
    const bidi = findAll(text, BIDI, 5)
    for (const match of bidi) {
      evidence.push({ file: file.path, line: match.line, excerpt: `bidirectional control ${codePoints(match.text)}: text may read differently than it runs`, status: cap(isCode ? 'fail' : 'warn') })
    }
    const zero = findAll(text, ZERO_WIDTH, 50)
    if (zero.length > 0 && (isCode || isMarkdown(file.path))) {
      const first = zero[0] as (typeof zero)[number]
      evidence.push({ file: file.path, line: first.line, excerpt: `${zero.length}${zero.length === 50 ? '+' : ''} zero-width or invisible characters, first ${codePoints(first.text)}`, status: cap('warn') })
    }
    const ansi = findFirst(text, ANSI)
    if (ansi !== undefined) {
      evidence.push({ file: file.path, line: ansi.line, excerpt: 'terminal escape sequence: can hide or repaint text in a terminal', status: cap('warn') })
    }
  }
  return row(
    {
      id: 'code.hidden-characters',
      group: GROUP,
      title: 'Hidden characters',
      advice: 'Invisible tag characters carry text the model reads and you do not see. Bidirectional controls make code read differently than it runs. Neither belongs in a plugin.',
    },
    evidence,
  )
}

/** Tag characters U+E0020..U+E007E mirror printable ASCII. */
export function decodeTags(text: string): string {
  let out = ''
  for (const char of text) {
    const code = (char.codePointAt(0) as number) - 0xe0000
    out += code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : ''
  }
  return safeLine(out.length > 120 ? `${out.slice(0, 120)}…` : out)
}

function codePoints(text: string): string {
  return [...text].map(char => `U+${(char.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}`).join(' ')
}

function execCheck(ctx: ScanContext): CheckResult {
  const evidence: Evidence[] = []
  for (const file of codeFiles(ctx)) {
    if (!isCodeFile(file.path, file.text)) continue
    const inModule = file.role === 'module'
    const patterns: { pattern: RegExp; what: string }[] =
      file.language === 'python'
        ? [{ pattern: PYTHON_PROCESS, what: 'runs programs' }, { pattern: PYTHON_CODE_FROM_TEXT, what: 'runs code built from text' }]
        : file.language === 'shell'
          ? [{ pattern: SHELL_EVAL, what: 'evaluates text as shell code' }]
          : [{ pattern: PROCESS_CODE, what: 'runs programs' }, { pattern: CODE_FROM_TEXT, what: 'runs code built from text' }]
    for (const { pattern, what } of patterns) {
      for (const match of findAll(file.text, pattern, 3)) {
        evidence.push(judged(file, match, inModule ? 'fail' : 'warn', `${what}: ${match.excerpt}`))
      }
    }
    for (const match of findAll(file.text, DOWNLOAD_AND_RUN, 3)) {
      evidence.push(judged(file, match, 'fail', `downloads or decodes code and runs it: ${match.excerpt}`))
    }
  }
  return row(
    {
      id: 'code.execution',
      group: GROUP,
      title: 'Running programs and building code at run time',
      advice: 'Inside a mod this is a red flag: mods reach the machine only through $. In a script, check that each command it runs is one its purpose needs.',
    },
    evidence,
  )
}

function obfuscationCheck(ctx: ScanContext): CheckResult {
  const evidence: Evidence[] = []
  for (const file of codeFiles(ctx)) {
    const { path, text } = file
    const runs = [PROCESS_CODE, PYTHON_PROCESS, CODE_FROM_TEXT, SHELL_EVAL, PYTHON_CODE_FROM_TEXT].some(pattern => active(file, pattern, 1).length > 0)
    const decodes = active(file, DECODE, 1).length > 0
    const level: Status = runs && decodes ? 'fail' : 'warn'
    const found: { match: Match; what: string }[] = []
    const split: { line: number; what: string }[] = []
    for (const match of findAll(text, /(?<!data:[\w/+.-]{1,40};base64,)(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{200,}={0,2}/g, 2)) found.push({ match, what: `${match.text.length}-character base64 blob` })
    for (const match of findAll(text, /\b(?:[0-9a-fA-F]{2}){100,}\b/g, 2)) found.push({ match, what: `${match.text.length}-character hex blob` })
    for (const match of findAll(text, /String\.fromCharCode\s*\(\s*(?:\d+\s*,\s*){8,}|\bchr\s*\(\s*\d+\s*\)\s*\+\s*chr\s*\(/g, 2)) found.push({ match, what: `text built from character codes: ${match.excerpt}` })
    for (const match of findAll(text, /(?:\\x[0-9a-fA-F]{2}){16,}|(?:\\u00[0-9a-fA-F]{2}){12,}/g, 2)) found.push({ match, what: 'long run of escaped bytes' })
    const joined = text.replace(/(['"`])[ \t]*\+[ \t]*\1/g, '')
    if (joined !== text) {
      // A dangerous name that only appears once adjacent strings are joined
      // was split to hide it. Joining only happens in code, never a comment.
      const before = new Set(findAll(text, SPLIT_NAMES, 10_000).map(match => `${match.line}:${match.text}`))
      for (const match of findAll(joined, SPLIT_NAMES, 10_000)) {
        if (!before.has(`${match.line}:${match.text}`)) {
          split.push({ line: match.line, what: `a name split across strings to hide it: ${match.text}` })
          break
        }
      }
    }
    const padding = whitespacePadding(text)
    if (padding !== undefined) found.push({ match: padding, what: 'long run of whitespace pushing text out of view' })
    if (!isMarkdown(path)) {
      const dense = denseLine(text)
      if (dense !== undefined) found.push({ match: dense, what: 'a long line of random-looking text' })
    }
    for (const item of found) evidence.push(judged(file, item.match, level, item.what))
    for (const item of split) evidence.push({ file: path, line: item.line, excerpt: item.what, status: isLive(file.role) ? level : 'info' })
  }
  for (const path of ctx.prompts) {
    const text = ctx.text(path) ?? ''
    const padding = whitespacePadding(text)
    if (padding !== undefined) {
      evidence.push({ file: path, line: padding.line, excerpt: 'long run of whitespace pushing text out of view', status: capFor(ctx.roleOf(path))('warn') })
    }
  }
  return row(
    {
      id: 'code.obfuscation',
      group: GROUP,
      title: 'Obfuscated or encoded content',
      advice: 'Encoded blobs and split-up names hide what code does. Together with code that decodes and runs text, assume it is hiding a payload.',
    },
    evidence,
  )
}

/**
 * The first run of 300+ spaces or tabs, or 80+ blank lines, that is followed
 * by more text: padding that pushes content out of view. One linear pass, so
 * a file of nothing but spaces cannot stall the scan.
 */
export function whitespacePadding(text: string): Match | undefined {
  let line = 1
  let spaces = 0
  let blankLines = 0
  let runStart = -1
  let runLine = 1
  let lineHasText = false
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code === 32 || code === 9) {
      if (spaces === 0 && blankLines === 0) {
        runStart = i
        runLine = line
      }
      spaces += 1
    } else if (code === 10) {
      if (!lineHasText) {
        if (blankLines === 0 && spaces === 0) {
          runStart = i
          runLine = line
        }
        blankLines += 1
      } else {
        blankLines = 1
        runStart = i
        runLine = line + 1
      }
      spaces = 0
      lineHasText = false
      line += 1
    } else if (code !== 13) {
      if (spaces >= 300 || blankLines >= 80) {
        return { index: runStart, line: runLine, text: '', excerpt: '' }
      }
      spaces = 0
      blankLines = 0
      lineHasText = true
    }
  }
  return undefined
}

/**
 * The first line of 200+ characters that looks like random tokens: nearly all
 * letters, digits and `+/=_-`, at more than 5.6 bits a character.
 */
function denseLine(text: string): Match | undefined {
  let start = 0
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string
    const lineStart = start
    start += line.length + 1
    const trimmed = line.trim()
    if (trimmed.length < 200) continue
    const tokenChars = trimmed.replace(/[^A-Za-z0-9+/=_-]/g, '').length
    if (tokenChars / trimmed.length < 0.9) continue
    const counts = new Map<string, number>()
    for (const char of trimmed) counts.set(char, (counts.get(char) ?? 0) + 1)
    let entropy = 0
    for (const count of counts.values()) {
      const p = count / trimmed.length
      entropy -= p * Math.log2(p)
    }
    if (entropy > 5.6) return { index: lineStart + line.indexOf(trimmed), line: i + 1, text: trimmed, excerpt: '' }
  }
  return undefined
}

function credentialsCheck(ctx: ScanContext): CheckResult {
  const evidence: Evidence[] = []
  for (const file of codeFiles(ctx)) {
    if (file.role === 'hook-script') continue
    const sends = [NETWORK_CODE, NETWORK_COMMAND, COLLECTION_HOST].some(pattern => active(file, pattern, 1).length > 0)
    for (const pattern of [CREDENTIAL_PATH, SECRET_ENV]) {
      for (const match of findAll(file.text, pattern, 3)) {
        evidence.push(judged(file, match, sends ? 'fail' : 'warn', `${sends ? 'with network code in the same file: ' : ''}${match.excerpt}`))
      }
    }
  }
  return row(
    {
      id: 'code.credentials',
      group: GROUP,
      title: 'Credentials and secrets read by code',
      advice: 'Code that reads your keys, tokens or browser data and can reach the network can steal them. Do not install it unless that is plainly its job.',
    },
    evidence,
  )
}

function persistenceCheck(ctx: ScanContext): CheckResult {
  const evidence: Evidence[] = []
  for (const file of codeFiles(ctx)) {
    if (file.role === 'hook-script' || basename(file.path) === 'settings.json') continue
    const writes = writesFiles(file)
    for (const match of findAll(file.text, PERSISTENCE_TARGET, 3)) {
      evidence.push(judged(file, match, writes ? 'fail' : 'warn', `${writes ? 'writes to' : 'names'} a startup location: ${match.excerpt}`))
    }
    for (const match of findAll(file.text, CLAUDE_SETTINGS, 3)) {
      evidence.push(judged(file, match, writes ? 'fail' : 'warn', `Claude Code permission setting: ${match.excerpt}`))
    }
    if (writes) {
      for (const match of findAll(file.text, CLAUDE_LOAD_DIR, 3)) {
        evidence.push(judged(file, match, 'fail', `writes where Claude Code loads plugins, skills or memory: ${match.excerpt}`))
      }
    }
  }
  return row(
    {
      id: 'code.persistence',
      group: GROUP,
      title: 'Persistence and permission changes',
      advice: 'Writing to shell startup files, schedulers, git hooks or Claude Code settings outlives the plugin and can grant it more than you approved.',
    },
    evidence,
  )
}

function installScriptsCheck(ctx: ScanContext): CheckResult {
  const evidence: Evidence[] = []
  for (const file of ctx.files) {
    if (basename(file.path) !== 'package.json') continue
    const raw = ctx.text(file.path) ?? ''
    const parsed = parseJson(raw)
    if (!parsed.ok || !isRecord(parsed.value) || !isRecord(parsed.value.scripts)) continue
    const cap = capFor(ctx.roleOf(file.path))
    for (const name of LIFECYCLE_SCRIPTS) {
      const script = parsed.value.scripts[name]
      if (typeof script !== 'string') continue
      const remote = NETWORK_COMMAND.test(script) || DOWNLOAD_AND_RUN.test(script) || /\bnode\s+-e\b|\|\s*(?:ba|z)?sh\b|https?:\/\//.test(script)
      const line = findFirst(raw, new RegExp(`"${name}"\\s*:`))?.line
      evidence.push({ file: file.path, line, excerpt: `${name}: ${script}`, status: cap(remote ? 'fail' : 'warn') })
    }
  }
  return row(
    {
      id: 'code.install-scripts',
      group: GROUP,
      title: 'Package install scripts',
      advice: 'npm runs these on install with your permissions. One that fetches or runs remote code is a classic supply-chain attack.',
    },
    evidence,
  )
}

function registriesCheck(ctx: ScanContext): CheckResult {
  const evidence: Evidence[] = []
  for (const file of ctx.files) {
    const name = basename(file.path)
    const text = ctx.text(file.path)
    if (text === undefined) continue
    let pattern: RegExp | undefined
    if (/^\.npmrc$/.test(name)) pattern = /^\s*(?:@[\w-]+:)?registry\s*=\s*(?!https:\/\/registry\.npmjs\.org\/?\s*$).+$/m
    else if (name === '.yarnrc.yml' || name === '.yarnrc') pattern = /npmRegistryServer|^\s*registry\s+/m
    else if (name === 'pip.conf' || /^requirements.*\.txt$/.test(name)) pattern = /--(?:extra-)?index-url\b|^\s*-i\s+https?:|^\s*index-url\s*=/m
    else if (name === 'pyproject.toml' || name === 'uv.toml' || name === 'bunfig.toml') pattern = /\bindex-url\b|\[\[tool\.uv\.index\]\]|^\s*registry\s*=/m
    if (pattern === undefined) continue
    const match = findFirst(text, pattern)
    if (match !== undefined) evidence.push({ file: file.path, line: match.line, excerpt: match.excerpt, status: capFor(ctx.roleOf(file.path))('warn') })
  }
  return row(
    {
      id: 'code.registries',
      group: GROUP,
      title: 'Package registry redirects',
      advice: 'A custom registry decides what code an install fetches. Check that it belongs to the publisher.',
    },
    evidence,
  )
}

function domainsCheck(ctx: ScanContext): CheckResult {
  const hosts = new Map<string, { file: string; line: number }>()
  const evidence: Evidence[] = []
  const configFiles = new Set(ctx.mcpServers.map(server => server.file))
  for (const file of codeFiles(ctx)) {
    if (!isLive(file.role) && !configFiles.has(file.path)) continue
    for (const match of active(file, /\b(?:https?|wss?|ftp):\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)/g, 200)) {
      const host = (/\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)/.exec(match.text)?.[1] ?? '').toLowerCase()
      if (host === '' || /^(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|example\.(?:com|org|net))$/.test(host)) continue
      if (!hosts.has(host)) hosts.set(host, { file: file.path, line: match.line })
      if (/^\d{1,3}(?:\.\d{1,3}){3}$|^\[/.test(host)) {
        evidence.push(judged(file, match, 'warn', `talks to a raw IP address: ${host}`))
      }
      if (COLLECTION_HOST.test(match.excerpt)) {
        evidence.push(judged(file, match, 'warn', `talks to a host often used to collect data: ${host}`))
      }
    }
  }
  const status = evidence.reduce<Status>((acc, item) => worse(acc, item.status ?? 'info'), 'info')
  const list = [...hosts.keys()].sort()
  return {
    id: 'code.domains',
    group: GROUP,
    title: 'Network addresses in code and config',
    status,
    severity: status === 'warn' ? 'medium' : 'none',
    evidence: [
      ...evidence,
      ...(list.length > 0 ? [{ file: '-', excerpt: `${list.length} host${list.length === 1 ? '' : 's'}: ${list.slice(0, 30).join(', ')}${list.length > 30 ? ', …' : ''}`, status: 'info' as const }] : []),
    ],
    advice: 'Every address the code can talk to. Check each against what the plugin says it does.',
  }
}

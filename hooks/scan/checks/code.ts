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
  UNPINNED_RUNNER,
  WRITE_CODE,
  WRITE_SHELL,
} from './patterns'
import { basename, extension, findAll, findFirst, spanKinds, type Match, type SpanKind } from './text'
import { belongsTo } from './mcp'
import { describePrograms, programNames, programsIn, type ProgramUse } from './programs'
import { row, worse, type CheckResult, type Evidence, type Status } from './types'

const GROUP = 'code' as const

const CONFIG_EXTENSIONS = new Set(['json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'plist', 'xml'])
const LOCKFILES = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock)$|\.map$/
const LIVE_ROLES: ReadonlySet<FileRole> = new Set(['module', 'hook-script', 'server', 'prompt-script', 'bin', 'code'])
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
  /** Whether the index sits in a string of prose, such as a prompt for a model: text, not a command or a path. */
  inProse: (index: number) => boolean
}

/** Short words that ordinary English is full of and commands and paths are not. */
const PROSE_WORDS = /\b(?:the|a|an|and|or|to|of|is|are|be|in|it|that|this|with|for|not|do|does|you|your|if|when|which|should|must|can|any|no)\b/gi

/** How far either way the string around a match is read to tell prose from a command. */
const PROSE_WINDOW = 2000

/**
 * Whether `index` sits in a string literal that reads as prose: eight words
 * or more, three of them the small words English is made of. A command padded
 * with flags or a path is not prose; a prompt that quotes `eval()` is.
 */
export function proseTest(text: string, kindAt: (index: number) => SpanKind): (index: number) => boolean {
  // Many matches in one string are one answer: each window is read once.
  const seen = new Map<string, boolean>()
  return index => {
    if (kindAt(index) !== 'string') return false
    let start = index
    let end = index
    while (start > 0 && index - start < PROSE_WINDOW && kindAt(start - 1) === 'string') start -= 1
    while (end < text.length && end - index < PROSE_WINDOW && kindAt(end) === 'string') end += 1
    const key = `${start}:${end}`
    const known = seen.get(key)
    if (known !== undefined) return known
    const body = text.slice(start, end)
    const words = body.split(/\s+/).filter(word => /[A-Za-z]{2,}/.test(word)).length
    const prose = words >= 8 && (body.match(PROSE_WORDS)?.length ?? 0) >= 3
    seen.set(key, prose)
    return prose
  }
}

/** Text files the code checks read: code and config, never lockfiles. `only` narrows them to some paths. */
function codeFiles(ctx: ScanContext, only?: ReadonlySet<string>): CodeFile[] {
  const out: CodeFile[] = []
  for (const file of ctx.files) {
    if (only !== undefined && !only.has(file.path)) continue
    // Lockfiles and source maps are skipped, unless live code loads them.
    if (!file.isText || (LOCKFILES.test(file.path) && !LIVE_ROLES.has(ctx.roleOf(file.path)))) continue
    const text = ctx.text(file.path)
    if (text === undefined) continue
    // Whatever live code loads is code, whatever its name (a required ./helper.map).
    const loaded = LIVE_ROLES.has(ctx.roleOf(file.path))
    if (isCodeFile(file.path, text) || loaded || CONFIG_EXTENSIONS.has(extension(file.path)) || basename(file.path).startsWith('.')) {
      // A hook or server that runs the file with an interpreter decides how it is read.
      const language = ctx.interpreters.get(file.path) ?? languageOf(file.path, text)
      const code = isCodeFile(file.path, text)
      const kindAt = code ? spanKinds(text, language) : () => 'string' as const
      // Only code has strings to tell apart: a config file is all one "string".
      out.push({ path: file.path, text, role: ctx.roleOf(file.path), language, kindAt, inProse: code ? proseTest(text, kindAt) : () => false })
    }
  }
  return out
}

/**
 * A match inside a comment or a regular expression describes text rather
 * than doing anything, so it is only reported.
 */
function judged(file: CodeFile, match: Match, status: Status, excerpt: string, strict = false): Evidence {
  const kind = file.kindAt(match.index)
  if (!isLive(file.role)) return { file: file.path, line: match.line, excerpt, status: 'info' }
  if (kind === 'comment' || kind === 'regex') {
    return { file: file.path, line: match.line, excerpt: `${excerpt} (in a ${kind === 'regex' ? 'pattern' : 'comment'})`, status: 'info' }
  }
  // Prose in a string, such as a prompt that names eval() or a settings file, describes rather than does.
  if (!strict && status !== 'info' && file.inProse(match.index)) {
    return { file: file.path, line: match.line, excerpt: `${excerpt} (in prose, such as a prompt, not code)`, status: 'info' }
  }
  if (kind === 'trailing-comment') {
    // A comment after code on the same line is a classic place to hide a
    // command, so it can lower a failure to a warning, never further.
    return { file: file.path, line: match.line, excerpt: `${excerpt} (in a comment after code)`, status: status === 'fail' ? 'warn' : status }
  }
  return { file: file.path, line: match.line, excerpt, status }
}

/** Whether a match only describes: in a comment, a pattern or (unless `strict`) prose. Prose is a note too, so it comes after real code and cannot crowd it out. */
function describesOnly(file: CodeFile, index: number, strict: boolean): boolean {
  const kind = file.kindAt(index)
  return kind === 'comment' || kind === 'regex' || kind === 'trailing-comment' || (!strict && file.inProse(index))
}

/**
 * Matches of `pattern` that may run: everything but whole-line comments and
 * real patterns. A trailing comment counts here, since a tokenizer can be
 * fooled into one, and gates such as "does it write files" must not be.
 */
function active(file: CodeFile, pattern: RegExp, limit = 20): Match[] {
  return findAll(file.text, pattern, limit, index => {
    const kind = file.kindAt(index)
    return kind !== 'comment' && kind !== 'regex'
  })
}

/**
 * Every match of `pattern`, judged: live matches first (up to `limit`),
 * then at most two inert ones, so comments cannot crowd out real code.
 */
function evidenceFor(file: CodeFile, pattern: RegExp, status: Status, describe: (match: Match) => string, limit = 5, strict = false, only?: (index: number) => boolean): Evidence[] {
  const isInert = (index: number): boolean => describesOnly(file, index, strict)
  // `only` narrows the live matches, so the ones it leaves out cannot crowd out the rest.
  const live = findAll(file.text, pattern, limit, index => !isInert(index) && (only === undefined || only(index)))
  const inert = findAll(file.text, pattern, 2, isInert)
  // Several matches on one line that read the same are one finding.
  const seen = new Set<string>()
  return [...live, ...inert]
    .map(match => judged(file, match, status, describe(match), strict))
    .filter(item => {
      const key = `${item.line}\u0000${item.excerpt}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/** `ANTHROPIC_API_KEY=sk-...` → `ANTHROPIC_API_KEY`: the name, never what follows it. */
export function secretName(match: Match): string {
  return /[A-Z][A-Z0-9_]{2,}/.exec(match.text)?.[0] ?? match.text.trim().slice(0, 40)
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
const ANSI = /\u001b\[[0-9;?]{0,40}[A-Za-z]|\u001b\][^\u0007\u001b]{0,1000}\u0007/g

/** Whether the zero-width joiner at `index` sits between two emoji, as in 👨‍💻. */
function joinsEmoji(text: string, index: number): boolean {
  const before = /\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}\uFE0F]?$/u.test(text.slice(Math.max(0, index - 4), index))
  const after = /^\p{Extended_Pictographic}/u.test(text.slice(index + 1, index + 3))
  return before && after
}

function hiddenCheck(ctx: ScanContext): CheckResult {
  const evidence: Evidence[] = []
  let foundLone = false
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
    // In code a control that is all of a string, with nothing after it, is
    // only a warning, and only in a language the tokenizer knows. Failures
    // are found first, so no number of such strings can crowd out a real one.
    const language = isCode ? (ctx.interpreters.get(file.path) ?? languageOf(file.path, text)) : 'other'
    let kinds: ((index: number) => SpanKind) | undefined
    const kindAt = (index: number): SpanKind => (kinds ??= spanKinds(text, language))(index)
    const lone = (index: number): boolean => language !== 'other' && isLoneInString(text, index, kindAt)
    for (const match of findAll(text, BIDI, 5, index => !lone(index))) {
      evidence.push({ file: file.path, line: match.line, excerpt: `bidirectional control ${codePoints(match.text)}: text may read differently than it runs`, status: cap(isCode ? 'fail' : 'warn') })
    }
    if (language !== 'other') {
      for (const match of findAll(text, BIDI, 3, lone)) {
        // It cannot reorder any code: a note on how to write it, not a red flag.
        const status: Status = 'info'
        if (role !== 'test') foundLone = true
        const excerpt = `bidirectional control ${codePoints(match.text)} is all of a string: it cannot reorder code there, but the string looks empty; write it as ${escapeFor(match, file.path, text, language)}`
        evidence.push({ file: file.path, line: match.line, excerpt, status })
      }
    }
    // A zero-width joiner between emoji builds one emoji (a family, a profession): not hidden text.
    const zero = findAll(text, ZERO_WIDTH, 50, index => !(text[index] === '\u200d' && joinsEmoji(text, index)))
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
      advice: `Invisible tag characters carry text the model reads and you do not see. Bidirectional controls make code read differently than it runs. Neither belongs in a plugin.${
        foundLone ? " A plugin that needs a direction mark, as one for right-to-left text does, should write it as an escape such as '\\u200f', never the raw character, which makes its string look empty." : ''
      }`,
    },
    evidence,
  )
}

/**
 * Whether the bidirectional control at `index` is all of a one-line string,
 * as in `const RLM = '\u200f'`, with nothing after it on its line but blanks,
 * `;`, `,` or a comment. What it can reorder runs to the end of its line, and
 * there that is no code; what comes before it does not move.
 */
function isLoneInString(text: string, index: number, kindAt: (index: number) => SpanKind): boolean {
  const quote = text[index - 1]
  if ((quote !== "'" && quote !== '"') || text[index + 1] !== quote) return false
  if (kindAt(index - 1) !== 'string' || kindAt(index) !== 'string' || kindAt(index + 1) !== 'string') return false
  // The quote must open the string: what comes before it is no string, and no
  // `}`, which may close a template's `${...}` and leave the quote as its text.
  if (index >= 2 && (kindAt(index - 2) === 'string' || text[index - 2] === '}')) return false
  // Only LF ends the line here. U+2028 and U+2029 end a JavaScript line, but
  // editors often show them inline and U+2028 ends no bidi paragraph, so code
  // after one can still be reordered: that fails.
  for (let i = index + 2; i < text.length && text[i] !== '\n'; i += 1) {
    const char = text[i]
    if (char === ' ' || char === '\t' || char === ';' || char === ',') continue
    // Only a CR that ends the line: a lone one ends a line too, and code may follow it.
    if (char === '\r' && (i + 1 === text.length || text[i + 1] === '\n')) continue
    const kind = kindAt(i)
    if (kind !== 'comment' && kind !== 'trailing-comment') return false
  }
  return true
}

/** `'\u200f'` for a lone control, as its language writes the escape. */
function escapeFor(match: Match, path: string, text: string, language: Language): string {
  const hex = (match.text.codePointAt(0) as number).toString(16).padStart(4, '0')
  if (language !== 'shell') return `${text[match.index - 1]}\\u${hex}${text[match.index - 1]}`
  // fish reads the escape bare. Other shells differ (sh has no such escape,
  // and bash before 4.2 not in $'...'), but every printf takes octal bytes.
  if ((interpreterOf(text) || extension(path)) === 'fish') return `\\u${hex}`
  const octal = [...new TextEncoder().encode(match.text)].map(byte => `\\${byte.toString(8)}`).join('')
  return `"$(printf '${octal}')"`
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
  const uses: ProgramUse[] = []
  let buildsCode = 0
  let downloads = 0
  for (const file of codeFiles(ctx)) {
    // Code files, and anything live code runs or loads whatever its name.
    if (!isCodeFile(file.path, file.text) && !LIVE_ROLES.has(file.role)) continue
    const inModule = file.role === 'module'
    const python = [{ pattern: PYTHON_PROCESS, what: 'runs programs' }, { pattern: PYTHON_CODE_FROM_TEXT, what: 'runs code built from text' }]
    const shell = [{ pattern: SHELL_EVAL, what: 'evaluates text as shell code' }]
    const js = [{ pattern: PROCESS_CODE, what: 'runs programs' }, { pattern: CODE_FROM_TEXT, what: 'runs code built from text' }]
    // A file of no known language is checked as all of them.
    const patterns: { pattern: RegExp; what: string }[] =
      file.language === 'python' ? python : file.language === 'shell' ? shell : file.language === 'js' ? js : [...js, ...python, ...shell]
    for (const { pattern, what } of patterns) {
      // Starting programs is what a script can do; code built from text is worth a look; inside a mod, either is a red flag.
      const level: Status = inModule ? 'fail' : what === 'runs programs' ? 'info' : 'warn'
      evidence.push(...evidenceFor(file, pattern, level, match => `${what}: ${match.excerpt}`, 3))
    }
    // Never excused as prose: a download piped into a shell is the same in any sentence.
    evidence.push(...evidenceFor(file, DOWNLOAD_AND_RUN, 'fail', match => `downloads or decodes code and runs it: ${match.excerpt}`, 3, true))
    // The summary counts live code only: tests and docs are only reported.
    if (isLive(file.role)) {
      const keep = (index: number) => !['comment', 'regex', 'trailing-comment'].includes(file.kindAt(index))
      uses.push(...programsIn(file.path, file.text, file.language, keep))
      // The same language rules as the evidence, each place counted once.
      const fromText = file.language === 'js' ? [CODE_FROM_TEXT] : file.language === 'python' ? [PYTHON_CODE_FROM_TEXT] : file.language === 'shell' ? [SHELL_EVAL] : [CODE_FROM_TEXT, PYTHON_CODE_FROM_TEXT, SHELL_EVAL]
      buildsCode += new Set(fromText.flatMap(pattern => findAll(file.text, pattern, 50, keep).map(match => match.line))).size
      downloads += findAll(file.text, DOWNLOAD_AND_RUN, 50, keep).length
    }
  }
  return row(
    {
      id: 'code.execution',
      group: GROUP,
      title: 'Running programs and building code at run time',
      advice:
        'Check that each program fits what it says it does. Shells, compilers and programs chosen while it runs can do anything, so look at those first. Inside a mod any of this is a red flag: a mod reaches your machine only through Claude Code.',
      summary: summaryOrFallback(describePrograms(uses, { buildsCode, downloads }), evidence),
      access: programAccess(uses),
    },
    evidence,
    'info',
  )
}

/** The programs live code starts, for the verdict's "It can" line. */
function programAccess(uses: readonly ProgramUse[]): string[] {
  const named = programNames(uses)
  const lines = named.length === 0 ? [] : [`start ${named.slice(0, 4).join(', ')}${named.length > 4 ? ` and ${named.length - 4} more programs` : ''}`]
  if (uses.some(use => use.dynamic)) lines.push('start programs chosen while it runs')
  return lines
}

/** A row that found something but could not name it still says so in words. */
function summaryOrFallback(summary: string[], evidence: readonly Evidence[]): string[] {
  if (summary.length > 0 || !evidence.some(item => item.status !== 'pass')) return summary
  return ['Starts other programs; which ones could not be read from the code']
}

function obfuscationCheck(ctx: ScanContext): CheckResult {
  const evidence: Evidence[] = []
  for (const file of codeFiles(ctx)) {
    const { path, text } = file
    const runs = [PROCESS_CODE, PYTHON_PROCESS, CODE_FROM_TEXT, SHELL_EVAL, PYTHON_CODE_FROM_TEXT].some(pattern => active(file, pattern, 1).length > 0)
    const decodes = active(file, DECODE, 1).length > 0
    const level: Status = runs && decodes ? 'fail' : 'warn'
    const found: { match: Match; what: string }[] = []
    const split: { line: number; what: string; status: Status }[] = []
    const liveFirst = (pattern: RegExp): Match[] => {
      const isInert = (index: number): boolean => file.kindAt(index) === 'comment' || file.kindAt(index) === 'regex'
      return [...findAll(text, pattern, 2, index => !isInert(index)), ...findAll(text, pattern, 1, isInert)]
    }
    for (const match of liveFirst(/(?<!data:[\w/+.-]{1,40};base64,)(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{200,}={0,2}/g)) found.push({ match, what: `${match.text.length}-character base64 blob` })
    for (const match of liveFirst(/\b(?:[0-9a-fA-F]{2}){100,}\b/g)) found.push({ match, what: `${match.text.length}-character hex blob` })
    // A payload wrapped over short lines: four or more lines of nothing but base64.
    for (const match of liveFirst(/(?:^[ \t]{0,20}['"`]?[A-Za-z0-9+/]{40,120}={0,2}['"`]?(?:[ \t]{0,20}[,+\\])?[ \t]{0,20}\r?\n){4,}/gm)) found.push({ match, what: 'base64 wrapped over several lines' })
    for (const match of liveFirst(/String\.fromCharCode\s*\(\s*(?:\d+\s*,\s*){8,}|\bchr\s*\(\s*\d+\s*\)\s*\+\s*chr\s*\(/g)) found.push({ match, what: `text built from character codes: ${match.excerpt}` })
    for (const match of liveFirst(/(?:\\x[0-9a-fA-F]{2}){16,}|(?:\\u00[0-9a-fA-F]{2}){12,}/g)) found.push({ match, what: 'long run of escaped bytes' })
    // Adjacent literals joined, whatever their quotes and across line breaks:
    // "child" + '_process', or 'child'⏎+ '_process'.
    const JOIN = /(['"`])\s*\+\s*(['"`])/g
    const liveJoins = findAll(text, JOIN, Number.MAX_SAFE_INTEGER, index => {
      const plus = text.indexOf('+', index)
      return !['comment', 'trailing-comment', 'regex'].includes(file.kindAt(plus))
    })
    // Only the live joins are joined: one in a comment or pattern stays as written.
    let joined = text
    if (liveJoins.length > 0) {
      let rebuilt = ''
      let from = 0
      for (const join of liveJoins) {
        rebuilt += text.slice(from, join.index)
        from = join.index + join.text.length
      }
      joined = rebuilt + text.slice(from)
    }
    if (joined !== text) {
      // A dangerous name that only appears once adjacent strings are joined
      // was split to hide it: compare how often each name appears before and
      // after (joins in comments and patterns do not count), and report it at
      // the first live join.
      const count = (source: string): Map<string, number> => {
        const counts = new Map<string, number>()
        for (const match of findAll(source, SPLIT_NAMES, Number.MAX_SAFE_INTEGER)) counts.set(match.text, (counts.get(match.text) ?? 0) + 1)
        return counts
      }
      const beforeCounts = count(text)
      const firstJoin = liveJoins[0] as Match
      for (const [name, after] of count(joined)) {
        if (after > (beforeCounts.get(name) ?? 0)) {
          const match = { ...firstJoin, text: name }
          // A split name is a warning; once joined, if the code runs programs or
          // builds code (require("child" + '_process').exec), it fails.
          const runsJoined = [PROCESS_CODE, PYTHON_PROCESS, CODE_FROM_TEXT, SHELL_EVAL, PYTHON_CODE_FROM_TEXT].some(pattern => pattern.test(joined))
          split.push({ line: match.line, what: `a name split across strings to hide it: ${match.text}`, status: runsJoined ? 'fail' : level })
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
    for (const item of split) evidence.push({ file: path, line: item.line, excerpt: item.what, status: isLive(file.role) ? item.status : 'info' })
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
  const secrets = new Set<string>()
  const places = new Set<string>()
  const files = new Set<string>()
  const sending = new Set<string>()
  const access = new Set<string>()
  for (const file of codeFiles(ctx)) {
    // Hook scripts and MCP configuration are judged where their target is
    // known: the hooks check, and mcp.credentials with the server's host.
    if (file.role === 'hook-script' || file.role === 'mcp-config') continue
    const sends = [NETWORK_CODE, NETWORK_COMMAND, COLLECTION_HOST].some(pattern => active(file, pattern, 1).length > 0)
    const lead = sends ? 'with network code in the same file: ' : ''
    // A key file's bare name as a whole string ('id_rsa', '.npmrc'), in a file
    // with no network and no way to your home folder, is a name in a list (of
    // files never to send, say), not a file being read.
    const homeless = !sends && active(file, HOME_FOLDER, 50).every(match => file.inProse(match.index))
    const pathMatches = active(file, CREDENTIAL_PATH, 50)
    const named = new Set(pathMatches.filter(match => homeless && isBareName(file.text, match)).map(match => match.line))
    for (const match of pathMatches) if (!(homeless && isBareName(file.text, match))) named.delete(match.line)
    const paths = evidenceFor(file, CREDENTIAL_PATH, sends ? 'fail' : 'warn', match => `${lead}${match.excerpt}`, 3).map(item =>
      item.status === 'warn' && item.line !== undefined && named.has(item.line)
        ? { ...item, excerpt: `${item.excerpt} (a file name alone: this file has no network code and no path to your home folder)`, status: 'info' as const }
        : item,
    )
    // A key used with the service it belongs to is what the key is for; one that
    // can go anywhere else, or anywhere the code does not name, is a red flag.
    const keys = active(file, SECRET_ENV, 20).filter(match => !file.inProse(match.index))
    const dumps = keys.some(match => /process\.env|os\.environ|printenv|\benv\b/.test(match.text))
    const hosts = liveHosts(file)
    const ownService = sends && !dumps && !buildsAddress(file) && hosts.length > 0 && keys.every(match => hosts.every(host => belongsTo(secretName(match), host)))
    const keyStatus: Status = !sends ? 'info' : ownService ? 'info' : 'fail'
    const names = evidenceFor(file, SECRET_ENV, keyStatus, match => (ownService ? `uses ${secretName(match)} with ${hosts.slice(0, 3).join(', ')}, the service it belongs to` : `${lead}reads ${secretName(match)}`), 3)
    evidence.push(...paths, ...names)
    if (!isLive(file.role)) continue
    for (const match of active(file, CREDENTIAL_PATH, 20)) if (!file.inProse(match.index) && !named.has(match.line)) places.add(match.text.trim().replace(/\/$/, ''))
    // A dump of the whole environment (JSON.stringify(process.env), printenv) is every secret at once.
    for (const match of keys) secrets.add(/process\.env|os\.environ|printenv|\benv\b/.test(match.text) ? 'all your environment variables' : secretName(match))
    for (const match of keys) access.add(ownService ? `use your ${secretName(match)} with ${hosts.slice(0, 2).join(', ')}` : `read your ${dumps ? 'environment variables' : secretName(match)}`)
    if (paths.length + names.length > 0) {
      files.add(file.path)
      if (sends && !ownService) sending.add(file.path)
    }
  }
  const summary: string[] = []
  const things = [...secrets, ...places]
  if (things.length > 0) {
    summary.push(`Reads ${things.slice(0, 5).join(', ')}${things.length > 5 ? ` and ${things.length - 5} more` : ''}${sending.size > 0 ? ', in code that can also reach the network' : ''}`)
    if (secrets.size > 0) summary.push(`Secrets from your environment: ${[...secrets].join(', ')}`)
    if (places.size > 0) summary.push(`Credential files and stores: ${[...places].join(', ')}`)
    if (sending.size > 0) summary.push(`Read these first: ${[...sending].slice(0, 4).join(', ')} can also send data over the network`)
    summary.push(`In ${files.size} file${files.size === 1 ? '' : 's'}: ${[...files].slice(0, 4).join(', ')}${files.size > 4 ? ` and ${files.size - 4} more` : ''}`)
  }
  return row(
    {
      id: 'code.credentials',
      group: GROUP,
      title: 'Credentials and secrets read by code',
      advice: 'Code that reads your keys, tokens or browser data and can reach the network can steal them. Do not install it unless that is plainly its job.',
      summary,
      access: [...access].slice(0, 4),
    },
    evidence,
  )
}

/** Ways code reaches your home folder, where credential files live. */
const HOME_FOLDER = /~\/|\$\{?HOME\b|\bexpanduser\b|\bhomedir\b|\bPath\.home\b|\bUSERPROFILE\b|\benv(?:iron)?\b[^\n]{0,20}['"]HOME['"]|\benv\.HOME\b/

/** Whether a credential match is a whole string holding only a key file's name. */
function isBareName(text: string, match: Match): boolean {
  const quote = text[match.index - 1] ?? ''
  return /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.(?:netrc|npmrc|pypirc|git-credentials))$/.test(match.text) && /^['"`]$/.test(quote) && text[match.index + match.text.length] === quote
}

/**
 * `path` and the candidate's own files it loads, and theirs in turn (at most
 * 50 in all): what a script can do includes what its local modules do.
 */
export function localImports(ctx: ScanContext, path: string): string[] {
  const seen = new Set([path])
  const queue = [path]
  while (queue.length > 0 && seen.size < 50) {
    for (const target of ctx.imports.get(queue.shift() as string) ?? []) {
      if (seen.size >= 50 || seen.has(target)) continue
      seen.add(target)
      queue.push(target)
    }
  }
  return [...seen]
}

/** A network tool started as a program: `subprocess.run(['curl', ...])`, `spawn('wget', ...)`. */
const NETWORK_PROGRAM =
  /\b(?:run|call|check_call|check_output|Popen|spawn|spawnSync|execFile|execFileSync|execSync|exec|system|popen)\s*\(\s*\[?\s*['"`](?:(?:\/[\w.-]+)+\/)?(?:curl|wget|nc|ncat|netcat|socat|ssh|scp|sftp|telnet)\b/

/**
 * An address whose host is filled in while the code runs: `"https://" + host`,
 * `` `https://${host}` ``, f"https://{host}", or a scheme split into pieces
 * (`"https:/" + "/" + host`). Such code can send to a host it never writes
 * down, so the hosts it does name do not say where data goes.
 */
const BUILT_ADDRESS = /\b(?:https?|wss?):\/\/(?:["'`]\s*\+|\$\{|\{|%s)|["'`](?:(?:https?|wss?):\/{0,2}|\/\/)["'`]\s*\+|\+\s*["'`]:\/\//

/**
 * What the code in `paths` can reach: whether it has network code (or
 * starts a network tool) outside comments and patterns, and the hosts it
 * names outside comments, patterns and prose.
 */
export function networkOf(ctx: ScanContext, paths: readonly string[]): { sends: boolean; hosts: string[]; builtAddress: boolean } {
  let sends = false
  let builtAddress = false
  const hosts = new Set<string>()
  for (const file of codeFiles(ctx, new Set(paths))) {
    if (!sends) sends = [NETWORK_CODE, NETWORK_COMMAND, NETWORK_PROGRAM].some(pattern => active(file, pattern, 1).length > 0)
    if (!builtAddress) builtAddress = buildsAddress(file)
    for (const host of liveHosts(file)) hosts.add(host)
  }
  return { sends, hosts: [...hosts].filter(host => !/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/.test(host)), builtAddress }
}

/** Whether live code builds an address whose host is only known when it runs. */
function buildsAddress(file: CodeFile): boolean {
  return active(file, BUILT_ADDRESS, 20).some(match => !file.inProse(match.index))
}

/**
 * Whether `host` (with the `rest` of its address, for services known by a
 * path such as discord.com/api/webhooks) is a host built to collect data.
 * The match must be the host itself or a subdomain of it: a page on another
 * host that only names one in its path (docs.example.org/webhook.site) is not.
 */
function collectsAt(host: string, rest: string): boolean {
  if (host === '') return false
  const target = `${host}${rest}`
  const found = COLLECTION_HOST.exec(target)
  return found !== null && found.index < host.length && (found.index === 0 || target[found.index - 1] === '.')
}

/** The hosts live code names in its own strings: not in comments, patterns or prose. */
function liveHosts(file: CodeFile): string[] {
  const hosts = new Set<string>()
  for (const match of active(file, /\bhttps?:\/\/[^\s'"`<>)]{1,300}/g, 100)) {
    if (file.inProse(match.index)) continue
    try {
      hosts.add(new URL(match.text).hostname.toLowerCase())
    } catch {
      continue
    }
  }
  return [...hosts]
}

/**
 * Calls that only print what they are given, read or check a file, start a
 * program, or build a path, by the name they are called by.
 */
const PRINT_CALL =
  /^(?:console\.(?:log|info|warn|error|debug|trace|print)|print|(?:process|sys)\.(?:stdout|stderr)\.write|(?:logging|logger|log)\.(?:debug|info|warning|warn|error|critical|exception)|(?:click|typer)\.echo)$/
const READ_CALL =
  /^(?:(?:fs|fsp|fs\.promises)\.)?(?:existsSync|readFileSync|statSync|lstatSync|accessSync|readdirSync|realpathSync)$|^(?:fs|fsp|fs\.promises)\.(?:readFile|stat|lstat|access|readdir|realpath)$|^os\.path\.(?:exists|lexists|isfile|isdir|islink|getsize|getmtime)$|^os\.(?:stat|lstat|listdir|scandir|access)$|^glob\.i?glob$/
const RUN_CALL: Record<'js' | 'python', RegExp> = {
  js: /^(?:(?:child_process|cp)\.)?(?:execSync|exec|execFile|execFileSync|spawn|spawnSync)$/,
  python: /^(?:subprocess\.(?:run|call|check_call|check_output|Popen)|os\.system)$/,
}
const PATH_CALL = /^(?:path(?:\.posix|\.win32)?\.(?:join|resolve|normalize)|os\.path\.(?:join|expanduser|abspath|normpath|realpath)|(?:pathlib\.)?(?:Path|PurePath|PosixPath))$/
/** Python path methods that read or check the file. */
const READ_METHOD = /^\s*\.\s*(?:exists|is_file|is_dir|is_symlink|read_text|read_bytes|stat|lstat)\s*\(/
/** What may come before a script's path in a command that runs it: nothing, or the interpreter. */
const SCRIPT_RUNNER = /^\s*(?:(?:node|deno|bun|python[23]?|ruby|perl|bash|sh|zsh)\s+)?$/
const QUOTES = new Set(["'", '"', '`'])

/** How many characters `pathFlow` may walk in one file before it counts what is left as a write. */
const FLOW_BUDGET = 200_000
const FLOW_WINDOW = 2000
const MAX_FLOW_DEPTH = 4
const MAX_USES = 20

type Flow = 'mention' | 'write'

/**
 * Where a Claude Code path at `index` in a file that writes can go. It is a
 * mention when it only reaches calls that print it, read or check the file, or
 * start it as a script, followed through the names it is given and the calls
 * that build a path from it. Anything else, a call to the file's own function
 * included, counts as a write, as does every path in a shell script.
 */
function pathFlow(file: CodeFile): (index: number) => Flow {
  const { text, language } = file
  if (language !== 'js' && language !== 'python') return () => 'write'
  let budget = FLOW_BUDGET
  const named = new Map<string, Flow>()
  const isCode = (i: number) => file.kindAt(i) === 'code'

  /** The string literal around `index` (one run of string text), and what it says before `upTo`, if it opens there. */
  const literalAround = (index: number, upTo: number) => {
    let start = index
    let end = index
    while (start > 0 && file.kindAt(start - 1) === 'string') start -= 1
    while (end < text.length && file.kindAt(end) === 'string') end += 1
    budget -= end - start
    const quote = text[start] ?? ''
    const opens = QUOTES.has(quote) && !(language === 'js' && quote === '`' && start > 0 && text[start - 1] === '}')
    const triple = language === 'python' && text.startsWith(quote.repeat(3), start)
    // A path is a script when it is the first word, or follows its interpreter; its word starts after the last blank.
    const word = text.slice(start, upTo).search(/\S*$/) + start
    const before = opens ? text.slice(start + (triple ? 3 : 1), word) : undefined
    return { start, end, script: before !== undefined && SCRIPT_RUNNER.test(before) }
  }

  /** Where the value of the expression at [start, end) goes. */
  const flowOf = (start: number, end: number, script: boolean, depth: number): Flow => {
    if (depth > MAX_FLOW_DEPTH || budget <= 0) return 'write'
    const lineStart = text.lastIndexOf('\n', start - 1) + 1
    const lineEnd = text.indexOf('\n', end) === -1 ? text.length : text.indexOf('\n', end)
    const after = text.slice(end, lineEnd)
    if (language === 'python' && READ_METHOD.test(after)) return 'mention'
    // `NAME = <value>` on a line of its own: follow NAME.
    const binding = /^\s*(export\s+(?:default\s+)?)?(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=\n]{1,80})?(?<![=!<>])=\s*[rRbBfFuU]{0,2}$/.exec(text.slice(lineStart, start))
    if (binding?.[2] !== undefined && /^\s*;?\s*(?:(?:\/\/|#).*)?$/.test(after)) {
      // Exported, or a Python module's own name, other files may write to it: not followed.
      if (binding[1] !== undefined || (language === 'python' && !/^\s/.test(binding[0]))) return 'write'
      return usesOf(binding[2], lineStart, end, script, depth)
    }
    let level = 0
    for (let i = start - 1; i >= 0 && start - i < FLOW_WINDOW; i -= 1) {
      budget -= 1
      const kind = file.kindAt(i)
      const char = text[i]
      if (kind === 'string') {
        // The `${` of a template, which code follows: inside one, the value is the template's text.
        if (language === 'js' && char === '{' && text[i - 1] === '$' && file.kindAt(i + 1) !== 'string') {
          if (level === 0) {
            const literal = literalAround(i, i - 1)
            return flowOf(literal.start, literal.end, script && literal.script, depth + 1)
          }
          level -= 1
        }
        continue
      }
      if (kind !== 'code') continue
      if (char === ')' || char === ']' || char === '}') level += 1
      else if (char === '(' || char === '[' || char === '{') {
        if (level > 0) {
          level -= 1
          continue
        }
        // In an array, an object or a block: anything may be done with it.
        return char === '(' ? callFlow(i, start, script, depth) : 'write'
      } else if (char === ';' && level === 0) return 'write'
    }
    return 'write'
  }

  /** Where a value given to the call whose `(` is at `open` goes, the value starting at `start`. */
  const callFlow = (open: number, start: number, script: boolean, depth: number): Flow => {
    const from = Math.max(0, open - 200)
    const name = /[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*$/.exec(text.slice(from, open).trimEnd())
    const callee = name?.[0].replace(/\s+/g, '') ?? ''
    if (PRINT_CALL.test(callee)) return 'mention'
    const close = closeOf(open)
    if (close === -1) return 'write'
    // Node's read calls take a `flag` that opens the file to write (`'w'` empties it).
    if (READ_CALL.test(callee)) return /\bflags?\b/.test(text.slice(open, close)) ? 'write' : 'mention'
    if (RUN_CALL[language as 'js' | 'python'].test(callee)) return script && text.slice(open + 1, start).trim() === '' ? 'mention' : 'write'
    // A path built from it: follow the call's own value.
    return PATH_CALL.test(callee) ? flowOf(from + (name?.index ?? 0), close, script, depth + 1) : 'write'
  }

  /** The index just past the `)` that closes the call opened at `open`, or -1. */
  const closeOf = (open: number): number => {
    let level = 0
    for (let i = open; i < text.length && i - open < FLOW_WINDOW; i += 1) {
      budget -= 1
      if (!isCode(i)) continue
      if (text[i] === '(') level += 1
      else if (text[i] === ')' && --level === 0) return i + 1
    }
    return -1
  }

  /** Where the value a name is given goes: everywhere the name is used, but where it is given. */
  const usesOf = (name: string, from: number, to: number, script: boolean, depth: number): Flow => {
    const key = `${name}\u0000${script}`
    const known = named.get(key)
    if (known !== undefined) return known
    // Until it is known, a name that reaches itself is a write.
    named.set(key, 'write')
    const uses = findAll(text, new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`), MAX_USES + 1, index => (index < from || index >= to) && !['comment', 'trailing-comment', 'regex'].includes(file.kindAt(index)))
    let flow: Flow = uses.length > MAX_USES ? 'write' : 'mention'
    for (const use of uses) {
      if (flow === 'write') break
      const end = use.index + name.length
      if (file.kindAt(use.index) === 'string') {
        const literal = literalAround(use.index, use.index)
        flow = flowOf(literal.start, literal.end, script && literal.script, depth + 1)
      } else if (/^\s*(?:[.[(]|=(?![=>]))/.test(text.slice(end, end + 40))) {
        // Called, indexed, read a property of or given a new value: not followed.
        flow = 'write'
      } else {
        flow = flowOf(use.index, end, script, depth + 1)
      }
    }
    named.set(key, flow)
    return flow
  }

  return index => {
    if (file.kindAt(index) !== 'string') return flowOf(index, index, false, 0)
    const literal = literalAround(index, index)
    return flowOf(literal.start, literal.end, literal.script, 0)
  }
}

function persistenceCheck(ctx: ScanContext): CheckResult {
  const evidence: Evidence[] = []
  for (const file of codeFiles(ctx)) {
    if (file.role === 'hook-script' || basename(file.path) === 'settings.json') continue
    const writes = writesFiles(file)
    evidence.push(...evidenceFor(file, PERSISTENCE_TARGET, writes ? 'fail' : 'warn', match => `${writes ? 'writes to' : 'names'} a startup location: ${match.excerpt}`, 3))
    evidence.push(...evidenceFor(file, CLAUDE_SETTINGS, writes ? 'fail' : 'warn', match => `Claude Code permission setting: ${match.excerpt}`, 3))
    if (writes) {
      // A path that is only printed, read or run as a script is named, not written.
      const flowAt = pathFlow(file)
      const flows = new Map<number, Flow>()
      const flow = (index: number): Flow => flows.get(index) ?? flows.set(index, flowAt(index)).get(index) ?? 'write'
      evidence.push(...evidenceFor(file, CLAUDE_LOAD_DIR, 'fail', match => `writes where Claude Code loads plugins, skills or memory: ${match.excerpt}`, 3, false, index => flow(index) === 'write'))
      for (const match of findAll(file.text, CLAUDE_LOAD_DIR, 2, index => !describesOnly(file, index, false) && flow(index) === 'mention')) {
        evidence.push({ file: file.path, line: match.line, excerpt: `names where Claude Code loads plugins, skills or memory, only to print, read or run it: ${match.excerpt}`, status: 'info' })
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
  // Only a package that would be installed counts as what the plugin can do, not one in its tests or docs.
  let runsOnInstall = false
  for (const file of ctx.files) {
    if (basename(file.path) !== 'package.json') continue
    const raw = ctx.text(file.path) ?? ''
    const parsed = parseJson(raw)
    if (!parsed.ok || !isRecord(parsed.value) || !isRecord(parsed.value.scripts)) continue
    const cap = capFor(ctx.roleOf(file.path))
    for (const name of LIFECYCLE_SCRIPTS) {
      const script = parsed.value.scripts[name]
      if (typeof script !== 'string') continue
      const remote = NETWORK_COMMAND.test(script) || DOWNLOAD_AND_RUN.test(script) || UNPINNED_RUNNER.test(script) || /\bnode\s+-e\b|\|\s*(?:ba|z)?sh\b|https?:\/\//.test(script)
      const line = findFirst(raw, new RegExp(`"${name}"\\s*:`))?.line
      evidence.push({ file: file.path, line, excerpt: `${name}: ${script}`, status: cap(remote ? 'fail' : 'info') })
      if (cap('warn') === 'warn') runsOnInstall = true
    }
  }
  return row(
    {
      id: 'code.install-scripts',
      group: GROUP,
      title: 'Package install scripts',
      access: runsOnInstall ? ['run a script when its npm package is installed'] : [],
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
    if (/^\.npmrc$/.test(name)) pattern = /^[ \t]*(?:@[\w-]+:)?registry[ \t]*=[ \t]*(?!https:\/\/registry\.npmjs\.org\/?[ \t]*$).+$/m
    else if (name === '.yarnrc.yml' || name === '.yarnrc') pattern = /npmRegistryServer|^[ \t]*registry[ \t]+/m
    else if (name === 'pip.conf' || /^requirements.*\.txt$/.test(name)) pattern = /--(?:extra-)?index-url\b|^[ \t]*-i[ \t]+https?:|^[ \t]*index-url[ \t]*=/m
    else if (name === 'pyproject.toml' || name === 'uv.toml' || name === 'bunfig.toml') pattern = /\bindex-url\b|\[\[tool\.uv\.index\]\]|^[ \t]*registry[ \t]*=/m
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
  // What the plugin says it is for: a Telegram plugin talking to Telegram is doing its job.
  const purpose = [ctx.manifest?.name, ctx.manifest?.description].filter(item => typeof item === 'string').join(' ').toLowerCase()
  for (const file of codeFiles(ctx)) {
    if (!isLive(file.role) && !configFiles.has(file.path)) continue
    for (const match of active(file, /\b(?:https?|wss?|ftp):\/\/[^\s'"`<>)]{1,500}/g, 200)) {
      // The host is what follows any user-info: in https://a.com@b.site/ it is b.site.
      const authority = /\/\/([^/?#]{0,300})/.exec(match.text)?.[1] ?? ''
      const hasUserInfo = authority.includes('@')
      const host = (/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)/.exec(authority.slice(authority.lastIndexOf('@') + 1))?.[1] ?? '').toLowerCase()
      const lowered = match.text.toLowerCase()
      const collects = collectsAt(host, lowered.slice(lowered.indexOf(host) + host.length))
      // An address in prose, such as an example in a prompt, is not one the code
      // talks to; a host built to collect data is held against it anywhere.
      if (file.inProse(match.index) && !collects) continue
      // A one-word host (https://x) is a placeholder, not a place on the internet.
      if (host === '' || (!host.includes('.') && !host.startsWith('['))) continue
      if (hasUserInfo) evidence.push(judged(file, match, 'warn', `an address whose real host hides after "@": ${host}`))
      if (/^(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|example\.(?:com|org|net))$/.test(host)) continue
      if (!hosts.has(host)) hosts.set(host, { file: file.path, line: match.line })
      if (/^\d{1,3}(?:\.\d{1,3}){3}$|^\[/.test(host)) {
        evidence.push(judged(file, match, 'warn', `talks to a raw IP address: ${host}`))
      }
      if (collects) {
        const service = host.split('.').slice(-2, -1)[0] ?? ''
        const itsJob = service.length >= 4 && purpose.includes(service)
        evidence.push(judged(file, match, itsJob ? 'info' : 'warn', itsJob ? `talks to ${host}, the service it is for` : `talks to a host often used to collect data: ${host}`, collects))
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

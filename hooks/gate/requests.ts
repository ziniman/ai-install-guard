// What an install asks for, read from the text alone: the arguments of a
// `/plugin` command the person typed, or a shell command Claude is about to
// run. Nothing here runs anything or touches the disk.

import { safeLine } from '../scan/safe-text'

/** One thing to add to Claude Code: a plugin from a marketplace, or a marketplace. */
export type InstallRequest =
  | { kind: 'plugin'; verb: 'install' | 'update'; plugin: string; marketplace?: string }
  | { kind: 'marketplace'; source: string }

export type Reading =
  /** Not an install, or Claude Code's own menu to pick one from, which the guard cannot hold yet. */
  | { kind: 'pass'; browse: boolean }
  | { kind: 'install'; request: InstallRequest; label: string }
  /** An install the guard cannot read well enough to scan: it is held as Could not verify. */
  | { kind: 'unreadable'; label: string; reason: string }

const PASS: Reading = { kind: 'pass', browse: false }
const BROWSE: Reading = { kind: 'pass', browse: true }

/** A plugin as `install` takes it: `name` or `name@marketplace`. */
const PLUGIN_ID = /^([A-Za-z0-9][\w.-]{0,127})(?:@([A-Za-z0-9][\w.-]{0,127}))?$/

/** Options of `plugin install` and `plugin update` that take a value, and those that do not. */
const INSTALL_VALUES = new Set(['--marketplace', '--scope', '-s', '--config', '--registry', '--accept-command'])
const INSTALL_FLAGS = new Set(['--json', '-y', '--yes'])
const MARKETPLACE_VALUES = new Set(['--scope'])
const MARKETPLACE_FLAGS = new Set(['--json'])

/** The arguments of `/plugin` as the person typed them. */
export function readPluginArgs(args: string): Reading {
  const words = splitShell(args).commands.flatMap(item => item.words)
  const sub = words[0]?.toLowerCase()
  if (sub === undefined) return BROWSE
  if (sub === 'install' || sub === 'i') return readInstall(words.slice(1), 'install', '/plugin install')
  if (sub === 'update') return readInstall(words.slice(1), 'update', '/plugin update')
  if (sub === 'marketplace' && words[1]?.toLowerCase() === 'add') return readMarketplaceAdd(words.slice(2), '/plugin marketplace add')
  return PASS
}

/**
 * A shell command Claude is about to run. It is held when any part of it
 * installs a plugin or adds a marketplace through the `claude` command, also
 * inside `sh -c` or `eval`; a command built at run time that may do so is
 * held as one the guard cannot read.
 */
export function readShellCommand(command: string): Reading {
  // This runs before every shell command Claude runs: it must never fail one
  // that installs nothing, and never wave one through that might.
  try {
    return readShell(command)
  } catch {
    return MAY_INSTALL.test(command) ? { kind: 'unreadable', label: 'a claude plugin command', reason: 'the guard could not read the command' } : PASS
  }
}

function readShell(command: string): Reading {
  const found: Reading[] = []
  const unseen = collectInstalls(command, found, 0)
  const installs = found.filter(reading => reading.kind !== 'pass')
  if (installs.length > 1) return { kind: 'unreadable', label: 'several installs', reason: 'the command installs more than one thing; run each install as a command of its own' }
  const [only] = installs
  if (only !== undefined) return only
  if (unseen && MAY_INSTALL.test(command)) {
    return { kind: 'unreadable', label: 'a claude plugin command', reason: 'part of the command is only known as it runs, so the guard cannot tell what it installs; run claude plugin install <name>@<marketplace> as a plain command' }
  }
  return PASS
}

/** `claude plugin install` and its kin, however the words are quoted or spaced. */
const MAY_INSTALL = /\bclaude(?:\.exe)?\b[\s"'\\)}`]+plugins?\b[\s"'\\]+(?:install|i|update|marketplace)\b/i

/** Programs that run their `-c` argument as a script. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])

/** How deep `sh -c "sh -c '…'"` is followed before the guard gives up reading it. */
const MAX_DEPTH = 4

/**
 * Adds every install `command` asks for to `found`. True when part of it is
 * only known as it runs, or it feeds a shell a script the guard cannot see.
 */
function collectInstalls(command: string, found: Reading[], depth: number): boolean {
  const { commands, dynamic } = splitShell(command)
  let unseen = dynamic
  const nested = (script: string): void => {
    unseen = depth >= MAX_DEPTH || collectInstalls(script, found, depth + 1) || unseen
  }
  for (const { words, input } of commands) {
    for (let index = 0; index < words.length; index += 1) {
      const program = programName(words[index])
      // `sh -c '…'`, `env bash -lc '…'`, `eval …`: the script is read as a command too.
      if (SHELLS.has(program)) {
        const flag = words.findIndex((word, at) => at > index && /^-[A-Za-z]*c[A-Za-z]*$/.test(word))
        const script = flag === -1 ? undefined : words[flag + 1]
        if (script !== undefined) nested(script)
        else if (input !== undefined) nested(input)
        // A shell given no script reads one from its input, often a pipe.
        else if (!words.slice(index + 1).some(word => !word.startsWith('-'))) unseen = true
        break
      }
      if (program === 'eval') {
        nested(words.slice(index + 1).join(' '))
        break
      }
      // `claude` anywhere in the command, so `env X=1 claude …`, `sudo claude …`
      // and `/usr/local/bin/claude …` count as well.
      if (!['claude', 'claude.exe'].includes(program) || !/^plugins?$/i.test(words[index + 1] ?? '')) continue
      const rest = words.slice(index + 2)
      const sub = rest[0]?.toLowerCase()
      if (sub === 'install' || sub === 'i') found.push(readInstall(rest.slice(1), 'install', 'claude plugin install'))
      else if (sub === 'update') found.push(readInstall(rest.slice(1), 'update', 'claude plugin update'))
      else if (sub === 'marketplace' && rest[1]?.toLowerCase() === 'add') found.push(readMarketplaceAdd(rest.slice(2), 'claude plugin marketplace add'))
      break
    }
  }
  return unseen
}

/** The last part of a program's path, lower-cased: `/usr/bin/Claude` is `claude`. */
function programName(word: string | undefined): string {
  return (word ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? ''
}

/** `install <plugin>` or `update <plugin>` with the options Claude Code takes. */
function readInstall(words: readonly string[], verb: 'install' | 'update', command: string): Reading {
  const options = readOptions(words, INSTALL_VALUES, INSTALL_FLAGS)
  const named = options.positionals[0]
  const label = `${command}${named === undefined ? '' : ` ${safeLine(named)}`}`
  if (options.unknown !== undefined) return { kind: 'unreadable', label, reason: `the guard does not know the option ${safeLine(options.unknown)}` }
  // With no plugin named, Claude Code shows its menu to pick one from.
  if (named === undefined) return verb === 'install' ? BROWSE : PASS
  if (options.positionals.length > 1) return { kind: 'unreadable', label, reason: 'it names more than one plugin; install one at a time' }
  if (options.values.has('--marketplace')) {
    return {
      kind: 'unreadable',
      label,
      reason: `it installs from a marketplace that is not added yet. Add it first with /plugin marketplace add ${safeLine(options.values.get('--marketplace') ?? '<source>')}, which the guard scans, then install ${safeLine(named)}@<marketplace>`,
    }
  }
  const id = PLUGIN_ID.exec(named)
  if (id === null) return { kind: 'unreadable', label, reason: `"${safeLine(named)}" is not a plugin name the guard can look up` }
  const plugin = id[1] as string
  const marketplace = id[2]
  if (options.values.has('--registry') || marketplace?.toLowerCase() === 'npm') return { kind: 'unreadable', label, reason: 'it installs a package from npm, which the guard cannot read yet' }
  return { kind: 'install', request: { kind: 'plugin', verb, plugin, ...(marketplace === undefined ? {} : { marketplace }) }, label }
}

/** `marketplace add <source>` with the options Claude Code takes. */
function readMarketplaceAdd(words: readonly string[], command: string): Reading {
  // --sparse takes every word after it, so the source must come before it.
  const sparse = words.findIndex(word => word === '--sparse')
  const options = readOptions(sparse === -1 ? words : words.slice(0, sparse), MARKETPLACE_VALUES, new Set([...MARKETPLACE_FLAGS, '--claudeai']))
  const source = options.positionals[0]
  const label = `${command}${source === undefined ? '' : ` ${safeLine(source)}`}`
  if (options.unknown !== undefined) return { kind: 'unreadable', label, reason: `the guard does not know the option ${safeLine(options.unknown)}` }
  if (options.flags.has('--claudeai')) return { kind: 'unreadable', label, reason: 'it adds a marketplace claude.ai hosts, which the guard cannot fetch' }
  if (source === undefined) return { kind: 'unreadable', label, reason: 'it names no source before --sparse' }
  if (options.positionals.length > 1) return { kind: 'unreadable', label, reason: 'it names more than one source' }
  return { kind: 'install', request: { kind: 'marketplace', source }, label }
}

type Options = { positionals: string[]; values: Map<string, string>; flags: Set<string>; unknown?: string }

/** Splits words into options and the rest; `--name=value` counts as `--name value`. */
function readOptions(words: readonly string[], valued: ReadonlySet<string>, flagged: ReadonlySet<string>): Options {
  const out: Options = { positionals: [], values: new Map(), flags: new Set() }
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string
    if (word === '--') {
      out.positionals.push(...words.slice(index + 1))
      break
    }
    if (!word.startsWith('-') || word === '-') {
      out.positionals.push(word)
      continue
    }
    const equals = word.indexOf('=')
    const name = equals === -1 ? word : word.slice(0, equals)
    if (flagged.has(name) && equals === -1) {
      out.flags.add(name)
    } else if (valued.has(name)) {
      const value = equals === -1 ? words[(index += 1)] : word.slice(equals + 1)
      if (value === undefined) {
        out.unknown ??= `${name} with no value`
        break
      }
      out.values.set(name === '-s' ? '--scope' : name, value)
    } else {
      out.unknown ??= name
    }
  }
  return out
}

/** One simple command: its words, and the text a here-document or here-string feeds it. */
export type ShellCommand = { words: string[]; input?: string }

/**
 * Splits shell text into simple commands of words, as a POSIX shell would
 * quote them: `;`, `&&`, `||`, `|`, `&`, parentheses and new lines end a
 * command; quotes and backslashes are resolved; redirections and their
 * targets are dropped; a `#` comment is skipped; a here-document's body or a
 * here-string becomes the command's `input`, not commands of its own.
 * `dynamic` is set when part of the text is only known once it runs: `$`
 * expansions, backquotes, process substitutions and unclosed quotes.
 */
export function splitShell(text: string): { commands: ShellCommand[]; dynamic: boolean } {
  const commands: ShellCommand[] = []
  let current: ShellCommand = { words: [] }
  let word = ''
  let inWord = false
  let dynamic = false
  /** What the next word is: a word, a redirection's target, a here-document's end marker, or a here-string. */
  let next: 'word' | 'target' | 'marker' | 'herestring' = 'word'
  let stripTabs = false
  const heredocs: { marker: string; stripTabs: boolean; command: ShellCommand }[] = []
  const endWord = (): void => {
    if (!inWord) return
    if (next === 'marker') heredocs.push({ marker: word, stripTabs, command: current })
    else if (next === 'herestring') current.input = word
    else if (next === 'word') current.words.push(word)
    next = 'word'
    word = ''
    inWord = false
  }
  const endCommand = (): void => {
    endWord()
    next = 'word'
    if (current.words.length > 0 || current.input !== undefined) commands.push(current)
    current = { words: [] }
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string
    if (char === "'") {
      const end = text.indexOf("'", index + 1)
      if (end === -1) dynamic = true
      word += text.slice(index + 1, end === -1 ? text.length : end)
      index = end === -1 ? text.length : end
      inWord = true
      continue
    }
    if (char === '"') {
      inWord = true
      index += 1
      while (index < text.length && text[index] !== '"') {
        const inner = text[index] as string
        if (inner === '\\' && index + 1 < text.length && '"\\$`\n'.includes(text[index + 1] as string)) {
          if (text[index + 1] !== '\n') word += text[index + 1]
          index += 2
          continue
        }
        if (inner === '$' || inner === '`') dynamic = true
        word += inner
        index += 1
      }
      if (index >= text.length) dynamic = true
      continue
    }
    if (char === '\\') {
      if (index + 1 < text.length && text[index + 1] !== '\n') {
        word += text[index + 1]
        inWord = true
      }
      index += 1
      continue
    }
    if (char === '$' || char === '`') {
      dynamic = true
      word += char
      inWord = true
      continue
    }
    if (char === '#' && !inWord) {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end - 1
      continue
    }
    if (char === '\n') {
      endWord()
      const pending = heredocs.splice(0)
      endCommand()
      // Each here-document's body follows, up to the line that ends it.
      for (const heredoc of pending) {
        const lines: string[] = []
        let end = text.length
        let start = index + 1
        while (start < text.length) {
          const stop = text.indexOf('\n', start)
          const line = text.slice(start, stop === -1 ? text.length : stop)
          if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.marker) {
            end = stop === -1 ? text.length : stop
            break
          }
          lines.push(heredoc.stripTabs ? line.replace(/^\t+/, '') : line)
          start = stop === -1 ? text.length : stop + 1
          end = start
        }
        heredoc.command.input = lines.join('\n')
        index = end
      }
      continue
    }
    if (/\s/.test(char)) {
      endWord()
      continue
    }
    if (char === '<' || char === '>') {
      // A file descriptor right before it (2>) is part of the redirection.
      if (inWord && /^\d+$/.test(word)) {
        word = ''
        inWord = false
      }
      endWord()
      if (text[index + 1] === '(') {
        dynamic = true
        next = 'target'
        continue
      }
      if (char === '<' && text.startsWith('<<<', index)) {
        index += 2
        next = 'herestring'
        continue
      }
      if (char === '<' && text[index + 1] === '<') {
        index += 1
        stripTabs = text[index + 1] === '-'
        if (stripTabs) index += 1
        next = 'marker'
        continue
      }
      while (text[index + 1] === '>' || text[index + 1] === '&' || text[index + 1] === '|') index += 1
      next = 'target'
      continue
    }
    if (char === ';' || char === '&' || char === '|' || char === '(' || char === ')') {
      endCommand()
      continue
    }
    word += char
    inWord = true
  }
  endCommand()
  return { commands, dynamic }
}

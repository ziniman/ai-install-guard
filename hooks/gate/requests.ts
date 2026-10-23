// What an install asks for, read from the text alone: the arguments of a
// `/plugin` command the person typed, or a shell command Claude is about to
// run. Nothing here runs anything or touches the disk.

import { safeLine } from '../scan/safe-text'

/** One thing to add to Claude Code: a plugin from a marketplace, or a marketplace. */
export type InstallRequest =
  /** `marketplaceSource` is the marketplace `--marketplace` adds first: a repository or a folder. */
  | { kind: 'plugin'; verb: 'install' | 'update'; plugin: string; marketplace?: string; marketplaceSource?: string }
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
 * A shell command Claude is about to run. It is held when it installs a
 * plugin or adds a marketplace through the `claude` command, also behind
 * `env`, `sudo` and the like, inside `sh -c`, `eval` or a here-document. An
 * install is approved as that exact command, so it must be readable whole: a
 * command that also runs something else, or that is only known as it runs,
 * is held as one the guard cannot read, never let through.
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
  const { unseen, opaque, others } = collectInstalls(command, found, 0, true)
  const installs = found.filter(reading => reading.kind !== 'pass')
  if (installs.length > 1) return { kind: 'unreadable', label: 'several installs', reason: 'the command installs more than one thing; run each install as a command of its own' }
  const [only] = installs
  if (only !== undefined) {
    if (only.kind !== 'install') return only
    // Approving the install approves the whole command, so nothing else may ride along.
    if (unseen || opaque) return { kind: 'unreadable', label: only.label, reason: `part of the command is only known as it runs, so approving it could run more than the install; run ${only.label} as a command of its own` }
    if (others > 0) return { kind: 'unreadable', label: only.label, reason: `the command runs more than the install; run ${only.label} as a command of its own, so approving it approves only the install` }
    // The guard cannot see the shell's current folder, so a source named
    // relative to it could be another folder than the one the guard scans.
    const source = only.request.kind === 'marketplace' ? only.request.source : only.request.marketplaceSource
    if (source !== undefined && !/^(?:https:\/\/|\/|~\/)/i.test(source)) {
      return {
        kind: 'unreadable',
        label: only.label,
        reason: `"${safeLine(source)}" could be a folder in the shell's current folder or a repository; name it as a full path or as https://github.com/<owner>/<repo>, so the guard scans what is added`,
      }
    }
    return only
  }
  // A shell or eval told to run text only known as it runs could run anything, an install included.
  if (opaque) {
    return { kind: 'unreadable', label: 'a command built as it runs', reason: 'it runs a command only known as it runs (as in bash -c "$CMD" or eval "$X"), so the guard cannot tell whether it installs anything; run the command itself instead' }
  }
  if (unseen && (MAY_INSTALL.test(command) || (CLAUDE_WORD.test(command) && /\bplugins?\b/i.test(command)))) {
    return { kind: 'unreadable', label: 'a claude plugin command', reason: 'part of the command is only known as it runs, so the guard cannot tell what it installs; run claude plugin install <name>@<marketplace> as a plain command' }
  }
  return PASS
}

/**
 * The words of a plugin install however they are joined: by spaces, quotes or
 * the commas of a list in another language (`['plugin', 'install']`).
 */
const MAY_INSTALL = /\bplugins?\b[^\w\n]{1,8}(?:install|i|update|marketplace)\b/i

/** The `claude` command's names as words of their own, not part of a path such as `~/.claude/`. */
const CLAUDE_WORD = /(?<![\w./-])claude(?:-code|\.exe)?(?![\w./-])/i

/** Names the `claude` command goes by. */
const CLAUDE = new Set(['claude', 'claude.exe', 'claude-code'])

/** Programs that run their `-c` argument as a script. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])

/**
 * Programs that run code in another language: given inline, from their
 * input or from a file, it is code the guard does not read.
 */
const INTERPRETERS = new Set(['python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'osascript', 'pwsh', 'powershell', 'lua', 'tclsh', 'rscript', 'julia', 'swift', 'groovy', 'jshell'])

/**
 * Programs that only print, read or wait: an install's words among their
 * arguments are text, and running one beside an install adds nothing to it.
 */
const QUIET = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'cat', 'head', 'tail', 'less', 'more', 'jq', 'sort', 'uniq', 'wc', 'tr', 'cut', 'ls', 'pwd', 'true', 'false', 'sleep', 'test', '[', 'date', 'which', 'type', 'column', 'nl', 'fold'])

/** A quiet program that writes a file all the same: `sort -o`, `uniq in out`. */
function writesAnyway(program: string, args: readonly string[]): boolean {
  if (program === 'sort') return args.some(arg => /^--output/.test(arg) || /^-[A-Za-z]*o/.test(arg))
  if (program === 'uniq') return args.filter(arg => !arg.startsWith('-')).length > 1
  return false
}

/**
 * Programs that run the command that follows their own options: the options
 * that take a value, how many plain words come before the command, whether
 * `NAME=value` words may come first, and whether the command's words come in
 * part from input (xargs).
 */
type Wrapper = { values?: readonly string[]; positionals?: number; assignments?: boolean; fromInput?: boolean; script?: readonly string[] }
const WRAPPERS: Record<string, Wrapper> = {
  env: { values: ['-u', '--unset', '-C', '--chdir'], assignments: true, script: ['-S', '--split-string'] },
  sudo: { values: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-U', '--other-user'], assignments: true },
  doas: { values: ['-u', '-C'] },
  command: {},
  exec: { values: ['-a'] },
  nohup: {},
  time: {},
  nice: { values: ['-n', '--adjustment'] },
  timeout: { values: ['-s', '--signal', '-k', '--kill-after'], positionals: 1 },
  stdbuf: { values: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  caffeinate: { values: ['-t', '-w'] },
  ionice: { values: ['-c', '-n', '-p', '--class', '--classdata', '--pid'] },
  setsid: {},
  chronic: {},
  unbuffer: {},
  // Multi-call programs: the next word names the program they act as.
  busybox: {},
  toybox: {},
  xargs: { values: ['-I', '-i', '-n', '-P', '-L', '-l', '-s', '-d', '-E', '-e', '-a', '--max-args', '--max-procs', '--max-lines', '--max-chars', '--delimiter', '--eof', '--arg-file', '--replace'], fromInput: true },
}

/** Programs whose text arguments are messages and names, never commands: a commit message or a pull request may quote an install. */
const TEXT_ARGUMENTS = new Set(['git', 'gh'])

/**
 * Configuration keys whose value git runs as a command (a `!` alias, a pager,
 * an editor, a helper or driver), or that point it at hooks to run.
 */
const GIT_RUNS = /^(?:alias\.[^=]+|core\.(?:pager|editor|sshcommand|fsmonitor|hookspath|askpass)|sequence\.editor|diff\.external|gpg\.(?:[^.]+\.)?program|credential\.(?:[^=]+\.)?helper|(?:diff|filter|merge|difftool|mergetool|pager|uploadpack|receivepack|remote\.[^.]+)\.[^=]+)=/i

/** Git's options that take a value before its subcommand. */
const GIT_VALUES = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

/**
 * The shell text git itself runs, from its arguments: a configuration value
 * it runs (`-c alias.x='!…'`, `-c core.pager=…`), `rebase --exec`,
 * `bisect run` and `submodule foreach`. Everything else git takes, messages
 * and names included, is text. `hooks` is set when a configuration points it
 * at hooks the guard cannot read.
 */
function gitScripts(args: readonly string[]): { scripts: string[]; hooks: boolean } {
  const scripts: string[] = []
  let hooks = false
  let index = 0
  // Global options, before the subcommand.
  for (; index < args.length; index += 1) {
    const arg = args[index] as string
    if (!arg.startsWith('-')) break
    const config = arg === '-c' ? args[index + 1] : arg.startsWith('-c') ? arg.slice(2) : undefined
    if (config !== undefined && GIT_RUNS.test(config)) {
      if (/^core\.hookspath=/i.test(config)) hooks = true
      else scripts.push(config.slice(config.indexOf('=') + 1).replace(/^!/, ''))
    }
    if (GIT_VALUES.has(arg)) index += 1
  }
  const sub = args[index]
  const rest = args.slice(index + 1)
  if (sub === 'rebase') {
    rest.forEach((arg, at) => {
      if (arg === '-x' || arg === '--exec') scripts.push(rest[at + 1] ?? '')
      else if (arg.startsWith('--exec=')) scripts.push(arg.slice('--exec='.length))
    })
  }
  if (sub === 'bisect' && rest[0] === 'run') scripts.push(rest.slice(1).join(' '))
  if (sub === 'submodule') {
    const at = rest.indexOf('foreach')
    if (at !== -1) scripts.push(rest.slice(at + 1).filter(arg => arg !== '--recursive' && arg !== '-q' && arg !== '--quiet').join(' '))
  }
  return { scripts, hooks }
}

/** How deep `sh -c "sh -c '…'"` is followed before the guard gives up reading it. */
const MAX_DEPTH = 4

type Collected = {
  /** Part of what runs is only known as it runs, or comes from input or a file the guard does not read. */
  unseen: boolean
  /** A shell or eval is told to run a command whose program is only known as it runs. */
  opaque: boolean
  /** Simple commands that run something other than an install, a quiet program or a shell the guard read into. */
  others: number
}

/**
 * A word whose text is only known as the command runs: an expansion, a
 * substitution, a pathname pattern (`claud[e]`, `cl*`) or a brace list
 * (`cl{aude,}`). `[` on its own is the test command.
 */
function isDynamic(word: string): boolean {
  return word !== '[' && (/[$`*?[]/.test(word) || /\{[^}]*,[^}]*\}/.test(word))
}

/**
 * Where the program of a simple command is: after `NAME=value` words and
 * any wrappers with their options. `scripts` are strings a wrapper runs as
 * shell text (`env -S`); `fromInput` is set when its words come in part
 * from input (`xargs`).
 */
function programAt(words: readonly string[]): { index: number; scripts: string[]; fromInput: boolean } {
  const scripts: string[] = []
  let fromInput = false
  let index = 0
  while (index < words.length && /^[A-Za-z_]\w*=/.test(words[index] as string)) index += 1
  for (let guard = 0; guard < 8 && index < words.length; guard += 1) {
    const wrapper = WRAPPERS[programName(words[index])]
    if (wrapper === undefined) break
    fromInput ||= wrapper.fromInput === true
    index += 1
    let plain = wrapper.positionals ?? 0
    while (index < words.length) {
      const word = words[index] as string
      if (word === '--') {
        index += 1
        break
      }
      if (wrapper.assignments === true && /^[A-Za-z_]\w*=/.test(word)) {
        index += 1
        continue
      }
      if (word.startsWith('-') && word !== '-') {
        const name = word.includes('=') ? word.slice(0, word.indexOf('=')) : word
        const takesValue = !word.includes('=') && ((wrapper.values ?? []).includes(name) || (wrapper.script ?? []).includes(name))
        if ((wrapper.script ?? []).includes(name)) scripts.push(word.includes('=') ? word.slice(word.indexOf('=') + 1) : (words[index + 1] ?? ''))
        index += takesValue ? 2 : 1
        continue
      }
      if (plain > 0) {
        plain -= 1
        index += 1
        continue
      }
      break
    }
  }
  return { index, scripts, fromInput }
}

/** Whether `claude plugin …` starts at `index`. */
function isClaudePlugin(words: readonly string[], index: number): boolean {
  return CLAUDE.has(programName(words[index])) && /^plugins?$/i.test(words[index + 1] ?? '')
}

/** The install a `claude plugin` command at `index` asks for, if it is one. */
function claudePlugin(words: readonly string[], index: number): Reading | undefined {
  const rest = words.slice(index + 2)
  const sub = rest[0]?.toLowerCase()
  if (sub === 'install' || sub === 'i') return readInstall(rest.slice(1), 'install', 'claude plugin install')
  if (sub === 'update') return readInstall(rest.slice(1), 'update', 'claude plugin update')
  if (sub === 'marketplace' && rest[1]?.toLowerCase() === 'add') return readMarketplaceAdd(rest.slice(2), 'claude plugin marketplace add')
  return undefined
}

/**
 * Adds every install `command` asks for to `found`, and says whether part of
 * what runs is unseen or opaque and how many other commands run beside it.
 * `asScript` is set for text a shell runs as commands; an argument of another
 * program, read only for installs it may run, cannot be opaque.
 */
function collectInstalls(command: string, found: Reading[], depth: number, asScript: boolean): Collected {
  const out: Collected = { unseen: false, opaque: false, others: 0 }
  if (depth > MAX_DEPTH) return { unseen: true, opaque: asScript, others: 0 }
  const merge = (inner: Collected, counts: boolean): void => {
    out.unseen ||= inner.unseen
    out.opaque ||= inner.opaque
    if (counts) out.others += inner.others
  }
  const nested = (script: string): void => merge(collectInstalls(script, found, depth + 1, true), true)
  for (const { words, input, scripts: substitutions, writes } of splitShell(command).commands) {
    // What its substitutions run comes first, and is read as commands too.
    substitutions?.forEach(nested)
    // A write to a file is more than an install, whatever program makes it.
    if (writes === true) out.others += 1
    const { index, scripts, fromInput } = programAt(words)
    scripts.forEach(nested)
    const word = words[index]
    // Only NAME=value words: nothing runs.
    if (word === undefined) continue
    const program = programName(word)
    // xargs fills in words from its input, which the guard does not see; for a quiet program that is only text.
    if (fromInput && !(QUIET.has(program) && !writesAnyway(program, words.slice(index + 1)))) out.unseen = true
    if (CLAUDE.has(program)) {
      // `claude` asked to do something only known as it runs could be installing.
      const at = words.findIndex((item, place) => place > index && /^plugins?$/i.test(item))
      const next = (offset: number): string => words[at + offset] ?? ''
      if (isDynamic(words[index + 1] ?? '') || (at !== -1 && (isDynamic(next(1)) || (/^marketplace$/i.test(next(1)) && isDynamic(next(2)))))) {
        found.push({ kind: 'unreadable', label: 'a claude command', reason: 'what it asks claude to do is only known as it runs; run claude plugin install <name>@<marketplace> as a plain command' })
        continue
      }
      // `claude plugin …`, also after global options (`claude --debug plugin install …`).
      const reading = at === -1 ? undefined : claudePlugin(words, at - 1)
      if (reading !== undefined) found.push(reading)
      else out.others += 1
      continue
    }
    // A program only known as it runs; inside a script a shell runs, nothing can be told about it.
    if (isDynamic(word)) {
      out.unseen = true
      if (asScript && depth > 0) out.opaque = true
      out.others += 1
      continue
    }
    if (SHELLS.has(program)) {
      // `sh -c '…'`, `bash -lc '…'`, `bash <<EOF`: the script is read as commands too.
      const flag = words.findIndex((item, at) => at > index && /^-[A-Za-z]*c[A-Za-z]*$/.test(item))
      const script = flag === -1 ? undefined : words[flag + 1]
      if (script !== undefined) nested(script)
      else if (input !== undefined) nested(input)
      // A shell given no script reads one from its input, often a pipe; one given a file runs that file.
      else {
        out.unseen = true
        out.others += 1
      }
      continue
    }
    if (program === 'eval') {
      nested(words.slice(index + 1).join(' '))
      continue
    }
    // Code in another language, inline, from input or from a file, is not read.
    if (INTERPRETERS.has(program.replace(/\.exe$/, '').replace(/^(python[23]?)\.\d+$/, '$1'))) out.unseen = true
    if (QUIET.has(program) && !writesAnyway(program, words.slice(index + 1))) continue
    // Any other program may run an install among its arguments (`watch`,
    // `flock`), and may run it again and again: the program around it counts
    // as more than the install, so it is held.
    const inside = words.findIndex((item, at) => at > index && isClaudePlugin(words, at))
    const reading = inside === -1 ? undefined : claudePlugin(words, inside)
    if (reading !== undefined) {
      found.push(reading)
      out.others += 1
      continue
    }
    // Or run an argument as a script (`su -c '…'`, `watch '…'`, git's own
    // `-c alias.x='!…'`): an install there is found, and the program around
    // it counts as more than it.
    if (program === 'git') {
      const ran = gitScripts(words.slice(index + 1))
      if (ran.hooks) out.unseen = true
      for (const script of ran.scripts) merge(collectInstalls(script, found, depth + 1, true), false)
    } else if (!TEXT_ARGUMENTS.has(program)) {
      for (const text of words.slice(index + 1).filter(argument => /\s/.test(argument))) merge(collectInstalls(text, found, depth + 1, false), false)
    }
    out.others += 1
  }
  return out
}

/** The last part of a program's path, lower-cased: `/usr/bin/Claude` is `claude`. */
function programName(word: string | undefined): string {
  return (word ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? ''
}

/** `install <plugin>` or `update <plugin>` with the options Claude Code takes. */
function readInstall(words: readonly string[], verb: 'install' | 'update', command: string): Reading {
  const options = readOptions(words, INSTALL_VALUES, INSTALL_FLAGS)
  const named = options.positionals[0]
  const marketplaceSource = options.values.get('--marketplace')
  const label = `${command}${named === undefined ? '' : ` ${safeLine(named)}`}${marketplaceSource === undefined ? '' : ` --marketplace ${safeLine(marketplaceSource)}`}`
  if (options.unknown !== undefined) return { kind: 'unreadable', label, reason: `the guard does not know the option ${safeLine(options.unknown)}` }
  // With no plugin named, Claude Code shows its menu to pick one from.
  if (named === undefined) return verb === 'install' ? BROWSE : PASS
  if (options.positionals.length > 1) return { kind: 'unreadable', label, reason: 'it names more than one plugin; install one at a time' }
  const id = PLUGIN_ID.exec(named)
  if (id === null) return { kind: 'unreadable', label, reason: `"${safeLine(named)}" is not a plugin name the guard can look up` }
  const plugin = id[1] as string
  const marketplace = id[2]
  if (options.values.has('--registry') || marketplace?.toLowerCase() === 'npm') return { kind: 'unreadable', label, reason: 'it installs a package from npm, which the guard cannot read yet' }
  if (marketplaceSource !== undefined) {
    // The plugin is looked up in the marketplace --marketplace adds, by its name alone.
    if (marketplace !== undefined) return { kind: 'unreadable', label, reason: `with --marketplace, name the plugin alone (${safeLine(plugin)}), not as ${safeLine(named)}` }
    return { kind: 'install', request: { kind: 'plugin', verb, plugin, marketplaceSource }, label }
  }
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

/**
 * One simple command: its words; the text a here-document or here-string
 * feeds it; the bodies of its command substitutions, which run before it
 * does; and whether it writes to a file through a redirection.
 */
export type ShellCommand = { words: string[]; input?: string; scripts?: string[]; writes?: boolean }

/**
 * Splits shell text into simple commands of words, as a POSIX shell would
 * quote them: `;`, `&&`, `||`, `|`, `&`, parentheses and new lines end a
 * command; quotes and backslashes are resolved; a `#` comment is skipped.
 * Redirections and their targets are not words; a redirection that writes to
 * a file other than /dev/null marks its command `writes`. A here-document's
 * body or a here-string becomes the command's `input`, and the body of each
 * `$(…)`, backquoted or `<(…)` substitution one of its `scripts`, never
 * commands of its own. `dynamic` is set when part of the text is only known
 * once it runs: `$` expansions, substitutions and unclosed quotes.
 */
export function splitShell(text: string): { commands: ShellCommand[]; dynamic: boolean } {
  const commands: ShellCommand[] = []
  let current: ShellCommand = { words: [] }
  let word = ''
  let inWord = false
  /** Part of the word was quoted or escaped: a here-document marker so written keeps its body as it is. */
  let quoted = false
  let dynamic = false
  /** What the next word is: a word, a redirection's target, a here-document's end marker, or a here-string. */
  let next: 'word' | 'target' | 'marker' | 'herestring' = 'word'
  /** For a redirection's target: whether the redirection writes, and whether it duplicates a descriptor (`>&2`). */
  let writing = false
  let duplicating = false
  let stripTabs = false
  const heredocs: { marker: string; stripTabs: boolean; quoted: boolean; command: ShellCommand }[] = []
  const endWord = (): void => {
    if (!inWord) return
    if (next === 'marker') heredocs.push({ marker: word, stripTabs, quoted, command: current })
    else if (next === 'herestring') current.input = word
    else if (next === 'word') current.words.push(word)
    else if (writing && word !== '/dev/null' && !(duplicating && /^(?:\d+|-)$/.test(word))) current.writes = true
    next = 'word'
    word = ''
    inWord = false
    quoted = false
  }
  const endCommand = (): void => {
    endWord()
    next = 'word'
    if (current.words.length > 0 || current.input !== undefined || current.scripts !== undefined || current.writes === true) commands.push(current)
    current = { words: [] }
  }
  /** Reads the substitution that opens at `open` (its `(` or backquote); returns where it closes. */
  const substitution = (open: number): number => {
    const isBackquote = text[open] === '`'
    const close = isBackquote ? closingBackquote(text, open) : closingParen(text, open)
    const end = close === -1 ? text.length : close
    // `$((…))` is arithmetic, not a command, but a substitution inside it still runs.
    const body = text.slice(open + 1, end)
    if (text[open] === '(' && text[open + 1] === '(') {
      const inner = substitutionsIn(body)
      if (inner.length > 0) (current.scripts ??= []).push(...inner)
    } else (current.scripts ??= []).push(body)
    dynamic = true
    word += text.slice(open - (isBackquote ? 0 : 1), Math.min(end + 1, text.length))
    inWord = true
    return end
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string
    if (char === "'") {
      const end = text.indexOf("'", index + 1)
      if (end === -1) dynamic = true
      word += text.slice(index + 1, end === -1 ? text.length : end)
      index = end === -1 ? text.length : end
      inWord = true
      quoted = true
      continue
    }
    if (char === '"') {
      inWord = true
      quoted = true
      index += 1
      while (index < text.length && text[index] !== '"') {
        const inner = text[index] as string
        if (inner === '\\' && index + 1 < text.length && '"\\$`\n'.includes(text[index + 1] as string)) {
          if (text[index + 1] !== '\n') word += text[index + 1]
          index += 2
          continue
        }
        if (inner === '$' && text[index + 1] === '(') {
          index = substitution(index + 1) + 1
          continue
        }
        if (inner === '`') {
          index = substitution(index) + 1
          continue
        }
        if (inner === '$') dynamic = true
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
        quoted = true
      }
      index += 1
      continue
    }
    if (char === '$' && text[index + 1] === '(') {
      index = substitution(index + 1)
      continue
    }
    if (char === '`') {
      index = substitution(index)
      continue
    }
    if (char === '$') {
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
        // An unquoted marker means the shell expands the body: its substitutions run.
        if (!heredoc.quoted) {
          const bodies = substitutionsIn(heredoc.command.input)
          if (bodies.length > 0) (heredoc.command.scripts ??= []).push(...bodies)
          if (/[$`]/.test(heredoc.command.input)) dynamic = true
        }
        index = end
      }
      continue
    }
    if (/\s/.test(char)) {
      endWord()
      continue
    }
    // `&>file` and `&>>file` redirect both outputs; any other `&` ends a command.
    const redirects = char === '<' || char === '>' || (char === '&' && text[index + 1] === '>')
    if (redirects) {
      // A file descriptor right before it (2>) is part of the redirection.
      if (inWord && /^\d+$/.test(word)) {
        word = ''
        inWord = false
      }
      endWord()
      if (char === '&') index += 1
      const operator = text[index] as string
      if (text[index + 1] === '(') {
        // `<(…)` and `>(…)`: a command whose output or input stands in for a file.
        const end = closingParen(text, index + 1)
        ;(current.scripts ??= []).push(text.slice(index + 2, end === -1 ? text.length : end))
        dynamic = true
        index = end === -1 ? text.length : end
        continue
      }
      if (operator === '<' && text.startsWith('<<<', index)) {
        index += 2
        next = 'herestring'
        continue
      }
      if (operator === '<' && text[index + 1] === '<') {
        index += 1
        stripTabs = text[index + 1] === '-'
        if (stripTabs) index += 1
        next = 'marker'
        continue
      }
      writing = operator === '>' || char === '&'
      duplicating = false
      while (text[index + 1] === '>' || text[index + 1] === '&' || text[index + 1] === '|') {
        if (text[index + 1] === '&') duplicating = true
        index += 1
      }
      // `<>file` opens it for writing too.
      if (operator === '<' && text[index] === '>') writing = true
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

/** The bodies of the `$(…)` and backquoted substitutions in text a shell expands, such as an unquoted here-document. */
function substitutionsIn(text: string): string[] {
  const out: string[] = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1
    } else if (text[index] === '$' && text[index + 1] === '(') {
      const close = closingParen(text, index + 1)
      const body = text.slice(index + 2, close === -1 ? text.length : close)
      // Arithmetic is not a command, but a substitution inside it still runs.
      if (text[index + 2] === '(') out.push(...substitutionsIn(body))
      else out.push(body)
      index = close === -1 ? text.length : close
    } else if (text[index] === '`') {
      const close = closingBackquote(text, index)
      out.push(text.slice(index + 1, close === -1 ? text.length : close))
      index = close === -1 ? text.length : close
    }
  }
  return out
}

/** Where the `(` at `open` is closed, past quotes and nested parentheses; -1 if it never is. */
function closingParen(text: string, open: number): number {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index] as string
    if (char === '\\') {
      index += 1
    } else if (char === "'") {
      const end = text.indexOf("'", index + 1)
      if (end === -1) return -1
      index = end
    } else if (char === '"') {
      index += 1
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1
    } else if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Where the backquote at `open` is closed; -1 if it never is. */
function closingBackquote(text: string, open: number): number {
  for (let index = open + 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1
    else if (text[index] === '`') return index
  }
  return -1
}

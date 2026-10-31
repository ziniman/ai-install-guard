// What an install asks for, read from the text alone: the arguments of a
// `/plugin` command the person typed, or a shell command Claude is about to
// run. Nothing here runs anything or touches the disk.

import { safeLine } from '../scan/safe-text'

/** One thing to add to Claude Code: a plugin from a marketplace, a marketplace, or an MCP server. */
export type InstallRequest =
  /** `marketplaceSource` is the marketplace `--marketplace` adds first: a repository or a folder. */
  | { kind: 'plugin'; verb: 'install' | 'update'; plugin: string; marketplace?: string; marketplaceSource?: string }
  | { kind: 'marketplace'; source: string }
  /** `server` is its configuration as `.mcp.json` holds it: a command to start, or an address. */
  | { kind: 'mcp'; name: string; scope?: string; server: Record<string, unknown> }

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
    return mayInstall(command) ? { kind: 'unreadable', label: 'a claude plugin command', reason: 'the guard could not read the command' } : PASS
  }
}

function readShell(command: string): Reading {
  const found: Reading[] = []
  const { unseen, opaque, others, texts } = collectInstalls(command, found, 0, true)
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
    const source = only.request.kind === 'marketplace' ? only.request.source : only.request.kind === 'plugin' ? only.request.marketplaceSource : undefined
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
  // An unseen part may run an install whose words show elsewhere in the command (a variable it reads, code
  // in another language); a claude command read whole and found to install nothing is no such sign.
  const rest = texts.join('\n')
  if (unseen && (mayInstall(rest) || (namesClaude(rest) && /\b(?:plugins?|mcp)\b/i.test(rest)))) {
    return { kind: 'unreadable', label: 'a claude command', reason: 'part of the command is only known as it runs, so the guard cannot tell what it installs; run claude plugin install or claude mcp add as a plain command' }
  }
  return PASS
}

/**
 * The words of a plugin install however they are joined: by spaces, quotes or
 * the commas of a list in another language (`['plugin', 'install']`). A path
 * separator never joins them, so `.claude-plugin/marketplace.json` is a path.
 */
const MAY_INSTALL = /\bplugins?\b[^\w\n/\\]{1,8}(?:install|update|marketplace)\b|\bmcp\b[^\w\n/\\]{1,8}add(?:-json|-from-claude-desktop)?\b/i
/**
 * `plugin i`, install's short name, as the command takes it, or as a string
 * of its own in code, which may change its case as it runs (`"I".lower()`):
 * `the plugins I use` is English.
 */
const MAY_INSTALL_SHORT = /\bplugins?\b[^\w\n/\\]{1,8}i\b|\bplugins?\b[^\w\n/\\]{1,8}(["'`])I\1/

function mayInstall(text: string): boolean {
  return MAY_INSTALL.test(text) || MAY_INSTALL_SHORT.test(text)
}

/**
 * The `claude` command's names as words of their own, or at the end of a
 * path (`/usr/local/bin/claude`, `./claude`) but not inside one
 * (`~/.claude/`), spelled as the command is: `Claude Code` in a sentence
 * names the product, and `/claude` alone in one is no path, not a command.
 */
const CLAUDE_WORD = /(?:(?<![\w./-])|(?<=[\w.~-]\/))claude(?:-code)?(?:\.(?:exe|cmd|bat|ps1))?(?![\w./-])/
/** A name of the command as a string of its own in code, in any case, which code may change as it runs (`"Claude".lower()`). */
const CLAUDE_STRING = /(["'`])claude(?:-code)?(?:\.(?:exe|cmd|bat|ps1))?\1/i

function namesClaude(text: string): boolean {
  return CLAUDE_WORD.test(text) || CLAUDE_STRING.test(text)
}

/** Names the `claude` command goes by, Windows' launchers included. */
export const CLAUDE = new Set(['claude', 'claude-code'].flatMap(name => [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`, `${name}.ps1`]))

/** Programs that run their `-c` argument as a script. */
export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])

/**
 * Programs that run code in another language: given inline, from their
 * input or from a file, it is code the guard does not read.
 */
export const INTERPRETERS = new Set(['python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'osascript', 'pwsh', 'powershell', 'lua', 'tclsh', 'rscript', 'julia', 'swift', 'groovy', 'jshell'])

/**
 * Programs that only print, read or wait: an install's words among their
 * arguments are text, and running one beside an install adds nothing to it.
 * `command` is one only as `command -v` or `-V`, which says what a name would
 * run; `programAt` goes past any other `command` to the program it runs.
 */
export const QUIET = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'cat', 'head', 'tail', 'less', 'more', 'jq', 'sort', 'uniq', 'wc', 'tr', 'cut', 'ls', 'pwd', 'true', 'false', 'sleep', 'test', '[', 'date', 'which', 'type', 'command', 'column', 'nl', 'fold'])

/** A quiet program that writes a file all the same: `sort -o`, `uniq in out`. */
function writesAnyway(program: string, args: readonly string[]): boolean {
  if (program === 'sort') return args.some(arg => /^--output/.test(arg) || /^-[A-Za-z]*o/.test(arg))
  if (program === 'uniq') return args.filter(arg => !arg.startsWith('-')).length > 1
  return false
}

/**
 * Programs that run the command that follows their own options: the options
 * that take a value, how many plain words come before the command, whether
 * `NAME=value` words may come first, whether the command's words come in
 * part from input (xargs), and an option with which they run nothing at all
 * (`lookup`).
 */
type Wrapper = { values?: readonly string[]; positionals?: number; assignments?: boolean; fromInput?: boolean; script?: readonly string[]; lookup?: RegExp }
const WRAPPERS: Record<string, Wrapper> = {
  env: { values: ['-u', '--unset', '-C', '--chdir'], assignments: true, script: ['-S', '--split-string'] },
  sudo: { values: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-U', '--other-user'], assignments: true },
  doas: { values: ['-u', '-C'] },
  // `command -v`, `-V` and `-pv` only say what a name would run.
  command: { lookup: /^-[pvV]*[vV][pvV]*$/ },
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
export function gitScripts(args: readonly string[]): { scripts: string[]; hooks: boolean } {
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
  /**
   * The text of each simple command, with its input, but for a `claude`
   * command read whole and found to install nothing: where an install's words
   * would show when part of the command is unseen.
   */
  texts: string[]
}

/**
 * A word whose text is only known as the command runs: an expansion, a
 * substitution, a pathname pattern (`claud[e]`, `cl*`) or a brace list
 * (`cl{aude,}`). `[` on its own is the test command.
 */
export function isDynamic(word: string): boolean {
  return word !== '[' && (/[$`*?[]/.test(word) || BRACES.test(word))
}

/** A brace list (`{a,b}`) or range (`{a..c}`, `{1..3}`), which the shell turns into several words. */
const BRACES = /\{[^}]*(?:,|\.\.)[^}]*\}/

/**
 * Where the program of a simple command is: after `NAME=value` words and
 * any wrappers with their options. A wrapper given an option with which it
 * runs nothing (`command -v`) is the program itself. `scripts` are strings a
 * wrapper runs as shell text (`env -S`); `fromInput` is set when its words
 * come in part from input (`xargs`).
 */
export function programAt(words: readonly string[]): { index: number; scripts: string[]; fromInput: boolean } {
  const scripts: string[] = []
  let fromInput = false
  let index = 0
  while (index < words.length && /^[A-Za-z_]\w*=/.test(words[index] as string)) index += 1
  for (let guard = 0; guard < 8 && index < words.length; guard += 1) {
    const wrapper = WRAPPERS[programName(words[index])]
    if (wrapper === undefined) break
    fromInput ||= wrapper.fromInput === true
    const own = index
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
        if (wrapper.lookup?.test(word) === true) return { index: own, scripts, fromInput }
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

/** Whether `claude plugin …` or `claude mcp …` starts at `index`. */
function isClaudePlugin(words: readonly string[], index: number): boolean {
  return CLAUDE.has(programName(words[index])) && /^(?:plugins?|mcp)$/i.test(words[index + 1] ?? '')
}

/**
 * The install a `claude plugin` or `claude mcp` command at `index` asks for,
 * if it is one. `expands` says which of `words` the shell expands as it runs.
 */
function claudePlugin(words: readonly string[], index: number, expands: ReadonlySet<number> = new Set(), splits: ReadonlySet<number> = new Set()): Reading | undefined {
  if (/^mcp$/i.test(words[index + 1] ?? '')) {
    const base = index + 2
    return claudeMcp(words.slice(base), { expands: at => expands.has(at + base), splits: at => splits.has(at + base) })
  }
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
  const out: Collected = { unseen: false, opaque: false, others: 0, texts: [] }
  if (depth > MAX_DEPTH) return { unseen: true, opaque: asScript, others: 0, texts: [command] }
  const merge = (inner: Collected, counts: boolean): void => {
    out.unseen ||= inner.unseen
    out.opaque ||= inner.opaque
    if (counts) out.others += inner.others
    out.texts.push(...inner.texts)
  }
  const nested = (script: string): void => merge(collectInstalls(script, found, depth + 1, true), true)
  for (const { words, input, scripts: substitutions, writes, expands, splits } of splitShell(command).commands) {
    // What its substitutions run comes first, and is read as commands too.
    substitutions?.forEach(nested)
    const own = out.texts.push([...words, input ?? ''].join(' ')) - 1
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
      // Every `plugin` or `mcp` word is a possible subcommand: one may be a global
      // option's value (`claude --settings mcp mcp add …`), so each is tried.
      const places = words.flatMap((item, place) => (place > index && /^(?:plugins?|mcp)$/i.test(item) ? [place] : []))
      const after = (at: number, offset: number): string => words[at + offset] ?? ''
      // `claude` asked to do something only known as it runs could be installing.
      if (isDynamic(words[index + 1] ?? '') || places.some(at => isDynamic(after(at, 1)) || (/^marketplace$/i.test(after(at, 1)) && isDynamic(after(at, 2))))) {
        found.push({ kind: 'unreadable', label: 'a claude command', reason: 'what it asks claude to do is only known as it runs; run claude plugin install or claude mcp add as a plain command' })
        continue
      }
      // `claude plugin …` or `claude mcp …`, also after global options (`claude --debug plugin install …`).
      const expanded = new Set(expands ?? [])
      const split = new Set(splits ?? [])
      const reading = places.map(at => claudePlugin(words, at - 1, expanded, split)).find(item => item !== undefined)
      if (reading !== undefined) found.push(reading)
      else {
        out.others += 1
        // Read whole and found to install nothing (`claude plugin test .`): its words are no sign of an install elsewhere.
        out.texts[own] = ''
      }
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
    const reading = inside === -1 ? undefined : claudePlugin(words, inside, new Set(expands ?? []), new Set(splits ?? []))
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
export function programName(word: string | undefined): string {
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

/** An MCP server's name as `claude mcp add` takes it. */
const MCP_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/

/** The MCP transports Claude Code knows: a command it starts, or an address it connects to. */
const MCP_TRANSPORTS = new Set(['stdio', 'http', 'sse'])

/**
 * An environment variable or header that holds a secret: the one kind of
 * value that may be filled in as the server starts (`-e TOKEN=$GITHUB_TOKEN`,
 * `Authorization: Bearer ${PAT}`). Any other value changes what the server
 * does (`NODE_OPTIONS`, `PATH`), so it must be written out to be checked.
 */
const SECRET_NAME = /token|key|secret|passw|pat$|auth|credential|cookie|session|bearer/i

/**
 * A value whose every `$` is a plain variable (`$NAME`, `${NAME}`) or a
 * substitution (`$(…)`): one word, as long as it is quoted.
 */
const PLAIN_FILL = /^(?:[^$]|\$[A-Za-z_]\w*|\$\{[A-Za-z_]\w*\}|\$\([^)]*\))*$/

/** Text Claude Code fills in when it starts the server: `${VAR}` or `${VAR:-default}`. */
const FILLED_IN = /\$\{[^}]*\}/

/**
 * `claude mcp …`: `add`, `add-json` and `add-from-claude-desktop` add
 * servers; `list`, `get`, `remove` and the rest add nothing. `expands(at)`
 * says whether the shell expands word `at` of `rest` as the command runs.
 */
type Expansion = { expands: (at: number) => boolean; splits: (at: number) => boolean }

function claudeMcp(rest: readonly string[], shell: Expansion): Reading | undefined {
  const sub = rest[0]?.toLowerCase()
  const after: Expansion = { expands: at => shell.expands(at + 1), splits: at => shell.splits(at + 1) }
  if (sub === 'add') return readMcpAdd(rest.slice(1), after)
  if (sub === 'add-json') return readMcpAddJson(rest.slice(1), after.expands)
  if (sub === 'add-from-claude-desktop') {
    return { kind: 'unreadable', label: 'claude mcp add-from-claude-desktop', reason: "it copies every MCP server in Claude Desktop's settings, which the guard does not read; add each one with claude mcp add, so each is scanned" }
  }
  return undefined
}

/**
 * `claude mcp add [options] <name> <command or address> [args…]`. The
 * server's own arguments follow `--`; an option among them without `--` could
 * be read either way, so it is held rather than guessed at. `-e`/`--env` and
 * `-H`/`--header` take every word up to the next option, as Claude Code reads them.
 */
function readMcpAdd(words: readonly string[], { expands, splits }: Expansion): Reading {
  const positionals: { text: string; expands: boolean }[] = []
  const env: Record<string, string> = {}
  const headers: Record<string, string> = {}
  /** Values the shell fills in, by the name they are given to: allowed only for a secret, and only quoted. */
  const filledValues: string[] = []
  const splitValues: string[] = []
  let scope: string | undefined
  let transport: string | undefined
  let problem: string | undefined
  const fixed = (at: number, what: string): void => {
    if (expands(at)) problem ??= `${what} is only known as the command runs, so the guard cannot check what is added; write it out in full`
  }
  for (let index = 0; index < words.length && problem === undefined; index += 1) {
    const word = words[index] as string
    if (word === '--') {
      for (let at = index + 1; at < words.length; at += 1) positionals.push({ text: words[at] as string, expands: expands(at) })
      break
    }
    if (!word.startsWith('-') || word === '-') {
      positionals.push({ text: word, expands: expands(index) })
      continue
    }
    // After a command the server starts, an option could be the server's or this
    // command's. A server at an address takes no arguments, so after its address
    // an option is this command's (`… github https://… -H "Authorization: …"`).
    const remote = (transport ?? (/^https?:\/\//i.test(positionals[1]?.text ?? '') ? 'http' : 'stdio')) !== 'stdio'
    if (positionals.length >= 2 && !remote) {
      problem = `it is unclear whether ${safeLine(word)} is for the server or for claude mcp add; put -- before the server's command and its arguments`
      break
    }
    const equals = word.indexOf('=')
    const name = equals === -1 ? word : word.slice(0, equals)
    const inline = equals === -1 ? undefined : word.slice(equals + 1)
    if (name === '-e' || name === '--env' || name === '-H' || name === '--header') {
      const values = inline === undefined ? [] : [{ text: inline, expands: expands(index), splits: splits(index) }]
      while (index + 1 < words.length && !(words[index + 1] as string).startsWith('-')) {
        index += 1
        values.push({ text: words[index] as string, expands: expands(index), splits: splits(index) })
      }
      if (values.length === 0) problem = `${name} is given no value`
      for (const value of values) {
        if (name === '-e' || name === '--env') {
          const pair = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(value.text)
          if (pair === null) problem ??= `"${safeLine(value.text)}" is not NAME=value`
          else {
            env[pair[1] as string] = pair[2] as string
            if (value.expands) filledValues.push(pair[1] as string)
            if (value.splits) splitValues.push(pair[1] as string)
          }
        } else {
          const colon = value.text.indexOf(':')
          if (colon <= 0) problem ??= `"${safeLine(value.text)}" is not a header (Name: value)`
          else {
            const header = value.text.slice(0, colon).trim()
            headers[header] = value.text.slice(colon + 1).trim()
            if (value.expands) filledValues.push(header)
            if (value.splits) splitValues.push(header)
          }
        }
      }
    } else if (name === '-s' || name === '--scope' || name === '-t' || name === '--transport') {
      const at = inline === undefined ? index + 1 : index
      const value = inline ?? words[(index += 1)]
      if (value === undefined) problem = `${name} is given no value`
      else {
        fixed(at, name === '-s' || name === '--scope' ? 'its scope' : 'its transport')
        if (name === '-s' || name === '--scope') scope = value
        else transport = value.toLowerCase()
      }
    } else {
      problem = `the guard does not know the option ${safeLine(name)}`
    }
  }
  const [name, target, ...args] = positionals
  const label = `claude mcp add${name === undefined ? '' : ` ${safeLine(name.text)}`}`
  if (problem !== undefined) return { kind: 'unreadable', label, reason: problem }
  if (name === undefined || target === undefined) return { kind: 'unreadable', label, reason: 'it names no server, or no command or address to add' }
  if (positionals.some(item => item.expands)) {
    return { kind: 'unreadable', label, reason: 'its name, command, arguments or address is only known as the command runs, so the guard cannot check what is added; write it out in full' }
  }
  const notSecret = filledValues.find(item => !SECRET_NAME.test(item))
  if (notSecret !== undefined) {
    return { kind: 'unreadable', label, reason: `the value of ${safeLine(notSecret)} is only known as the command runs, and only a secret's may be; write it out in full` }
  }
  // Only a plain variable or a substitution may fill one in: `$@`, `${list[@]}` and the like give several words.
  const fancy = Object.entries({ ...env, ...headers }).find(([key, value]) => filledValues.includes(key) && !PLAIN_FILL.test(value))
  if (fancy !== undefined) {
    return { kind: 'unreadable', label, reason: `the value of ${safeLine(fancy[0])} is filled in by more than a plain variable; give it as -e ${safeLine(fancy[0])}="$NAME"` }
  }
  // Unquoted, what the shell fills in may split into more words: more settings than the one scanned.
  const unquoted = splitValues[0]
  if (unquoted !== undefined) {
    return { kind: 'unreadable', label, reason: `the value of ${safeLine(unquoted)} is filled in unquoted, so the shell may split it into more words than the one setting scanned; quote it, as in -e ${safeLine(unquoted)}="$VALUE"` }
  }
  // An address given with no transport is checked as the remote server it names.
  const kind = transport ?? (/^https?:\/\//i.test(target.text) ? 'http' : 'stdio')
  if (!MCP_TRANSPORTS.has(kind)) return { kind: 'unreadable', label, reason: `the guard does not know the transport ${safeLine(kind)}` }
  if (kind === 'stdio' && Object.keys(headers).length > 0) return { kind: 'unreadable', label, reason: 'it gives headers to a server started as a command' }
  if (kind !== 'stdio' && args.length > 0) return { kind: 'unreadable', label, reason: 'it gives arguments to a server reached at an address' }
  const server =
    kind === 'stdio'
      ? { command: target.text, args: args.map(item => item.text), ...(Object.keys(env).length === 0 ? {} : { env }) }
      : { type: kind, url: target.text, ...(Object.keys(headers).length === 0 ? {} : { headers }), ...(Object.keys(env).length === 0 ? {} : { env }) }
  return mcpRequest(label, name.text, scope, server)
}

/** `claude mcp add-json [options] <name> '<json>'`: the server's configuration given whole. */
function readMcpAddJson(words: readonly string[], expands: (at: number) => boolean): Reading {
  const options = readOptions(words, new Set(['--scope', '-s']), new Set(['--client-secret']))
  const [name, json] = options.positionals
  const label = `claude mcp add-json${name === undefined ? '' : ` ${safeLine(name)}`}`
  if (options.unknown !== undefined) return { kind: 'unreadable', label, reason: `the guard does not know the option ${safeLine(options.unknown)}` }
  if (name === undefined || json === undefined || options.positionals.length > 2) return { kind: 'unreadable', label, reason: 'it needs a server name and its configuration as one JSON argument' }
  if (words.some((word, at) => word !== '--' && expands(at))) {
    return { kind: 'unreadable', label, reason: 'part of the server it adds is only known as the command runs, so the guard cannot check what is added; write it out in full' }
  }
  let server: unknown
  try {
    server = JSON.parse(json)
  } catch {
    return { kind: 'unreadable', label, reason: 'its configuration is not valid JSON' }
  }
  if (typeof server !== 'object' || server === null || Array.isArray(server)) return { kind: 'unreadable', label, reason: 'its configuration is not a JSON object' }
  return mcpRequest(label, name, options.values.get('--scope'), server as Record<string, unknown>)
}

/** The keys of a server's configuration the guard's checks read, and so the only ones it approves. */
const MCP_KEYS = new Set(['type', 'command', 'args', 'url', 'env', 'headers'])

/** The request for one server, once its configuration passes `mcpServerProblem`. */
function mcpRequest(label: string, name: string, scope: string | undefined, server: Record<string, unknown>): Reading {
  const problem = mcpServerProblem(name, server)
  if (problem !== undefined) return { kind: 'unreadable', label, reason: problem }
  return { kind: 'install', request: { kind: 'mcp', name, ...(scope === undefined ? {} : { scope }), server }, label }
}

/**
 * Why one server's configuration cannot be approved as written, or
 * undefined when it can: it must hold only what the checks read, in the
 * types they read, since anything else would be approved by the hash without
 * being checked; and text Claude Code fills in as it starts the server
 * (`${VAR}`) is allowed in a secret's value only. The same for a server
 * added by command and one written into a configuration file.
 */
export function mcpServerProblem(name: string, server: Record<string, unknown>): string | undefined {
  if (!MCP_NAME.test(name)) return `"${safeLine(name)}" is not a server name the guard can keep`
  const extra = Object.keys(server).find(key => !MCP_KEYS.has(key))
  if (extra !== undefined) return `its configuration has "${safeLine(extra)}", which the guard does not check`
  const text = (value: unknown): value is string => typeof value === 'string'
  const table = (value: unknown): value is Record<string, string> => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(text)
  if (server.type !== undefined && !(text(server.type) && MCP_TRANSPORTS.has(server.type))) return 'its type is not stdio, http or sse'
  if (server.command !== undefined && !text(server.command)) return 'its command is not text'
  if (server.args !== undefined && !(Array.isArray(server.args) && server.args.every(text))) return 'its arguments are not a list of text'
  if (server.url !== undefined && !text(server.url)) return 'its address is not text'
  if (server.env !== undefined && !table(server.env)) return 'its environment is not a table of text'
  if (server.headers !== undefined && !table(server.headers)) return 'its headers are not a table of text'
  if (!text(server.command) && !text(server.url)) return 'it names no command to start and no address'
  const fixedText = [server.command, server.url, ...((server.args as string[] | undefined) ?? [])].filter(text)
  if (fixedText.some(item => FILLED_IN.test(item))) return "its command, arguments or address hold ${…}, which Claude Code fills in as it starts the server; write them out in full"
  for (const [key, value] of [...Object.entries((server.env as Record<string, string> | undefined) ?? {}), ...Object.entries((server.headers as Record<string, string> | undefined) ?? {})]) {
    if (FILLED_IN.test(value) && !SECRET_NAME.test(key)) return `the value of ${safeLine(key)} holds \${…}, which Claude Code fills in as it starts the server, and only a secret's may; write it out in full`
  }
  return undefined
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
export type ShellCommand = {
  words: string[]
  input?: string
  scripts?: string[]
  writes?: boolean
  /** Which words the shell expands as the command runs: a variable, a substitution, a tilde, or an unquoted pattern or brace list. */
  expands?: number[]
  /** Which of those it may also split into several words: an unquoted variable or substitution. */
  splits?: number[]
  /** The files its redirections write: whether each appends, and whether the shell expands its name as it runs. */
  targets?: { path: string; append: boolean; expands: boolean }[]
  /** The exact text a here-document or here-string feeds it, each ending in a new line, when the shell expands none of it. */
  feeds?: string
  /** Its input comes from a here-document or here-string the shell expands as it runs, so the text is only known then. */
  feedsExpand?: boolean
}

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
  /** The shell expands part of this word as the command runs; `bare` is its unquoted text, for patterns. */
  let expands = false
  /** Part of what it expands is unquoted, so the result may be split into several words. */
  let splits = false
  let bare = ''
  let dynamic = false
  /** What the next word is: a word, a redirection's target, a here-document's end marker, or a here-string. */
  let next: 'word' | 'target' | 'marker' | 'herestring' = 'word'
  /** For a redirection's target: whether the redirection writes, appends, and whether it duplicates a descriptor (`>&2`). */
  let writing = false
  let appending = false
  let duplicating = false
  let stripTabs = false
  const heredocs: { marker: string; stripTabs: boolean; quoted: boolean; command: ShellCommand }[] = []
  const endWord = (): void => {
    if (!inWord) return
    if (next === 'marker') heredocs.push({ marker: word, stripTabs, quoted, command: current })
    else if (next === 'herestring') {
      current.input = word
      // A here-string is fed with a new line after it.
      if (expands) current.feedsExpand = true
      else current.feeds = `${word}\n`
    } else if (next === 'word') {
      // An unquoted pattern (`cl*`, `x?`, `[ab]`) or brace list (`{a,b}`) is expanded; `[` alone is the test command.
      // A pattern or a brace list or range also becomes several words.
      const multiplies = word !== '[' && (/[*?[]/.test(bare) || BRACES.test(bare))
      if (expands || multiplies) (current.expands ??= []).push(current.words.length)
      if (splits || multiplies) (current.splits ??= []).push(current.words.length)
      current.words.push(word)
    }
    else if (writing && word !== '/dev/null' && !(duplicating && /^(?:\d+|-)$/.test(word))) {
      current.writes = true
      const multiplies = /[*?[]/.test(bare) || BRACES.test(bare)
      ;(current.targets ??= []).push({ path: word, append: appending, expands: expands || multiplies })
    }
    next = 'word'
    word = ''
    inWord = false
    quoted = false
    expands = false
    splits = false
    bare = ''
  }
  const endCommand = (): void => {
    endWord()
    next = 'word'
    if (current.words.length > 0 || current.input !== undefined || current.scripts !== undefined || current.writes === true) commands.push(current)
    current = { words: [] }
  }
  /** Reads the substitution that opens at `open` (its `(` or backquote); returns where it closes. Outside double quotes its output may be split. */
  const substitution = (open: number, inQuotes = false): number => {
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
    expands = true
    if (!inQuotes) splits = true
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
          index = substitution(index + 1, true) + 1
          continue
        }
        if (inner === '`') {
          index = substitution(index, true) + 1
          continue
        }
        if (inner === '$') {
          dynamic = true
          expands = true
          // Even quoted, "$@" and "${list[@]}" give one word per item.
          const rest = text.slice(index + 1, index + 200)
          if (rest.startsWith('@') || /^\{[^}]*@/.test(rest)) splits = true
        }
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
      expands = true
      splits = true
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
        // Each line is fed with its new line; an unquoted body's `$`, backquotes and backslashes are the shell's to read.
        if (!heredoc.quoted && /[$`\\]/.test(heredoc.command.input)) heredoc.command.feedsExpand = true
        else heredoc.command.feeds = lines.map(line => `${line}\n`).join('')
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
      appending = operator === '>' && text[index + 1] === '>'
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
    // An unquoted `~` at the start of a word, or after `=` or `:` in it, is a home folder.
    if (char === '~' && (!inWord || word.endsWith('=') || word.endsWith(':'))) expands = true
    word += char
    bare += char
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

// What an install asks for, read from the text alone: the arguments of a
// `/plugin` command the person typed, or a shell command Claude is about to
// run. Nothing here runs anything or touches the disk.

import { spanKinds } from '../scan/checks/text'
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
  const { unseen, others, texts, shellRuns, backquoteRuns } = collectInstalls(command, found, 0, true)
  const installs = found.filter(reading => reading.kind !== 'pass')
  if (installs.length > 1) return { kind: 'unreadable', label: 'several installs', reason: 'the command installs more than one thing; run each install as a command of its own' }
  const [only] = installs
  if (only !== undefined) {
    if (only.kind !== 'install') return only
    // Approving the install approves the whole command, so nothing else may ride along.
    if (unseen) return { kind: 'unreadable', label: only.label, reason: `part of the command is only known as it runs, so approving it could run more than the install; run ${only.label} as a command of its own` }
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
  // Text only known as it runs (`$CMD arg`, `bash -c "$CMD"`, `eval "$X"`) holds nothing by itself: it could run
  // anything, which Claude Code's own permission checks are for, and the guard holds installs. It counts only
  // beside an install's words, which an unseen part may run (a variable it reads, code in another language),
  // or `claude plugin` or `claude mcp` with what it is asked to do left out. A claude command read whole and
  // found to install nothing is no such sign. Code, and data fed to a program other than a shell, counts only
  // when it may start a program, unless a shell runs text the guard did not read: a comment or a string in a
  // script that starts nothing installs nothing.
  const rest = texts
    .filter(item => !item.code || shellRuns || startsProgram(backquoteRuns && item.data === true ? { ...item, backquotes: true } : item))
    .map(item => item.text)
    .join('\n')
  if (unseen && (mayInstall(rest) || CLAUDE_SUBCOMMAND.test(rest))) {
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

/**
 * The `claude` command joined to `plugin` or `mcp`, by spaces, quotes or the
 * commas of a list over lines (`"claude",\n "plugin", sub`), and not followed
 * by a subcommand that installs nothing: what it is asked to do is left out,
 * or is an install.
 */
const CLAUDE_SUBCOMMAND = new RegExp(`${CLAUDE_WORD.source}[^\\w/\\\\]{1,16}(?:plugins?|mcp)(?![\\w.-])(?![^\\w/\\\\]{1,16}(?:list|validate|test|details|get|remove|uninstall|disable|enable|serve|help|h)\\b)`)

/** Names the `claude` command goes by, Windows' launchers included. */
export const CLAUDE = new Set(['claude', 'claude-code'].flatMap(name => [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`, `${name}.ps1`]))

/** Programs that run their `-c` argument as a script. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])

/**
 * Programs that run code in another language: given inline, from their
 * input or from a file, it is code the guard does not read.
 */
const INTERPRETERS = new Set(['python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'osascript', 'pwsh', 'powershell', 'lua', 'tclsh', 'rscript', 'julia', 'swift', 'groovy', 'jshell'])

/**
 * Interpreters of JavaScript, where a backquote opens a template. In Ruby,
 * Perl and PHP one runs a shell command.
 */
const JAVASCRIPT = new Set(['node', 'nodejs', 'deno', 'bun'])

/**
 * Languages in which a backquote runs nothing: Python, where one can only be
 * text in a string or a comment, awk, sed and jq. Their code's backquotes are
 * its own text, as a JavaScript template's are; one inside a double-quoted
 * string, which the code may hand to a shell, is still read as a script.
 */
const NO_BACKQUOTE = new Set(['python', 'python2', 'python3', 'awk', 'gawk', 'mawk', 'nawk', 'sed', 'gsed', 'jq', 'yq'])

/** Languages in which any backquote runs a shell command. */
const BACKQUOTE_RUNS = new Set(['perl', 'ruby', 'php', 'julia'])

/** Languages whose code runs a program by naming it, as a shell's does (PowerShell's `& name`, Tcl's `exec name`): their code is read as shell text. */
const NAMES_RUN = new Set(['pwsh', 'powershell', 'tclsh'])

/** JavaScript with its regular expression literals and comments blanked: a backquote in one, as in a pattern for a fenced code block, opens nothing. */
function withoutPatterns(code: string): string {
  const kind = spanKinds(code, 'js')
  let out = ''
  for (let at = 0; at < code.length; at += 1) {
    const span = kind(at)
    out += span === 'regex' || span === 'comment' || span === 'trailing-comment' ? (code[at] === '\n' ? '\n' : ' ') : code[at]
  }
  return out
}

/**
 * JavaScript that may start a process or run text as code: a template it
 * hands to one may run as a command (`` execSync(`${cmd}`) ``, `` Bun.$`…` ``,
 * `` eval(`${code}`) ``), so its backquotes are read as scripts.
 */
/**
 * What hands a template to something that only prints it: whatever else it is
 * handed to may run it, through a function of the code's own as well. Only the
 * global `console` and `process` count, never a property of something else
 * (`foo.console.log(`).
 */
const PRINTS_TEMPLATE = /(?<![\w$.])(?:console\.(?:log|error|warn|info|debug)|process\.std(?:out|err)\.write)\s*\(\s*$/

/** The calls `PRINTS_TEMPLATE` trusts, as code writes them. */
const PRINT_CALLS = /(?<![\w$.])(?:console\.(?:log|error|warn|info|debug)|process\.std(?:out|err)\.write)\s*\(/g

/**
 * Code that names what those calls use in any other way (`console["log"] =`,
 * `globalThis.console`, `Reflect.set(console, …)`): it may have changed what
 * they do, so none of them only prints.
 */
const REDEFINES_PRINT = /\b(?:console|globalThis|global|Reflect|Proxy)\b|\bprocess\s*(?:\.\s*std(?:out|err)\b|\[)/

/**
 * A text `collectInstalls` gathers: `backquotes` is set for code in a language
 * where a backquote runs a shell command, `language` for code the scanner's
 * tokenizer reads, Python or JavaScript, `names` for code that runs a program
 * by naming it (`NAMES_RUN`), `data` for what a program other than a shell
 * or an interpreter is fed, and `printed` for data a program that only
 * prints or reads is fed (`cat > file <<'EOF'`), which it never runs.
 */
type CollectedText = { text: string; code: boolean; backquotes?: boolean; language?: 'python' | 'js'; names?: boolean; data?: boolean; printed?: boolean }

/**
 * Whether code or data may start a program, so an install's words in it may
 * run. In Python or JavaScript only the code itself counts, not its strings
 * and comments: a script that edits a file which names `exec(` starts nothing.
 */
function startsProgram(item: CollectedText): boolean {
  // PowerShell and Tcl run a program by naming it: their code counts when it names the claude command outside
  // its strings, or runs one some other way (`& 'claude'`, `Invoke-Expression`, Tcl's `exec`).
  if (item.names === true) return NAMES_RUN_CALL.test(item.text) || namesClaude(outsideStrings(item.text))
  const text = item.language === undefined ? item.text : codeOnly(item.text, item.language)
  // In code, a process function named at all may be called under another name (`from os import system as go`)
  // or by its name in a string (`call_user_func("system", …)`, where no tokenizer reads the code); and
  // JavaScript names the module that starts processes in a string. Data fed to another program is not code.
  const named = item.data !== true && (PROCESS_NAMES.test(text) || (item.language === 'js' && PROCESS_MODULES.test(withoutPatterns(item.text))))
  // What a program only prints or writes runs a shell's `$(claude …)` only when a shell runs the file it made,
  // which counts every text: as code another program runs later, that is no call.
  const shellCall = item.printed !== true && SHELL_RUNS_CLAUDE.test(text)
  return named || shellCall || MAY_RUN_TEXT.test(text) || STARTS_PROGRAM.test(text) || (item.backquotes === true && outsideStrings(item.text).includes('`'))
}

/**
 * Perl-like, PowerShell or Tcl code without its strings: a single-quoted one
 * holds only text in each, and a double-quoted one too, unless it interpolates
 * code (Ruby's `#{…}`, Perl's `@{[…]}` or `${\…}`, `$(…)`), where a backquote
 * or a command still runs.
 */
function outsideStrings(code: string): string {
  return code.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, string => (string.startsWith('"') && /#\{|@\{\[|\$\{\\|\$\(/.test(string) ? string : ' '))
}

/** PowerShell's and Tcl's ways to run a program besides naming it: the call operator, Invoke-Expression and the like, Tcl's exec and eval. */
const NAMES_RUN_CALL = /(?:^|[\s;{(|])&\s*['"$\w]|\bInvoke-(?:Expression|Command|Item)\b|\biex\b|\bStart-Process\b|\.Invoke\s*\(|\[scriptblock\]|\b(?:exec|eval|uplevel|subst)\b|\bopen\s+["|]/i

/** The names of functions that start a process, which code may import or take under another name. */
const PROCESS_NAMES = /\b(?:system|popen|Popen|exec[lv]\w*|spawn\w*|posix_spawn\w*|fork|execSync|execFile\w*|check_output|check_call|getoutput|getstatusoutput|startfile)\b|create_subprocess/

/** A JavaScript module that starts processes or runs code, required or imported by name. */
const PROCESS_MODULES = /\b(?:require|import)\s*\(?\s*['"`](?:node:)?(?:child_process|worker_threads|vm|cluster)['"`]|\bfrom\s+['"](?:node:)?(?:child_process|worker_threads|vm|cluster)['"]/

/** Python or JavaScript with its strings and comments blanked. */
function codeOnly(code: string, language: 'python' | 'js'): string {
  const kind = spanKinds(code, language)
  let out = ''
  for (let at = 0; at < code.length; at += 1) out += kind(at) === 'code' || code[at] === '\n' ? code[at] : ' '
  return out
}

/** The tokenizer's name for an interpreter's language, when it reads it. */
function tokenized(language: string): 'python' | 'js' | undefined {
  return /^python[23]?$/.test(language) ? 'python' : JAVASCRIPT.has(language) ? 'js' : undefined
}

/**
 * Code beside JavaScript's (`MAY_RUN_TEXT`) that may start a program: Python's
 * subprocess and os calls, a `system`, `exec`, `popen` or `eval` call in any
 * language, Ruby's, Perl's and PHP's ways, PowerShell's and AppleScript's,
 * Node's other ways to load a module (`_load`, `createRequire`, `mainModule`),
 * Lua's, Swift's and Groovy's,
 * and the ways code reaches a call by a name it builds as it runs (Python's
 * `getattr` and the like, a JavaScript `require` of a name that is no
 * literal, a call through a computed property `x[…](…)`, PHP's
 * `call_user_func` and variable functions `$f(…)`, Ruby's `send` and
 * `method`, Perl's `&{…}` and `&$f`).
 */
const STARTS_PROGRAM = /\(\s*\$\w+\s*\)\s*\(|\$\{[^}]*\}\s*\(|\bcall_user_func\w*|\bforward_static_call\w*|\bReflectionFunction\b|\bcreate_function\b|\bassert\s*\(|\b(?:public_)?send\s*\(|__send__|\bmethod\s*\(|\b(?:instance|class|module)_(?:eval|exec)\b|\$\w+\s*\(|&\s*[{$]|\b_load\b|\bcreateRequire\b|\bmainModule\b|\bmodule\.constructor\b|\bos\.execute\b|\bio\.popen\b|\bProcess\s*\(|\.execute\s*\(|\b(?:getattr|setattr|globals|vars)\s*\(|__dict__|__builtins__|\bctypes\b|\bpickle\b|\bmarshal\b|\brequire\s*\(\s*[^'"`\s)]|\][\s)]*\(|\bsubprocess\b|\bos\.(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*)|\bpty\.spawn|\b(?:system|exec\w*|spawn\w*|popen|Popen|fork|check_output|check_call|getoutput|getstatusoutput|eval|compile|__import__)\s*\(|\b(?:system|exec)\s+['"]|\bimportlib\b|\bOpen3\b|\bIO\.popen\b|\bProcessBuilder\b|\bgetRuntime\b|\bshell_exec\b|\bpassthru\b|\bproc_open\b|%x[({[<|!]|\bqx\b|\bopen\s*\(?[^)\n]*\|\s*['"]|do shell script|\bStart-Process\b|\bInvoke-Expression\b|\biex\b/

/** A backquote or `$(…)` around the claude command, which a shell or Perl runs. */
const SHELL_RUNS_CLAUDE = /`[^`\n]*\bclaude(?:-code)?\b[^`\n]*`|\$\([^)\n]*\bclaude(?:-code)?\b/

const MAY_RUN_TEXT = /child_process|\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\b|\b(?:Bun|Deno)\b|binding|getBuiltinModule|\$\s*`|\b(?:eval|Function|vm|Worker)\b|_compile|runIn\w*Context|compileFunction|\bimport\s*\(|\brequire\s*\(\s*`/

/**
 * Programs that only print, read or wait: an install's words among their
 * arguments are text, and running one beside an install adds nothing to it.
 * `command` is one only as `command -v` or `-V`, which says what a name would
 * run; `programAt` goes past any other `command` to the program it runs.
 */
const QUIET = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'cat', 'head', 'tail', 'less', 'more', 'jq', 'sort', 'uniq', 'wc', 'tr', 'cut', 'ls', 'pwd', 'true', 'false', 'sleep', 'test', '[', 'date', 'which', 'type', 'command', 'column', 'nl', 'fold'])

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
  /** Simple commands that run something other than an install, a quiet program or a shell the guard read into. */
  others: number
  /**
   * The text of each simple command and of its input, but for a `claude`
   * command read whole and found to install nothing: where an install's words
   * would show when part of the command is unseen. `code` marks text a shell
   * does not run as commands: an interpreter's code, or what a program other
   * than a shell is fed, which counts only when it may start a program.
   */
  texts: CollectedText[]
  /** A shell runs text the guard does not read (a file, or its input), which may be any data the command holds. */
  shellRuns: boolean
  /** Perl, Ruby or PHP runs, so a backquote in any data the command holds may be one of theirs, which runs a shell command. */
  backquoteRuns: boolean
}

/**
 * A word whose text is only known as the command runs: an expansion, a
 * substitution, a pathname pattern (`claud[e]`, `cl*`) or a brace list
 * (`cl{aude,}`). `[` on its own is the test command.
 */
function isDynamic(word: string): boolean {
  return word !== '[' && (/[$`*?[]/.test(word) || BRACES.test(word))
}

/** A brace list (`{a,b}`) or range (`{a..c}`, `{1..3}`), which the shell turns into several words. */
const BRACES = /\{[^}]*(?:,|\.\.)[^}]*\}/

/** The names of the functions shell text defines (`name() {`, `function name`). */
function definedFunctions(text: string): Set<string> {
  return new Set([...text.matchAll(/(?:^|[\s;&|(){}])(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)|\bfunction\s+([A-Za-z_][\w-]*)/g)].map(found => found[1] ?? found[2] ?? ''))
}

/**
 * `text` with each substitution the shell runs as it reads the command
 * (`scripts`, already read as commands) in its place as a word only known as
 * it runs, so reading the text again does not read them twice.
 */
function asOutput(text: string, scripts: readonly string[] | undefined): string {
  let out = text
  for (const script of scripts ?? []) out = out.split(`$(${script})`).join('$_').split(`\`${script}\``).join('$_')
  return out
}

/** The files a command writes by redirection, and those it names by a path, each by its file name. */
type ShellFiles = { written: Set<string>; named: Set<string> }

/** A word or a part of one that is a path: it holds a `/`. */
const PATH_TOKEN = /[\w.~$-]*\/[\w./~-]+/g

/** The last part of a path, its file's own name. */
function fileName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

/** `NAME=value`, or `NAME+=value`, at the start of a word. */
const ASSIGNMENT = /^([A-Za-z_]\w*)(\+?)=/
/** Words that may come before a command within a compound one. */
const COMPOUND_PREFIX = new Set(['then', 'do', 'else', 'elif', '!', 'time', 'if', 'while', 'until', '{'])
/** Words that open a compound command, and those that close one. */
const COMPOUND_OPENS = new Set(['if', 'while', 'until', 'for', 'select', 'case', '{'])
const COMPOUND_CLOSES = new Set(['fi', 'done', 'esac', '}'])

/**
 * Where the program of a simple command is: after `NAME=value` words and
 * any wrappers with their options. A wrapper given an option with which it
 * runs nothing (`command -v`) is the program itself. `scripts` are strings a
 * wrapper runs as shell text (`env -S`); `fromInput` is set when its words
 * come in part from input (`xargs`).
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
  // Asked for its help (before `--`), the command shows it and does nothing else.
  const options = rest.indexOf('--') === -1 ? rest : rest.slice(0, rest.indexOf('--'))
  if (options.includes('--help') || options.includes('-h')) return PASS
  if (sub === 'install' || sub === 'i') return readInstall(rest.slice(1), 'install', 'claude plugin install')
  if (sub === 'update') return readInstall(rest.slice(1), 'update', 'claude plugin update')
  if (sub === 'marketplace' && rest[1]?.toLowerCase() === 'add') return readMarketplaceAdd(rest.slice(2), 'claude plugin marketplace add')
  return undefined
}

/**
 * Adds every install `command` asks for to `found`, and says whether part of
 * what runs is unseen and how many other commands run beside it. `asScript`
 * is set for text a shell runs as commands, not an argument of another
 * program, read only for installs it may run. `inCode` is
 * set for JavaScript that starts no process and runs no text as code, where
 * a backquote outside a string opens a template, the code's own text, so what
 * it holds, like every word read from the code, is read as code too. One
 * inside a string is still read as a script, and so is a shell or eval named
 * in the code. `runners` is set for JavaScript that may run text: a template
 * there is a script unless it is only printed (`` console.log(`…`) ``), since
 * anything else may hand it to what runs it. `files` holds, across every
 * script the command holds, the files its redirections write and the files
 * it names by a path, by file name: one run as a program later is a script
 * the guard did not read.
 */
function collectInstalls(command: string, found: Reading[], depth: number, asScript: boolean, inCode = false, runners = false, files: ShellFiles = { written: new Set(), named: new Set() }): Collected {
  const out: Collected = { unseen: false, others: 0, texts: [], shellRuns: false, backquoteRuns: false }
  if (depth > MAX_DEPTH) return { unseen: true, others: 0, texts: [{ text: command, code: false }], shellRuns: asScript, backquoteRuns: false }
  const merge = (inner: Collected, counts: boolean): void => {
    out.unseen ||= inner.unseen
    out.shellRuns ||= inner.shellRuns
    out.backquoteRuns ||= inner.backquoteRuns
    if (counts) out.others += inner.others
    out.texts.push(...inner.texts)
  }
  const nested = (script: string): void => merge(collectInstalls(script, found, depth + 1, true, false, false, files), true)
  const functions = definedFunctions(command)
  for (const { words, input, scripts: substitutions, quotedScripts, scriptLeads, writes, targets, expands, splits } of splitShell(command).commands) {
    const { index, scripts, fromInput } = programAt(words)
    // What a substitution prints for git or gh (`--body "$(cat <<'EOF' … EOF)"`) is a message it keeps, never run.
    const keepsText = TEXT_ARGUMENTS.has(programName(words[index])) && !isDynamic(words[index] ?? '')
    // What its substitutions run comes first, and is read as commands too, but
    // for a JavaScript template, which is the code's own text.
    substitutions?.forEach((script, at) => {
      const template = (inCode || (runners && PRINTS_TEMPLATE.test(scriptLeads?.[at] ?? ''))) && quotedScripts?.includes(at) !== true
      const inner = collectInstalls(script, found, depth + 1, !template, template, false, files)
      merge(keepsText ? { ...inner, texts: inner.texts.filter(item => item.printed !== true) } : inner, true)
    })
    const word = words[index]
    const program = programName(word)
    const language = program.replace(/\.exe$/, '').replace(/^(python[23]?)\.\d+$/, '$1')
    // An interpreter's words hold its code, and what a program other than a shell is fed is data or code.
    const read = tokenized(language)
    const kind = { ...(BACKQUOTE_RUNS.has(language) ? { backquotes: true } : {}), ...(read === undefined ? {} : { language: read }), ...(NAMES_RUN.has(language) ? { names: true } : {}) }
    // Git's words are text but for what it runs (`gitScripts`, read below), and gh's but for an alias or extension it may define.
    const message = keepsText && !(program === 'gh' && words.some(item => /^(?:alias|extension|ext)$/.test(item)))
    const own = out.texts.push({ text: (message ? words.slice(0, index + 1) : words).join(' '), code: INTERPRETERS.has(language), ...kind }) - 1
    // What git or gh is fed is text it keeps (a commit message, a pull request's body), and what a program only
    // prints it never runs: its shell's words count only when a shell runs the file it made.
    if (input !== undefined && !TEXT_ARGUMENTS.has(program)) out.texts.push({ text: input, code: !SHELLS.has(program), ...(INTERPRETERS.has(language) ? kind : SHELLS.has(program) ? {} : { data: true, ...(QUIET.has(program) ? { printed: true } : {}) }) })
    // A write to a file is more than an install, whatever program makes it.
    if (writes === true) out.others += 1
    // A script the command wrote, or named before by a path (`tee /tmp/x`, a path in code) and runs by one now, is shell
    // text the guard did not read. By file name: the same file may be named another way (`dir//s`, `./dir/s`, after a `cd`).
    // Only in text a shell runs: an argument read in case it is a script holds paths that are no programs.
    const ranScript = asScript && word !== undefined && (files.written.has(fileName(word)) || (word.includes('/') && files.named.has(fileName(word))))
    for (const target of targets ?? []) files.written.add(fileName(target.path))
    for (const item of [...words, input ?? '']) for (const named of item.match(PATH_TOKEN) ?? []) files.named.add(fileName(named))
    scripts.forEach(nested)
    // Only NAME=value words: nothing runs.
    if (word === undefined) continue
    // So is one `source` or `.` runs.
    if (ranScript || program === 'source' || program === '.') {
      out.unseen = true
      out.shellRuns = true
    }
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
        out.texts[own] = { text: '', code: false }
      }
      continue
    }
    // A program only known as it runs.
    if (isDynamic(word)) {
      out.unseen = true
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
        out.shellRuns = true
        out.others += 1
      }
      continue
    }
    if (program === 'eval') {
      nested(words.slice(index + 1).join(' '))
      continue
    }
    // Code in another language, inline, from input or from a file, is not read.
    if (INTERPRETERS.has(language)) out.unseen = true
    if (BACKQUOTE_RUNS.has(language)) out.backquoteRuns = true
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
      for (const script of ran.scripts) merge(collectInstalls(script, found, depth + 1, true, false, false, files), false)
    } else if (!TEXT_ARGUMENTS.has(program)) {
      for (const text of words.slice(index + 1).filter(argument => /\s/.test(argument))) {
        // The shell ran its own substitutions before the program starts, read above: here they are only what they print.
        const given = asOutput(text, substitutions)
        const code = JAVASCRIPT.has(language) ? withoutPatterns(given) : given
        // An interpreter's code that can start no program runs no install it names.
        if (INTERPRETERS.has(language) && !startsProgram({ text, code: true, ...kind })) continue
        const runs = JAVASCRIPT.has(language) && MAY_RUN_TEXT.test(code)
        // Code that redefines what only prints has every template read as a script.
        const prints = runs && !REDEFINES_PRINT.test(code.replace(PRINT_CALLS, ' '))
        // A function the command defines runs its body, read with the rest, so a backquote in its arguments is what the body makes of it.
        const inner = collectInstalls(code, found, depth + 1, false, inCode || functions.has(program) || NO_BACKQUOTE.has(language) || (JAVASCRIPT.has(language) && !runs), prints && !inCode, files)
        // An interpreter's code is in its own words, read whole for whether it may start a program.
        merge(INTERPRETERS.has(language) ? { ...inner, texts: [] } : inner, false)
      }
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
  // Asked for its help before the server's name, the command shows it; after it, the word may be the server's own.
  const named = rest.findIndex((word, at) => at > 0 && !word.startsWith('-'))
  if (rest.slice(1, named === -1 ? undefined : named).some(word => word === '--help' || word === '-h')) return PASS
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
type ShellCommand = {
  words: string[]
  input?: string
  scripts?: string[]
  /** Which of `scripts` were found inside double quotes. */
  quotedScripts?: number[]
  /** For each of `scripts`, the text just before it opens, which tells what code hands it to. */
  scriptLeads?: string[]
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
  /** Variables the text sets earlier to a value written out, which `$NAME` and `${NAME}` then read as that value (see `settle`). */
  const known = new Map<string, string>()
  /** The functions the text defines: calling one may set any variable. */
  const functions = definedFunctions(text)
  /** Part of this word is only known as it runs: an expansion `known` does not hold, or a substitution. */
  let unresolved = false
  /** For each word of the command at hand, whether it is only known as it runs. */
  let wordsUnresolved: boolean[] = []
  /** What ended the command before this one; how deep the text is in compound commands and in parentheses. */
  let before = ';'
  let depth = 0
  let parens = 0
  /**
   * The value of the variable named at `at` (its `$`) and how many characters
   * name it, when the text set it earlier to a value written out. Unquoted, a
   * value the shell would split or match as a pattern, or an empty one, is
   * only known as it runs.
   */
  const resolve = (at: number, inQuotes: boolean): { value: string; length: number } | undefined => {
    const found = /^(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})/.exec(text.slice(at + 1, at + 130))
    const name = found?.[1] ?? found?.[2]
    // An assignment earlier in this same command sets it first (`A=x B="$A"`), or not at all for its words (`A=x cmd "$A"`).
    let assignedHere = false
    let lead = 0
    while (lead < current.words.length && COMPOUND_PREFIX.has(current.words[lead] as string)) lead += 1
    for (let found = ASSIGNMENT.exec(current.words[lead] ?? ''); found !== null; found = ASSIGNMENT.exec(current.words[lead] ?? '')) {
      if (found[1] === name) assignedHere = true
      lead += 1
    }
    const value = name === undefined || assignedHere ? undefined : known.get(name)
    if (found === null || value === undefined || (!inQuotes && (value === '' || /[\s*?[\]{}]/.test(value)))) return undefined
    return { value, length: found[0].length }
  }
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
      wordsUnresolved.push(unresolved)
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
    unresolved = false
    bare = ''
  }
  /**
   * What the command at hand does to the variables `known` holds, given what
   * ended it and the one before. `NAME=value` alone, at the top level, after
   * `;` or a new line and before one or `&&`, sets it to a value written out;
   * an assignment anywhere else (inside `if`, `for`, `{ }` or parentheses,
   * after `&&` or `||`, in a pipeline or in the background), or to a value
   * only known as it runs, leaves it unknown, as does any command that may
   * set it (`read`, `for NAME in`, `unset`, `local`, `let`, `printf -v`).
   * `eval`, `source` and a function the text defines may set any.
   */
  const settle = (ending: string): void => {
    const words = current.words
    let at = 0
    while (at < words.length && COMPOUND_PREFIX.has(words[at] as string)) at += 1
    let program = at
    const assigns: { name: string; value: string; fixed: boolean }[] = []
    for (let found = ASSIGNMENT.exec(words[program] ?? ''); found !== null; found = ASSIGNMENT.exec(words[program] ?? '')) {
      assigns.push({ name: found[1] as string, value: (words[program] as string).slice(found[0].length), fixed: found[2] === '' && wordsUnresolved[program] !== true })
      program += 1
    }
    const top = depth + parens === 0 && at === 0 && (before === ';' || before === '\n') && (ending === ';' || ending === '\n' || ending === 'end' || ending === '&&')
    const set = (name: string, value: string, fixed: boolean): void => {
      if (fixed && top && !/[$`]/.test(value)) known.set(name, value)
      else known.delete(name)
    }
    // `command` and `builtin` run the builtin after them in this same shell.
    while (words[program] === 'command' || words[program] === 'builtin') {
      program += 1
      while (words[program]?.startsWith('-') === true) program += 1
    }
    const name = words[program]
    const args = words.slice(program + 1)
    if (name === undefined) for (const item of assigns) set(item.name, item.value, item.fixed)
    else if (name === 'eval' || name === 'source' || name === '.' || functions.has(name)) known.clear()
    else if (name === 'printf' || name === 'for' || name === 'select') {
      // `printf` sets a variable only with `-v NAME` (or `-vNAME`); `for` and `select` only their loop variable.
      const flag = name === 'printf' ? args.findIndex(arg => arg.startsWith('-v')) : -1
      const at = name !== 'printf' ? 0 : flag !== -1 && args[flag] === '-v' ? flag + 1 : flag
      const variable = at === -1 ? undefined : at === flag ? args[at]?.slice(2) : args[at]
      if (at !== -1 && wordsUnresolved[program + 1 + at] === true) known.clear()
      else if (variable !== undefined) known.delete(variable)
    } else if (name === 'export' || name === 'readonly' || name === 'declare' || name === 'typeset' || name === 'local' || name === 'unset' || name === 'read' || name === 'mapfile' || name === 'readarray' || name === 'getopts' || name === 'let') {
      // Given a name only known as it runs (`read "$X"`), it may change any variable.
      if (args.some((_, index) => wordsUnresolved[program + 1 + index] === true)) known.clear()
      args.forEach((arg, index) => {
        const found = ASSIGNMENT.exec(arg)
        if (found !== null) set(found[1] as string, arg.slice(found[0].length), name === 'export' && found[2] === '' && wordsUnresolved[program + 1 + index] !== true)
        else if (/^[A-Za-z_]\w*$/.test(arg) && !((name === 'export' || name === 'readonly') && known.has(arg))) known.delete(arg)
      })
    }
    for (const word of words.slice(0, program + 1)) if (COMPOUND_OPENS.has(word)) depth += 1
    if (COMPOUND_CLOSES.has(words[0] as string)) depth = Math.max(0, depth - 1)
  }
  const endCommand = (ending = 'end'): void => {
    endWord()
    next = 'word'
    settle(ending)
    before = ending
    wordsUnresolved = []
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
    const first = current.scripts?.length ?? 0
    if (text[open] === '(' && text[open + 1] === '(') {
      const inner = substitutionsIn(body)
      if (inner.length > 0) (current.scripts ??= []).push(...inner)
    } else (current.scripts ??= []).push(body)
    const start = open - (isBackquote ? 0 : 1)
    for (let at = first; at < (current.scripts?.length ?? 0); at += 1) {
      ;(current.scriptLeads ??= [])[at] = text.slice(Math.max(0, start - 40), start)
      if (inQuotes) (current.quotedScripts ??= []).push(at)
    }
    dynamic = true
    expands = true
    unresolved = true
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
          const value = resolve(index, true)
          if (value !== undefined) {
            word += value.value
            index += 1 + value.length
            continue
          }
          dynamic = true
          expands = true
          unresolved = true
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
      const value = resolve(index, false)
      if (value !== undefined) {
        word += value.value
        bare += value.value
        index += value.length
        inWord = true
        continue
      }
      dynamic = true
      expands = true
      splits = true
      unresolved = true
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
      endCommand('\n')
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
      const doubled = (char === '&' || char === '|') && text[index + 1] === char
      if (doubled) index += 1
      endCommand(doubled ? `${char}${char}` : char)
      if (char === '(') parens += 1
      else if (char === ')' && parens > 0) parens -= 1
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

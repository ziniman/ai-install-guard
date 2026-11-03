// What a shell command Claude is about to run writes, read from its text
// alone: the files its redirections write, and those cp, mv, install, ln,
// rsync, ditto, git, curl, wget, unzip, tar, tee, sed -i, perl -i, ruby -i
// and dd make. A program the guard does not know is judged by the paths it is
// given; what it writes on its own, unnamed, is not seen. Nothing here runs
// anything or touches the disk.

import { proseTest } from '../scan/checks/code'
import { spanKinds, type SpanKind } from '../scan/checks/text'
import { CLAUDE, INTERPRETERS, QUIET, SHELLS, codeStartsProgram, gitScripts, isDynamic, programAt, programName, splitShell, tokenized, type ShellCommand } from './requests'

/** A path as the command names it, and the folder it is relative to: undefined when that folder is only known as the command runs. */
export type Named = { path: string; cwd: string | undefined }

export type ShellWrite =
  /** Text the command itself holds (a here-document, a here-string, echo's or printf's words), written or appended. */
  | { kind: 'content'; to: Named; content: string; append: boolean }
  /**
   * Files copied, moved or linked in from `from`. `into` is set when `to` is
   * surely a folder they go into (`cp -t`, a path ending in `/`, several
   * sources), unset when that depends on whether it is one. `contents` copies
   * what a folder holds rather than the folder (`rsync src/`, `ditto`);
   * `join` writes the sources one after another into `to` (`cat a b > c`).
   */
  | { kind: 'copy'; to: Named; from: Named[]; into?: boolean; contents?: boolean; join?: boolean; move?: boolean; link?: boolean; via: string }
  /** A repository cloned into `to`. */
  | { kind: 'clone'; to: Named; url: string; ref?: string; submodules: boolean }
  /** A file or folder removed. */
  | { kind: 'remove'; to: Named }
  /**
   * What lands at `to` is only known as it runs: `what` says what makes it.
   * `deep` is set for a folder anything may be written below (an archive
   * unpacked, a checkout), so a folder holding Claude's own counts too.
   * `edit` is set for a file changed in place (`sed -i`, `perl -i`): what
   * lands is the file already there, edited, never anything brought in.
   * `given` is set for a path a program the guard does not know is given,
   * which it may write or only read.
   */
  | { kind: 'unknown'; to: Named; what: string; deep?: boolean; edit?: boolean; given?: boolean }

/**
 * A part of the command only known as it runs; `text` is what to look for
 * Claude's folder in, the whole command when unset, and `cwd` the folder that
 * code runs in, when known, which the files it names are read from. `places`
 * is `text` with what Python or JavaScript code only holds as text blanked
 * (`placesIn`): where the places it may write to are named.
 */
export type Unseen = { reason: string; text?: string; cwd?: string; places?: string }

export type ShellWrites = { writes: ShellWrite[]; unseen: Unseen[] }

/** A command's own text, and the folder it runs in, for the parts of it the guard does not read. */
type Own = { text: string; cwd?: string }

/** How deep `sh -c "sh -c '…'"` is followed before the guard stops reading. */
const MAX_DEPTH = 4

/**
 * Programs that change no file's content: they read, list, open an editor,
 * make folders, or set a mode. Given a path where Claude Code loads from,
 * they add nothing to it.
 */
const NO_CONTENT = new Set([
  'ls', 'stat', 'file', 'du', 'df', 'tree', 'diff', 'cmp', 'comm', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'sha512sum', 'b2sum', 'cksum',
  'realpath', 'readlink', 'basename', 'dirname', 'open', 'xdg-open', 'code', 'cursor', 'subl', 'vim', 'vi', 'nvim', 'nano', 'emacs', 'view', 'bat',
  'hexdump', 'xxd', 'od', 'strings', 'mkdir', 'rmdir', 'chmod', 'chown', 'chgrp', 'touch', 'xattr', 'lsof', 'printenv', 'whereis', 'man', 'help',
  'export', 'unset', 'set', 'alias', 'unalias', 'local', 'declare', 'typeset', 'readonly', 'read', 'exit', 'return', 'wait', 'trap', 'shift', 'shopt',
  'history', 'hash', 'umask', 'ulimit', '[[', ']]', ':', 'fi', 'done', 'esac', '}', 'for', 'select', 'case', 'function', 'in', 'kill', 'pkill', 'ps',
  'id', 'whoami', 'hostname', 'uname', 'tput', 'clear', 'bc', 'expr', 'seq', 'yes', 'paste', 'join', 'look', 'zcat', 'gzcat',
])

/** Words that open or continue a compound command before the command itself: `if`, `then cp …`, `do mv …`, `! test`. */
const LEADING = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time'])

/** Git's subcommands that change the files of the working tree they run in. */
const GIT_CHANGES = new Set(['pull', 'checkout', 'switch', 'merge', 'rebase', 'cherry-pick', 'revert', 'apply', 'am', 'restore', 'read-tree', 'checkout-index', 'mv'])

/** Options of `git clone` that take a value as the next word. */
const CLONE_VALUES = new Set(['-b', '--branch', '-o', '--origin', '-u', '--upload-pack', '--reference', '--reference-if-able', '--separate-git-dir', '--depth', '--shallow-since', '--shallow-exclude', '-c', '--config', '-j', '--jobs', '--filter', '--template', '--bundle-uri', '--server-option', '--revision'])

/** Each copying program's options that take a value: the letters of its short ones, and its long ones written apart from their value. */
const COPY_VALUES: Record<string, { short: string; long: readonly string[] }> = {
  cp: { short: 'tS', long: ['--target-directory', '--suffix'] },
  gcp: { short: 'tS', long: ['--target-directory', '--suffix'] },
  mv: { short: 'tS', long: ['--target-directory', '--suffix'] },
  gmv: { short: 'tS', long: ['--target-directory', '--suffix'] },
  install: { short: 'tmogS', long: ['--target-directory', '--mode', '--owner', '--group', '--suffix'] },
  ln: { short: 'tS', long: ['--target-directory', '--suffix'] },
  scp: { short: 'cFiJlLoPS', long: [] },
  rsync: { short: 'efTBM', long: ['--rsh', '--filter', '--exclude', '--include', '--exclude-from', '--include-from', '--files-from', '--chmod', '--chown', '--log-file', '--partial-dir', '--temp-dir', '--backup-dir', '--suffix', '--rsync-path', '--port', '--password-file', '--compare-dest', '--copy-dest', '--link-dest', '--block-size', '--max-size', '--min-size', '--timeout', '--bwlimit', '--remote-option', '--out-format', '--info', '--debug', '--iconv', '--usermap', '--groupmap'] },
  ditto: { short: '', long: ['--arch', '--bom'] },
}

/** A path on another machine, as rsync and scp name one (`host:path`, `user@host:path`, `rsync://`); a drive letter is not a host. */
const REMOTE = /^(?:rsync:\/\/|scp:\/\/|(?:[^/@:\s]+@)?[^/:\s]{2,}:)/

/** curl's short options that take a value; of them `o` names the file it writes, `c` and `D` other files it writes. */
const CURL_VALUES = 'ocDdHXuAebFTxwKmryYzCEQtUP'
/** curl's long options that name a file it writes. */
const CURL_FILES = new Set(['--output', '--cookie-jar', '--dump-header', '--trace', '--trace-ascii', '--libcurl', '--etag-save', '--stderr', '--hsts', '--alt-svc'])
/** wget's short options that take a value. */
const WGET_VALUES = 'OPoaeiBtTwQUlARDXI'

/**
 * Every write `command` makes, with the folder it runs in when known, and the
 * parts of it only known as it runs. It never throws: a command it cannot
 * read is one part unseen.
 */
export function readShellWrites(command: string, cwd: string | undefined): ShellWrites {
  const out: ShellWrites = { writes: [], unseen: [] }
  try {
    readScript(command, { cwd }, out, 0)
  } catch {
    out.unseen.push({ reason: 'the guard could not read the command' })
  }
  return out
}

/**
 * The folder commands run in as the script goes on; `cd` changes it for the
 * commands after. `loads` holds the variables set earlier in the command,
 * and not unset since, that make a program load code of its own
 * (`export PERL5OPT=…`).
 */
type Where = { cwd: string | undefined; loads?: ReadonlySet<string> }

/**
 * Variables that make a program load or run code besides what it is given,
 * each with the programs that read it: modules or switches added to every run
 * (`PERL5OPT=-MEvil`, `RUBYOPT=-revil`, `NODE_OPTIONS=--require`), folders it
 * loads modules from first, a file bash runs before its script, and, for any
 * program, a library loaded into it or another program found by its name.
 */
const LOADS_CODE: readonly (readonly [programs: RegExp, names: RegExp])[] = [
  [/^perl$/, /^(?:PERL5OPT|PERL5LIB|PERLLIB|PERL5DB)$/],
  [/^ruby$/, /^(?:RUBYOPT|RUBYLIB)$/],
  [/^python[23]?$/, /^(?:PYTHONPATH|PYTHONHOME|PYTHONUSERBASE)$/],
  [/^(?:node|nodejs|bun)$/, /^(?:NODE_OPTIONS|NODE_PATH)$/],
  [/^bash$/, /^BASH_ENV$/],
  [/^/, /^(?:LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|PATH)$/],
]

/** The names `NAME=value` words set. */
function assigned(words: readonly string[]): string[] {
  return words.flatMap(word => /^([A-Za-z_]\w*)=/.exec(word)?.[1] ?? [])
}

/**
 * What `env` among the words before a program takes away from the
 * environment it inherits: the names `-u` gives, or all of it with `-i`.
 */
function envTakes(words: readonly string[]): Set<string> | 'all' {
  const taken = new Set<string>()
  let inEnv = false
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at] as string
    if (programName(word) === 'env') inEnv = true
    else if (!inEnv) continue
    else if (word === '-i' || word === '--ignore-environment' || word === '-') return 'all'
    else if (word === '-u' || word === '--unset') {
      at += 1
      taken.add(words[at] ?? '')
    }
    else if (/^-u./.test(word)) taken.add(word.slice(2))
    else if (word.startsWith('--unset=')) taken.add(word.slice('--unset='.length))
  }
  return taken
}

/** Commands a shell runs itself when named alone, which load nothing a variable can add; `/usr/bin/true` is a program. */
const BUILTINS = new Set(['cd', 'pushd', 'popd', 'chdir', 'export', 'declare', 'typeset', 'readonly', 'local', 'unset', 'eval', 'source', '.', ':', 'echo', 'printf', 'test', '[', 'true', 'false', 'read', 'set', 'shift', 'exit', 'return', 'alias'])

/** The first of `names` that makes `program` load code of its own. */
function loaderFor(program: string, names: Iterable<string>): string | undefined {
  for (const name of names) if (LOADS_CODE.some(([programs, variable]) => programs.test(program) && variable.test(name))) return name
  return undefined
}

function readScript(text: string, where: Where, out: ShellWrites, depth: number): void {
  if (depth > MAX_DEPTH) {
    out.unseen.push({ reason: 'commands are nested too deep to read' })
    return
  }
  for (const command of splitShell(text).commands) readCommand(command, where, out, depth, false)
}

/** A script that runs in a shell of its own: a folder it changes to stays its own, and what it was given carries in. */
function readNested(text: string, where: Where, out: ShellWrites, depth: number): void {
  readScript(text, { cwd: where.cwd, ...(where.loads === undefined ? {} : { loads: where.loads }) }, out, depth + 1)
}

/**
 * The writes of one simple command. `fromInput` is set when its words come
 * in part from input (`xargs`, `find -exec`), so a path it writes may be one
 * the guard never sees.
 */
function readCommand(command: ShellCommand, where: Where, out: ShellWrites, depth: number, fromInput: boolean): void {
  // What its substitutions run comes first, each in a shell of its own.
  for (const script of command.scripts ?? []) readNested(script, where, out, depth)
  let start = 0
  while (LEADING.has(command.words[start] ?? '')) start += 1
  const words = command.words.slice(start)
  const expands = new Set((command.expands ?? []).map(at => at - start))
  const placed = programAt(words)
  const fills = fromInput || placed.fromInput
  const word = words[placed.index]
  const program = word === undefined ? '' : programName(word)
  const args = words.slice(placed.index + 1)
  /** Whether the argument at `at` is only known as the command runs; a home folder's `~` is known. */
  const unknown = (at: number): boolean => expands.has(placed.index + 1 + at) && isDynamic(args[at] as string)
  const named = (path: string): Named => ({ path, cwd: where.cwd })
  const own: Own = { text: [...words, command.input ?? ''].join(' '), ...(where.cwd === undefined ? {} : { cwd: where.cwd }) }
  // Variables that make a program load code: set for the commands after this one, unset, or set (or
  // taken away, by `env -u` or `env -i`) for this one alone.
  const before = words.slice(0, placed.index)
  const setHere = assigned(before)
  const loading = (names: readonly string[]): string[] => names.filter(name => LOADS_CODE.some(([, variable]) => variable.test(name)))
  if (word === undefined || /^(?:export|declare|typeset|readonly|local)$/.test(program)) {
    const added = loading(word === undefined ? setHere : assigned(args))
    if (added.length > 0) where.loads = new Set([...(where.loads ?? []), ...added])
  } else if (program === 'unset' && where.loads !== undefined && !args.some(arg => /^-[a-z]*f/.test(arg))) {
    // `unset -f` takes away functions only.
    const gone = new Set(args.filter(arg => !arg.startsWith('-')))
    where.loads = new Set([...where.loads].filter(name => !gone.has(name)))
  }
  const taken = envTakes(before)
  const inherited = taken === 'all' ? [] : [...(where.loads ?? [])].filter(name => !taken.has(name))
  const loaderOf = (language: string): string | undefined => loaderFor(language, [...setHere, ...inherited])
  const language = program.replace(/\.exe$/, '').replace(/^(python[23]?)\.\d+$/, '$1')
  // A script this command runs in a shell of its own (`sh -c`, `env -S`, `eval`) gets the variables it is given too.
  const given = loading(setHere)
  const child: Where = given.length === 0 && taken !== 'all' && taken.size === 0 ? where : { cwd: where.cwd, loads: new Set([...inherited, ...given]) }
  for (const script of placed.scripts) readNested(script, child, out, depth)
  // A wrapper (`env`, `sudo`) starts first, in the environment as it was before it changes any of it.
  const wrapperAt = before.findIndex(item => !/^[A-Za-z_]\w*=/.test(item))
  const wrapper = wrapperAt === -1 ? undefined : programName(before[wrapperAt])
  const wrapperLoads = wrapper === undefined ? undefined : loaderFor(wrapper, [...assigned(before.slice(0, wrapperAt)), ...(where.loads ?? [])])

  for (const target of command.targets ?? []) {
    if (target.expands && isDynamic(target.path)) {
      out.unseen.push({ reason: 'it writes to a file only known as it runs' })
      continue
    }
    const write = redirected(command, program, args, unknown, named(target.path), target.append, where)
    out.writes.push(write)
    madeBy.set(write, own)
  }
  if (word === undefined) return
  if (expands.has(placed.index) && isDynamic(word)) {
    out.unseen.push({ reason: 'it runs a program only known as it runs' })
    return
  }
  // What a variable makes the program load runs beside whatever it is given: code the guard does not read,
  // with no text of its own, so a path it names is never taken for a file the command only edits.
  const loads = BUILTINS.has(program) && !/[\\/]/.test(word) ? undefined : loaderOf(language)
  const loaded = loads !== undefined ? { by: program, name: loads } : wrapper !== undefined && wrapperLoads !== undefined ? { by: wrapper, name: wrapperLoads } : undefined
  if (loaded !== undefined) out.unseen.push({ reason: `${loaded.by} runs with ${loaded.name} set, so it loads code the guard does not read` })
  const writes = (write: ShellWrite): void => {
    // A write whose paths come from input could be anywhere.
    if (fills) out.unseen.push({ reason: `${program} is given paths from its input, which the guard does not see` })
    else {
      out.writes.push(write)
      madeBy.set(write, own)
    }
  }
  const dynamicPath = (): void => {
    out.unseen.push({ reason: `${program} writes to a path only known as it runs` })
  }
  // A script the command makes or changes before it runs it, by its file name: text the command writes for a shell
  // is read as commands, and code an interpreter runs as inline code is. Otherwise what made it counts as this run:
  // code that names it, or the command that edits it in place, each by its own text (all of it, since what it holds
  // as text may now be code), and anything else with the whole command. A path a program is only given is no file made.
  const madeFirst = (path: string, runner: 'shell' | 'code' | 'program'): void => {
    const name = lastPart(path)
    const made = out.writes.filter(write => lastPart(write.to.path) === name && !(write.kind === 'unknown' && write.given === true))
    const mentioning = out.unseen.filter(part => part.text !== undefined && namesFile(part.text, name))
    if (made.length === 0 && mentioning.length === 0) return
    const [first] = made
    const text = made.length === 1 && mentioning.length === 0 && first?.kind === 'content' && !first.append ? first.content : undefined
    const reason = `${program} runs a script the command makes first, which the guard does not read`
    if (text !== undefined && (runner === 'shell' || (runner === 'program' && (!text.startsWith('#!') || SHELL_LINE.test(text))))) readNested(text, child, out, depth)
    else if (text !== undefined && runner === 'code') {
      if (mayChange(text)) out.unseen.push({ reason: `${program} runs code that may write files or run programs`, text, ...(where.cwd === undefined ? {} : { cwd: where.cwd }), ...placesOf(language, [], [], text, []) })
    } else {
      for (const part of mentioning) out.unseen.push({ reason, text: part.text, ...(part.cwd === undefined ? {} : { cwd: part.cwd }) })
      for (const write of made) {
        const by = write.kind === 'unknown' && write.edit === true ? madeBy.get(write) : undefined
        out.unseen.push(by === undefined ? { reason } : { reason, ...by })
      }
    }
  }

  if (program === 'cd' || program === 'pushd' || program === 'chdir') {
    const target = args.find(arg => !/^-[LPe@]+$/.test(arg))
    if (target === undefined) where.cwd = '~'
    else if (target === '-' || unknown(args.indexOf(target))) where.cwd = undefined
    else where.cwd = join(where.cwd, target)
    return
  }
  if (program === 'popd') {
    where.cwd = undefined
    return
  }
  if (CLAUDE.has(program) || NO_CONTENT.has(program)) return
  if (QUIET.has(program)) {
    // A quiet program that writes a file all the same: `sort -o out`, `uniq in out`.
    if (program === 'sort') {
      const at = args.findIndex(arg => arg === '-o' || arg === '--output')
      const file = at === -1 ? args.find(arg => arg.startsWith('--output='))?.slice('--output='.length) : args[at + 1]
      if (file !== undefined) writes({ kind: 'unknown', to: named(file), what: 'sorted lines' })
    }
    if (program === 'uniq') {
      const plain = args.filter(arg => !arg.startsWith('-'))
      if (plain.length > 1) writes({ kind: 'unknown', to: named(plain[1] as string), what: 'the lines uniq keeps' })
    }
    return
  }
  if (SHELLS.has(program)) {
    const flag = args.findIndex(arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))
    const script = flag === -1 ? undefined : args[flag + 1]
    if (script !== undefined) {
      if (unknown(flag + 1)) out.unseen.push({ reason: `${program} runs a script only known as it runs` })
      else readNested(script, child, out, depth)
      return
    }
    if (command.input !== undefined) return readNested(command.input, child, out, depth)
    // A script file is code already on disk, judged as any program is, by the paths it is given.
    const file = args.findIndex(arg => !arg.startsWith('-'))
    if (file !== -1) {
      madeFirst(args[file] as string, 'shell')
      return pathsGiven(lastPart(args[file] as string), args.slice(file + 1), at => unknown(file + 1 + at), named, writes)
    }
    out.unseen.push({ reason: `${program} runs a script from its input, which the guard does not read`, ...own })
    return
  }
  if (program === 'source' || program === '.') {
    if (args[0] !== undefined) {
      madeFirst(args[0], 'shell')
      pathsGiven(lastPart(args[0]), args.slice(1), at => unknown(1 + at), named, writes)
    }
    return
  }
  if (program === 'eval') {
    readNested(args.join(' '), child, out, depth)
    return
  }
  if (INTERPRETERS.has(language)) {
    // Code given inline (`deno eval` too), or read from input, is not read.
    const inline = args.some(arg => INLINE_CODE.test(arg)) || (program === 'deno' && args[0] === 'eval')
    // A lone `-` in a script's place reads the script from input, as no script at all does.
    const file = args.findIndex(arg => arg === '-' || !arg.startsWith('-'))
    const module = args.findIndex(arg => arg === '-m')
    const fromInput = module === -1 && (file === -1 || args[file] === '-')
    if (inline || command.input !== undefined || fromInput) {
      // Code piped in from elsewhere is unknown. Code in the command counts when it may change
      // something, so one that only reads a file under ~/.claude and prints it goes on.
      const known = inline || command.input !== undefined
      // Code the shell fills in as it runs (`-c "$CODE"`, an unquoted here-document with `$`) is not the
      // text read here. Only the code counts: data passed beside fixed code (`-c '…' "$DATA"`) does not.
      const codeAt = inlineCodeAt(program, args)
      const filledIn = codeAt.length > 0 ? codeAt.some(at => at < args.length && unknown(at)) : command.feedsExpand === true
      const script = language === 'perl' || language === 'ruby' ? language : undefined
      const switches = script === undefined ? undefined : scriptSwitches(script, args)
      // The text a plain replacement writes is no code (`s/old/write tests/`).
      const codeText = script !== undefined && switches !== undefined ? [...words.slice(0, placed.index + 1), ...plainArgs(script, args, switches.code), command.input ?? ''].join(' ') : own.text
      // With code a variable loads beside it (counted above), what an in-place edit writes is no plain edit of the file.
      const inPlaceWrites = loaded === undefined ? writes : (write: ShellWrite): void => writes(write.kind === 'unknown' ? { kind: 'unknown', to: write.to, what: `${write.what}, beside code ${loaded.name} loads` } : write)
      if (!known) out.unseen.push({ reason: `${program} runs code from its input, which the guard does not read`, ...own })
      else if (filledIn) out.unseen.push({ reason: `${program} runs code only known as it runs` })
      else if (mayChange(codeText)) out.unseen.push({ reason: `${program} runs code that may write files or run programs`, ...own, ...placesOf(language, args, codeAt, command.input, words.slice(0, placed.index + 1)) })
      // Perl or Ruby told to edit files in place (`-i`) writes the files named after its code.
      else if (script !== undefined && switches !== undefined) readInPlace(script, switches, args, unknown, where, inPlaceWrites, dynamicPath, fills, out, own, command.input)
      return
    }
    // `python3 -m json.tool` given one file (or none, or `-` for its input) prints it; a second is the file it writes, but for `-`, the screen.
    if (module !== -1 && args[module + 1] === 'json.tool') {
      const files: string[] = []
      const rest = args.slice(module + 2)
      // Options until `--`; `--indent` takes the word after it.
      let options = true
      for (let at = 0; at < rest.length; at += 1) {
        const arg = rest[at] as string
        if (options && arg === '--') options = false
        else if (options && arg === '--indent') at += 1
        else if (!options || arg === '-' || !arg.startsWith('-')) files.push(arg)
      }
      if (files.length <= 1 || (files.length === 2 && files[1] === '-')) return
    }
    // A script file or a module (`python3 -m pip …`) is code already on disk: judged by the paths it is given, not by where it is.
    const from = module !== -1 ? module + 2 : file + 1
    if (module === -1 && file !== -1) madeFirst(args[file] as string, 'code')
    pathsGiven(module !== -1 ? (args[module + 1] ?? program) : lastPart(args[file] as string), args.slice(from), at => unknown(from + at), named, writes)
    return
  }
  if (program === 'find') {
    readFind(args, where, out, depth, writes, named)
    return
  }
  // awk's program can write a file (`print > "f"`) or run a command (`print | "cmd"`, `system()`, `"cmd" | getline`);
  // one that might is code the guard does not read. A `>` anywhere else compares (`length($0) > 80`).
  if (/^[gmn]?awk$/.test(program)) {
    const fromFile = args.some(arg => arg === '-f' || arg.startsWith('--file'))
    const text = args.find(arg => !arg.startsWith('-'))
    if (fromFile || (text !== undefined && AWK_WRITES.test(text))) out.unseen.push({ reason: `${program} runs a program that may write files`, ...own })
    return
  }
  if (Object.hasOwn(COPY_VALUES, program)) {
    readCopy(program, args, unknown, named, writes, dynamicPath, fills, out)
    return
  }
  if (program === 'git') {
    readGit(args, unknown, where, out, depth, writes, dynamicPath)
    return
  }
  if (program === 'curl') {
    readCurl(args, unknown, named, writes, dynamicPath)
    return
  }
  if (program === 'wget') {
    readWget(args, unknown, named, writes, dynamicPath)
    return
  }
  if (program === 'unzip' || program === 'tar' || program === 'gtar' || program === 'bsdtar' || /^7z[az]?$/.test(program)) {
    readArchive(program, args, unknown, named, writes, dynamicPath)
    return
  }
  if (/^(?:gunzip|bunzip2|unxz|unzstd|unlzma)$/.test(program) || (/^(?:gzip|bzip2|xz|zstd|lzma)$/.test(program) && args.some(arg => /^-[A-Za-z]*d/.test(arg) || arg === '--decompress'))) {
    if (args.some(arg => /^-[A-Za-z]*c/.test(arg) || arg === '--stdout')) return
    args.forEach((arg, at) => {
      if (arg.startsWith('-')) return
      if (unknown(at)) dynamicPath()
      else writes({ kind: 'unknown', to: named(arg.replace(/\.(?:gz|bz2|xz|zst|lzma|z)$/i, '')), what: `the file unpacked from ${arg}` })
    })
    return
  }
  if (program === 'tee') {
    const append = args.some(arg => /^-[A-Za-z]*a/.test(arg) || arg === '--append')
    args.forEach((arg, at) => {
      if (arg.startsWith('-') && arg !== '-') return
      if (unknown(at)) dynamicPath()
      else if (command.feeds !== undefined) writes({ kind: 'content', to: named(arg), content: command.feeds, append })
      else writes({ kind: 'unknown', to: named(arg), what: command.feedsExpand === true ? 'text only known as it runs' : 'the input piped to tee' })
    })
    return
  }
  if (program === 'sed' || program === 'gsed') {
    readSedInPlace(args, unknown, named, writes, dynamicPath, out, own)
    return
  }
  if (program === 'dd') {
    for (const [at, arg] of args.entries()) {
      if (!arg.startsWith('of=')) continue
      if (unknown(at)) dynamicPath()
      else writes({ kind: 'unknown', to: named(arg.slice(3)), what: 'what dd copies' })
    }
    return
  }
  if (program === 'rm' || program === 'unlink' || program === 'trash') {
    let options = true
    args.forEach((arg, at) => {
      if (options && arg === '--') options = false
      else if (options && arg.startsWith('-')) return
      else if (!unknown(at)) writes({ kind: 'remove', to: named(arg) })
    })
    return
  }
  // A program the guard does not know: judged by the paths it is given.
  if (/[\\/]/.test(word)) madeFirst(word, 'program')
  pathsGiven(program, args, unknown, named, writes)
}

/** What in an awk program writes a file or runs a command: a print's redirection or pipe, `system()`, a command piped into getline. */
const AWK_WRITES = /\bprintf?\b[^;{}\n]*[>|]|\bsystem\s*\(|\|&?\s*getline\b/

/** The command that made each write, by its own text and folder: what counts when it makes a script the command then runs. */
const madeBy = new WeakMap<ShellWrite, Own>()

/** A first line that starts a shell: `#!/bin/sh`, `#!/usr/bin/env bash`. */
const SHELL_LINE = /^#![^\n]*\b(?:ba|z|da|k)?sh\b/

/** Whether text names a file by its name: as a word of its own, or the last part of a path. */
function namesFile(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[\\s/'"\`(=,])${escaped}(?![\\w.-])`).test(text)
}

/**
 * The options an interpreter takes code inline with, alone or with the code
 * attached (`-c'…'`): `-c` (Python, shells), `-e` and `-E` (Node, Perl,
 * Ruby, Lua, osascript, also bundled as `-pe` or `-lne`), `-p` and
 * `--eval`/`--print` (Node, Bun), `-r` (PHP), `-Command` (PowerShell). Any
 * short option holding one of those letters counts, so code attached to one
 * is never read as a script's name.
 */
const INLINE_CODE = /^(?:-(?!-)[^\s]*[ceEpr]|--eval(?:=.*)?|--print(?:=.*)?|-Command|-command)/

/**
 * Where the code an interpreter is given inline sits among its arguments:
 * the word after an option that stands alone (`-c`, `-pe`, `--eval`), or the
 * option's own word when the code is attached to it (`-c'…'`, `--eval=…`),
 * and the word after `deno eval`.
 */
function inlineCodeAt(program: string, args: readonly string[]): number[] {
  const at: number[] = []
  args.forEach((arg, index) => {
    if (!INLINE_CODE.test(arg)) return
    at.push(/^(?:-(?!-)[A-Za-z]*[ceEpr]|--eval|--print|-Command|-command)$/.test(arg) ? index + 1 : index)
  })
  if (program === 'deno' && args[0] === 'eval') at.push(1)
  return at
}

/** Code that hides what it does: eval, imports and attributes by name, decoding, characters made or escaped. */
const HIDES = /\b(?:instance_|class_|module_)?eva\x6c\b|\bFunction\s*\(|__im\x70ort__|\bim\x70ortlib|\bgetattr|\bsetattr|\bglobals\s*\(|\bcom\x70ile\s*\(|\bmarshal|\bpickle|\bbase64|\bb\d\ddecode|\ba85decode|\bunhexlify|\bfromhex|\bcodecs|\\x[0-9a-fA-F]{2}|\bchr\s*\(|\bfromCharCode|\batob\b/i

/**
 * What inline code does that may change something, in the languages run
 * inline: writing, appending, copying, moving, deleting or making files;
 * opening one for writing; running another program; and hiding what it does
 * (eval, imports by name, decoding, escapes). A shell redirection or a
 * backquote inside the code counts too; an arrow (`=>`, `->`) does not.
 * Printing to the screen (`sys.stdout.write`) is no write. Written as
 * escaped patterns, which the guard's own scan reads as patterns, not as the
 * guard running these.
 */
const MAY_CHANGE: readonly RegExp[] = [
  /(?<!std(?:out|err)\.)writ(?:e|ing)|append|\bdump\s*\(|copyfile|copytree|copy2|\bcopy\s*\(|cpSync|\bcp\s*\(|\brename|\bremove|\bunlink|rmtree|rmdir|\brmSync|\brm\s*\(|mkdir|makedirs|mkdtemp|symlink|hardlink|chmod|chown|\btouch|truncate|utime|extractall|urlretrieve|download|shutil|FileUtils|file_put_contents|fopen|fputs/i,
  // With or without parentheses: Perl's `open my $fh, "+<", $path` opens for writing too.
  /\bopen\b[\s(]*[^,;)]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+]/i,
  // A mode after a first argument that is itself a call (`open(os.path.join(a, b), 'w')`), within open's own parentheses.
  /\bopen\s*\((?:[^()\n;]|\((?:[^()\n]|\([^()\n]*\))*\))*?,\s*(?:mode\s*=\s*)?['"][rbtU]*[wax+][rwxabtU+]*['"]/i,
  /\bsub\x70rocess|\bchild_\x70rocess|\bs\x70awn|\bexe\x63|\bsyste\x6d\b|\x70open|\bfork\s*\(|\bOpen3|\bProcessBuilder|\bgetRuntime|\bshell_exe\x63|\bpassthru|\bproc_open|\bdo shell s\x63ript|\bDeno\.(?:run|Command)|\bStart-Process|\bInvoke-|\biex\b|\bSet-Content|\bAdd-Content|\bOut-File|\bNew-Item|\bRemove-Item|\bCopy-Item|\bMove-Item|\bRename-Item/i,
  HIDES,
  /(?<![=-])>|\x60/,
  // Any call on Python's os or Node's fs but the few that only read: os.replace, os.link and
  // os.open with write flags change files as surely as the names above.
  /\bos\.(?!path\b|environ\b|getcwdb?\b|listdir\b|scandir\b|stat\b|lstat\b|walk\b|getenv\b|sep\b|linesep\b|name\b|getpid\b|cpu_count\b|curdir\b|pardir\b|devnull\b|fspath\b|fsencode\b|fsdecode\b|access\b|uname\b|getlogin\b|getuid\b|getgid\b|geteuid\b|isatty\b|readlink\b|get_terminal_size\b|extsep\b|altsep\b|pathsep\b)\w+/,
  /\bfs\.(?!(?:readFile|readdir|stat|lstat|exists|access|realpath|readlink|opendir)(?:Sync)?\b|createReadStream\b|constants\b|promises\.(?:readFile|readdir|stat|lstat|access|realpath|readlink|opendir)\b)\w+/,
  // A read call can still open for writing: Node's flag option (`{ flag: 'w' }`), or the open flags themselves.
  /\bflags?\s*[:=]\s*['"][^'"]*[wax+]|\bO_(?:WRONLY|RDWR|CREAT|TRUNC|APPEND)\b/i,
  // A path object's own changes (Path(…).replace), and deleting or moving by name.
  /\bPath\b[\s\S]*\.(?:replace|rename|unlink|rmdir|touch|symlink_to|hardlink_to|link_to|chmod|lchmod)\s*\(|\bdelete\b|\bmove\s*\(/i,
  // Perl's and Ruby's other ways to run a program (`qx{…}`, `readpipe`, `%x(…)`, a pipe opened as a file),
  // to edit files in place without -i (`$^I`, `$-i`, `inplace_mode`), and Perl's File::Copy, whose calls need no parentheses.
  /\bqx\b|\breadpipe\b|%x[({[<|!]|\bopen\b[\s(]*(?:[^,;'"]*,\s*)?['"](?:\s*\||[^'"]*\|\s*['"])|\$\^I\b|\$-i\b|\binplace_mode\b|File::Copy\b/,
]

/**
 * Whether code an interpreter runs from the command may change something:
 * any of MAY_CHANGE in its text. Read over the code and its arguments
 * together, so a path that merely looks like one of those words holds it
 * too: a needless hold is the safer way to be wrong. Code attached to its
 * option (`-lne'unlink $_'`) is also read set apart from it, so a word the
 * code starts with counts as a word. The files Perl or Ruby edits in place
 * (`-i`) are read apart, by readInPlace.
 */
function mayChange(text: string): boolean {
  const apart = text.replace(/(^|\s)(-(?!-)[A-Za-z]*?[ceEpr])(?=\S)/g, '$1$2 ')
  return MAY_CHANGE.some(pattern => pattern.test(text) || pattern.test(apart))
}

/**
 * A command's own text, as `Own` joins it, with its Python or JavaScript
 * code read by `placesIn`: the code inline at `codeAt` among its arguments,
 * or else its input. Nothing for another language.
 */
function placesOf(language: string, args: readonly string[], codeAt: readonly number[], input: string | undefined, lead: readonly string[]): { places?: string } {
  const read = tokenized(language)
  if (read === undefined) return {}
  const code = codeAt.length === 0 && input !== undefined
  return { places: [...lead, ...args.map((arg, at) => (codeAt.includes(at) ? placesIn(arg, read) : arg)), code ? placesIn(input, read) : (input ?? '')].join(' ') }
}

/**
 * Python or JavaScript code with what it only holds as text blanked, so the
 * paths left are those it may write to: its comments and patterns, never a
 * path; and, when it starts no program and hides nothing (`HIDES`), its
 * strings that run over lines (an edit script's old and new text) or read as
 * prose. Such code reaches a file only by the paths its own calls are given,
 * and a block of text or a sentence is no path. Code that starts a program
 * may hand any of its text to a shell, so all of it counts.
 */
function placesIn(code: string, language: 'python' | 'js'): string {
  const kind = spanKinds(code, language)
  let bare = ''
  let only = ''
  for (let at = 0; at < code.length; at += 1) {
    const text = code[at] === '\n' || kind(at) === 'code' || kind(at) === 'string'
    bare += text ? code[at] : ' '
    only += code[at] === '\n' || kind(at) === 'code' ? code[at] : ' '
  }
  // What hides is read in the code itself: a string that names `base64` or `\x2e` is text, as a scanner's own source is.
  if (codeStartsProgram(bare, language) || HIDES.test(only)) return bare
  // Python that can write only the files it opens by name names just those.
  const targets = language === 'python' ? pythonWrites(code, only, kind) : undefined
  if (targets !== undefined) return targets.join('\n')
  const prose = proseTest(code, kind)
  let out = ''
  for (let at = 0; at < bare.length; ) {
    let end = at + 1
    while (end < bare.length && (kind(end) === 'string') === (kind(at) === 'string')) end += 1
    const part = bare.slice(at, end)
    out += kind(at) === 'string' && (part.includes('\n') || prose(at)) ? part.replace(/[^\n]/g, ' ') : part
    at = end
  }
  return out
}

/** Python modules whose calls write no file of their own: code that imports only these writes what it opens. */
const PYTHON_PURE = /^(?:re|sys|json|textwrap|string|collections|itertools|functools|difflib|unicodedata|math|datetime|time|typing|dataclasses|hashlib|fnmatch|glob|pprint|enum|copy|operator|random|statistics|html|shlex|urllib\.parse)$/

/** An import statement, alone: `import a, b as c` or `from a import b, c`. */
const PYTHON_IMPORT = /^\s*(?:from\s+([\w.]+)\s+import\s+[\w\s,*()]+|import\s+([\w\s.,]+))\s*$/

/**
 * The files Python code writes, when it can write only by calling `open`
 * with a path it holds as a literal: given there, named by a literal, or
 * passed as one to a function of the code's own. Undefined when it imports a
 * module that can write (`os`, `pathlib`, `shutil`) or reaches one another
 * way (`sys.modules`, a double-underscore name), uses `open` other than by
 * calling it, opens a file in a mode it builds, or opens one at a path it
 * builds. `only` is the code with its strings and comments blanked.
 */
function pythonWrites(code: string, only: string, kind: (index: number) => SpanKind): string[] | undefined {
  for (const statement of only.split(/[;\n]/)) {
    if (!/\bimport\b/.test(statement)) continue
    const found = PYTHON_IMPORT.exec(statement)
    const modules = found === null ? [''] : found[1] !== undefined ? [found[1]] : (found[2] ?? '').split(',').map(part => part.trim().split(/\s+as\s+/)[0] ?? '')
    if (!modules.every(name => PYTHON_PURE.test(name))) return undefined
  }
  if (/\bsys\s*\.\s*modules\b|__(?!(?:name|main|file)__)\w+__|\bbuiltins\b|\bopen\b(?!\s*\()|\.\s*open\b/.test(only)) return undefined
  const targets: string[] = []
  for (const found of only.matchAll(/\bopen\s*\(/g)) {
    const args = callArgs(code, kind, (found.index ?? 0) + found[0].length - 1)
    if (args === undefined) return undefined
    const { plain, named } = args
    const mode = named.get('mode') ?? plain[1]
    // With no mode it reads.
    if (mode === undefined) continue
    const opened = pythonString(mode)
    if (opened === undefined) return undefined
    if (!/[wax+]/.test(opened)) continue
    const file = named.get('file') ?? plain[0]
    const paths = file === undefined ? undefined : pythonValues(file, code, only, kind, 0)
    if (paths === undefined) return undefined
    targets.push(...paths)
  }
  return targets
}

/** A Python string literal on one line with no escapes, as its text: `'a.md'`, `r"b"`. */
function pythonString(expression: string): string | undefined {
  return /^(?:[rRbBuU]{1,2})?(['"])((?:(?!\1)[^\\\n])*)\1$/.exec(expression.trim())?.[2]
}

/**
 * The texts an expression in Python code may hold: a literal's own, or every
 * literal a name is bound to, by `name = '…'` or as a parameter of a function
 * the code defines, through what each call of it passes. Undefined when any
 * is not a literal, or the name is bound another way (a loop, `as`, a tuple,
 * `global`), or not at all.
 */
function pythonValues(expression: string, code: string, only: string, kind: (index: number) => SpanKind, depth: number): string[] | undefined {
  const text = pythonString(expression)
  if (text !== undefined) return [text]
  const name = expression.trim()
  if (depth > 1 || !/^[A-Za-z_]\w*$/.test(name)) return undefined
  const values: string[] = []
  let bound = false
  for (const found of only.matchAll(new RegExp(`(?<![\\w.])${name}\\b`, 'g'))) {
    const at = found.index ?? 0
    const start = Math.max(only.lastIndexOf('\n', at - 1), only.lastIndexOf(';', at - 1)) + 1
    const before = only.slice(start, at)
    const after = only.slice(at + name.length)
    // `name = '…'` as a statement of its own.
    const assigned = /^[ \t]*=(?!=)/.exec(after)
    if (assigned !== null && /^\s*$/.test(before)) {
      const from = at + name.length + assigned[0].length
      const ends = [only.indexOf('\n', from), only.indexOf(';', from)].filter(end => end !== -1)
      const value = pythonString(code.slice(from, ends.length === 0 ? code.length : Math.min(...ends)))
      if (value === undefined) return undefined
      values.push(value)
      bound = true
      continue
    }
    // A parameter of a function of the code's own: what each call passes it, or its default.
    const parameter = /\bdef\s+(\w+)\s*\(([^()]*?)$/.exec(before)
    if (parameter !== null && /^\s*(?:,|\)|=)/.test(after) && /(?:^|,)\s*$/.test(parameter[2] ?? '')) {
      const passed = callValues(parameter[1] as string, (parameter[2] ?? '').split(',').length - 1, name, after, code, only, kind, depth)
      if (passed === undefined) return undefined
      values.push(...passed)
      bound = true
      continue
    }
    // Bound any other way (one of several names a statement assigns, `p, q = …`), or changed in place.
    const tuple = /^[\s\w,]*$/.test(before) && /^\s*,[^;\n=]*=(?!=)/.test(after)
    if (tuple || /^\s*(?:[-+*/%&|^@]|\/\/|\*\*|<<|>>)?=(?!=)|^[ \t]*:(?![ \t]*(?:\n|$))/.test(after) || /\b(?:for|as|global|nonlocal|del|lambda|import)\b[^;\n]*$|\*\s*$/.test(before)) return undefined
  }
  return bound ? values : undefined
}

/**
 * What every call of `func`, a function the code defines, passes the
 * parameter at `index`, named `name`, or its default when a call passes
 * none (`after` is the code after the parameter's name in the definition).
 * Undefined when the function is used other than by a plain call.
 */
function callValues(func: string, index: number, name: string, after: string, code: string, only: string, kind: (index: number) => SpanKind, depth: number): string[] | undefined {
  const fallback = /^\s*=\s*([^,)]*)/.exec(after)?.[1]
  const values: string[] = []
  for (const found of only.matchAll(new RegExp(`(?<![\\w.])${func}\\b`, 'g'))) {
    const at = found.index ?? 0
    if (/\bdef\s+$/.test(only.slice(Math.max(0, at - 8), at))) continue
    const open = /^\s*\(/.exec(only.slice(at + func.length))
    if (open === null) return undefined
    const args = callArgs(code, kind, at + func.length + open[0].length - 1)
    if (args === undefined || args.spread) return undefined
    const given = args.named.get(name) ?? args.plain[index] ?? fallback
    if (given === undefined) continue
    const passed = pythonValues(given, code, only, kind, depth + 1)
    if (passed === undefined) return undefined
    values.push(...passed)
  }
  return values
}

/**
 * The arguments of the call whose `(` is at `open`, split at the commas of
 * its own code: positional ones in order, keyword ones by name, and whether
 * any is spread (`*args`, `**kw`). Undefined when the call does not close.
 */
function callArgs(code: string, kind: (index: number) => SpanKind, open: number): { plain: string[]; named: Map<string, string>; spread: boolean } | undefined {
  const parts: string[] = []
  let depth = 0
  let from = open + 1
  for (let at = open + 1; at < code.length; at += 1) {
    if (kind(at) !== 'code') continue
    const char = code[at] as string
    if ('([{'.includes(char)) depth += 1
    else if (')]}'.includes(char)) {
      if (depth > 0) {
        depth -= 1
        continue
      }
      parts.push(code.slice(from, at))
      const plain: string[] = []
      const named = new Map<string, string>()
      let spread = false
      for (const part of parts.map(item => item.trim()).filter(item => item !== '')) {
        const keyword = /^(\w+)\s*=(?!=)\s*([\s\S]*)$/.exec(part)
        if (part.startsWith('*')) spread = true
        else if (keyword !== null) named.set(keyword[1] as string, keyword[2] as string)
        else plain.push(part)
      }
      return { plain, named, spread }
    } else if (char === ',' && depth === 0) {
      parts.push(code.slice(from, at))
      from = at + 1
    }
  }
  return undefined
}

/**
 * Perl's and Ruby's switches that take a value: `code` the code given
 * inline, `rest` the rest of their word, `next` the next word when nothing is
 * attached, and `digits` only the digits after them. Any other letter is a
 * switch of its own, and more may follow it in the same word (`-pi.bak`).
 */
const SCRIPT_SWITCHES = {
  perl: { code: 'eE', rest: 'CDeEFiIMmx', next: 'eEI', digits: '0l' },
  ruby: { code: 'e', rest: 'CeEFiIKrTWxX', next: 'CeEIrX', digits: '0' },
} as const

/**
 * What in the code makes the edit something the guard cannot follow: a
 * module it loads (Perl's `use` and `no` statements, `require` anywhere, as
 * it can be part of an expression, any `do` but a block, as `do q(file)` runs
 * a file, Ruby's `load`), or a
 * hand on the list of files it edits or the folder they are named in: the
 * list by name (`ARGV`, Ruby's `$*` and `ARGF`), Perl's symbolic references
 * and symbol table (`@{"AR"."GV"}`, `$::{…}`), Ruby's calls by name (`send`,
 * `const_get`), and `chdir`. Read over the code alone, so a file's name never
 * counts, and without the text of its plain replacements (`plainCode`).
 * Anywhere else a `require` counts, as it may follow any word in Perl
 * (`print require "x"`): a needless hold is the safer way to be wrong.
 */
const IN_PLACE_LOADS = {
  perl: /(?:^|[;{}])\s*(?:use|no)\b|\brequire\b|\bdo\b(?!\s*\{)/m,
  ruby: /\b(?:require(?:_relative)?|load|autoload)\b/,
} as const
const IN_PLACE_CHOOSES = {
  perl: /\bARGV\b|[@*$%&]\s*\{\s*[^}\w\s]|::\s*\{|\bchdir\b/,
  ruby: /\bARGV\b|\$\*|\bARGF\b|\bchdir\b|\bconst_get\b|\.\s*(?:public_)?send\b|\b__send__\b|\bsend\s*\(|\bbinding\b/,
} as const

/**
 * Code made only of substitutions whose replacement is plain text, which is
 * text the edit writes and never code. Perl's (`s/old/new words/g;`): the
 * same mark around each part, none of the brackets Perl pairs, no `e` flag to
 * run the replacement, and no `$` or `@` to fill one in. Ruby's
 * (`gsub(/old/, "new words")`, `sub`, with `!` or on `$_`): a regular
 * expression and a quoted string, neither with a `#`, as `#{…}` runs code
 * and Ruby reads a `/` inside one as part of it. Perl finds where each part
 * ends by its mark alone, so the guard reads the parts as Perl does. `whole`
 * is the code, `edit` each substitution in it, whole, so it never starts
 * inside another's pattern, and `as` what is left of it.
 */
const PLAIN_EDITS = {
  perl: {
    whole: /^(?:\s*s([^\w\s{(<[])(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\$@])*\1[a-df-z]*\s*(?:;|$))+\s*$/,
    edit: /\bs([^\w\s{(<[])((?:\\.|(?!\1)[^\\])*)\1(?:\\.|(?!\1)[^\\$@])*\1/g,
    as: 's$1$2$1$1',
  },
  ruby: {
    whole: /^(?:\s*(?:\$_\s*\.\s*)?g?sub!?\s*\(\s*\/(?:\\.|[^\\/\n#])*\/[a-z]*\s*,\s*(?:'(?:\\.|[^\\'#])*'|"(?:\\.|[^\\"#])*")\s*\)\s*(?:;|$))+\s*$/,
    edit: /((?:\$_\s*\.\s*)?\bg?sub!?\s*\(\s*\/(?:\\.|[^\\/\n#])*\/[a-z]*\s*,\s*)(?:'(?:\\.|[^\\'#])*'|"(?:\\.|[^\\"#])*")(\s*\))/g,
    as: "$1''$2",
  },
} as const

/** Code without the text of its replacements, when it is made only of plain ones (PLAIN_EDITS); any other code as it is. */
function plainCode(language: 'perl' | 'ruby', code: string): string {
  const { whole, edit, as } = PLAIN_EDITS[language]
  return whole.test(code) ? code.replace(edit, as) : code
}

/** Perl's or Ruby's switches: the code given inline, each `-e` apart, `-i`'s suffix, a module loaded, a folder changed to, and where the words after them start. */
type ScriptSwitches = { code: Value[]; suffix?: Value; module: boolean; folder?: Value; after: number }

function scriptSwitches(language: 'perl' | 'ruby', args: readonly string[]): ScriptSwitches {
  const spec = SCRIPT_SWITCHES[language]
  let suffix: Value | undefined
  const code: Value[] = []
  let module = false
  /** The folder it changes to before it runs (`ruby -C dir`, `-xdir`). */
  let folder: Value | undefined
  let at = 0
  for (; at < args.length; at += 1) {
    const arg = args[at] as string
    if (arg === '--') {
      at += 1
      break
    }
    if (!arg.startsWith('-') || arg === '-') break
    if (arg.startsWith('--')) continue
    for (let letter = 1; letter < arg.length; letter += 1) {
      const name = arg[letter] as string
      const rest = arg.slice(letter + 1)
      if (spec.digits.includes(name)) {
        letter += (language === 'perl' && name === '0' ? /^(?:x[\da-f]+|\d*)/i : /^\d*/).exec(rest)?.[0].length ?? 0
        continue
      }
      // `-d:Module` loads a debugger module; `-d` alone is a switch of its own.
      if (language === 'perl' && name === 'd') {
        if (!/^t?:/.test(rest)) continue
        module = true
        break
      }
      if (!spec.rest.includes(name)) continue
      const value: Value = rest === '' && spec.next.includes(name) ? { value: args[at + 1] ?? '', at: at + 1 } : { value: rest, at }
      if (spec.code.includes(name)) code.push(value)
      else if (name === 'i') suffix = value
      else if (language === 'perl' ? name === 'M' || name === 'm' : name === 'r') module = true
      else if (name === 'x' ? rest !== '' : language === 'ruby' && (name === 'C' || name === 'X')) folder = value
      at = value.at
      break
    }
  }
  return { code, ...(suffix === undefined ? {} : { suffix }), module, ...(folder === undefined ? {} : { folder }), after: at }
}

/** The arguments with the code in them read as plainCode does, for what that code may do. */
function plainArgs(language: 'perl' | 'ruby', args: readonly string[], code: readonly Value[]): string[] {
  const plain = [...args]
  for (const { value, at } of code) {
    const word = plain[at]
    if (word !== undefined) plain[at] = `${word.slice(0, word.length - value.length)}${plainCode(language, value)}`
  }
  return plain
}

/**
 * `perl -i` and `ruby -i`: each file named after the code is edited in
 * place, and with a suffix (`-i.bak`) a copy of it is kept as well, each a
 * write of content only known as it runs. With no file, it edits its input
 * and writes nothing. A module loaded beside it (`-M`, `-m`, `-d:`, `-r`, or
 * by name in the code) is code the guard does not read, and so is code that
 * chooses which files it edits.
 */
function readInPlace(language: 'perl' | 'ruby', switches: ScriptSwitches, args: readonly string[], unknown: (at: number) => boolean, where: Where, writes: Writes, dynamicPath: () => void, fills: boolean, out: ShellWrites, own: Own, input: string | undefined): void {
  const { code, suffix, module, folder, after } = switches
  if (suffix === undefined) return
  // With no code inline, a here-document is the script.
  const source = code.length > 0 ? code.map(item => plainCode(language, item.value)).join('\n') : (input ?? '')
  if (module || IN_PLACE_LOADS[language].test(source)) {
    out.unseen.push({ reason: `${language} loads a module beside the files it edits in place, which the guard does not read`, ...own })
    return
  }
  if (IN_PLACE_CHOOSES[language].test(source)) {
    out.unseen.push({ reason: `${language} edits files in place that its code chooses as it runs`, ...own })
    return
  }
  if (fills) {
    out.unseen.push({ reason: `${language} is given paths from its input, which the guard does not see` })
    return
  }
  const cwd = folder === undefined ? where.cwd : unknown(folder.at) ? undefined : join(where.cwd, folder.value)
  // With no code given inline, the first word left names the script.
  for (let file = code.length > 0 ? after : after + 1; file < args.length; file += 1) {
    const path = args[file] as string
    if (path === '-') continue
    if (unknown(file)) {
      dynamicPath()
      continue
    }
    writes({ kind: 'unknown', to: { path, cwd }, what: `an edit ${language} makes`, edit: true })
    const kept = keptCopy(language, path, suffix.value)
    if (kept === undefined) continue
    if (unknown(suffix.at)) dynamicPath()
    else writes({ kind: 'unknown', to: { path: kept, cwd }, what: `the copy ${language} keeps of the file it edits` })
  }
}

/** The copy `-i` keeps of a file it edits: its suffix added to the name, or in Perl's, each `*` standing for the name. */
function keptCopy(language: 'perl' | 'ruby', path: string, suffix: string): string | undefined {
  if (suffix === '' || (language === 'perl' && suffix === '*')) return undefined
  return language === 'perl' && suffix.includes('*') ? suffix.split('*').join(path) : `${path}${suffix}`
}

/**
 * What a program the guard does not read may write: anywhere among the paths
 * it is given, each one word that names a path (`.`, `~`, or with a `/`),
 * as an argument or an option's value (`--dir=~/.claude/skills`).
 */
function pathsGiven(program: string, args: readonly string[], unknown: (at: number) => boolean, named: (path: string) => Named, writes: Writes): void {
  args.forEach((arg, at) => {
    const path = arg.startsWith('-') ? (/^--?[\w-]+=(.+)$/.exec(arg)?.[1] ?? '') : arg
    // A path is one word: text with spaces in it is a message, such as a pull request's body.
    if (path === '' || unknown(at) || /\s/.test(path) || /^[A-Za-z][\w+.-]*:\/\//.test(path)) return
    if (path === '.' || path === '..' || path.startsWith('~') || path.includes('/')) {
      writes({ kind: 'unknown', to: named(path), what: `what ${program} writes when given this path`, given: true })
    }
  })
}

/** What a redirection writes: text the command holds, a file `cat` copies, or a program's output. */
function redirected(command: ShellCommand, program: string, args: readonly string[], unknown: (at: number) => boolean, to: Named, append: boolean, where: Where): ShellWrite {
  const content = printed(command, program, args, unknown)
  if (content !== undefined) return { kind: 'content', to, content, append }
  if (program === 'cat') {
    const files = args.filter(arg => !arg.startsWith('-'))
    if (files.length > 0 && files.length === args.length && files.every((_, at) => !unknown(at))) {
      return append ? { kind: 'unknown', to, what: `the files cat adds to it` } : { kind: 'copy', to, from: files.map(path => ({ path, cwd: where.cwd })), join: true, via: 'cat' }
    }
  }
  if ((program === 'cat' || program === 'tee') && command.feedsExpand === true) return { kind: 'unknown', to, what: 'text only known as it runs' }
  return { kind: 'unknown', to, what: program === '' ? 'nothing' : `the output of ${program}` }
}

/** The exact text a command prints, when it is known from the command alone: echo's or printf's words, or what cat or tee is fed. */
function printed(command: ShellCommand, program: string, args: readonly string[], unknown: (at: number) => boolean): string | undefined {
  // A redirection on its own (`> file`, `: > file`) makes the file empty.
  if (program === '' || program === ':' || program === 'true') return ''
  if (program === 'cat' || program === 'tee') {
    const files = args.filter(arg => !arg.startsWith('-') || arg === '-')
    if (files.some(file => file !== '-') && program === 'cat') return undefined
    return command.feeds
  }
  if (args.some((_, at) => unknown(at))) return undefined
  if (program === 'echo') {
    let at = 0
    let newline = true
    for (; at < args.length && /^-[neE]+$/.test(args[at] as string); at += 1) {
      // Escapes are read differently by each shell's echo, so text with one is not known.
      if ((args[at] as string).includes('e')) return undefined
      if ((args[at] as string).includes('n')) newline = false
    }
    const words = args.slice(at)
    if (words.some(item => item.includes('\\'))) return undefined
    return `${words.join(' ')}${newline ? '\n' : ''}`
  }
  if (program === 'printf' && args[0] !== undefined && !args[0].startsWith('-')) return printfText(args[0], args.slice(1))
  return undefined
}

/** What printf prints for a format of `%s`, `%%` and the common escapes, used again until the arguments run out; undefined for any other. */
function printfText(format: string, args: readonly string[]): string | undefined {
  const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" }
  let out = ''
  let next = 0
  for (let round = 0; round < 1000; round += 1) {
    let used = false
    for (let at = 0; at < format.length; at += 1) {
      const char = format[at] as string
      if (char === '\\' || char === '%') {
        const code = format[at + 1]
        at += 1
        if (char === '\\') {
          if (code === undefined || !Object.hasOwn(escapes, code)) return undefined
          out += escapes[code]
        } else if (code === '%') out += '%'
        else if (code === 's') {
          out += args[next] ?? ''
          next += 1
          used = true
        } else return undefined
      } else out += char
    }
    if (!used || next >= args.length) return out
  }
  return undefined
}

/** A path joined to the folder it is relative to: an absolute path or `~` stands alone; relative to an unknown folder it is unknown. */
function join(cwd: string | undefined, path: string): string | undefined {
  // `~user` stands alone too: it is another user's home, never a relative path.
  if (/^(?:\/|~|[A-Za-z]:[\\/])/.test(path)) return path
  return cwd === undefined ? undefined : `${cwd.replace(/\/+$/, '')}/${path}`
}

/** The last part of a path, without the slashes after it. */
export function lastPart(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
}

/** An option's value and where it is among the arguments. */
type Value = { value: string; at: number }

/**
 * Splits a program's arguments into options and the plain words after them,
 * as `short` (letters taking a value) and `long` (long options taking a
 * value as the next word) say. Each value and plain word keeps its place
 * among the arguments.
 */
function options(args: readonly string[], short: string, long: readonly string[]): { values: Map<string, Value[]>; flags: Set<string>; plain: Value[] } {
  const values = new Map<string, Value[]>()
  const flags = new Set<string>()
  const plain: Value[] = []
  const add = (name: string, value: string, at: number): void => {
    values.set(name, [...(values.get(name) ?? []), { value, at }])
  }
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] as string
    if (arg === '--') {
      for (let rest = at + 1; rest < args.length; rest += 1) plain.push({ value: args[rest] as string, at: rest })
      break
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=')
      if (equals !== -1) add(arg.slice(0, equals), arg.slice(equals + 1), at)
      else if (long.includes(arg)) {
        add(arg, args[at + 1] ?? '', at + 1)
        at += 1
      } else flags.add(arg)
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let letter = 1; letter < arg.length; letter += 1) {
        const name = arg[letter] as string
        if (short.includes(name)) {
          const rest = arg.slice(letter + 1)
          if (rest !== '') add(`-${name}`, rest, at)
          else {
            add(`-${name}`, args[at + 1] ?? '', at + 1)
            at += 1
          }
          break
        }
        flags.add(`-${name}`)
      }
      continue
    }
    plain.push({ value: arg, at })
  }
  return { values, flags, plain }
}

/** The values of every option `names` gives. */
function valuesOf(values: Map<string, Value[]>, ...names: string[]): Value[] {
  return names.flatMap(name => values.get(name) ?? [])
}

type Writes = (write: ShellWrite) => void

/** `cp`, `mv`, `install`, `ln`, `rsync` and `ditto`: what they copy, move or link, and where. */
function readCopy(program: string, args: readonly string[], unknown: (at: number) => boolean, named: (path: string) => Named, writes: Writes, dynamicPath: () => void, fills: boolean, out: ShellWrites): void {
  const spec = COPY_VALUES[program] as { short: string; long: readonly string[] }
  const { values, flags, plain } = options(args, spec.short, spec.long)
  if (program === 'install' && (flags.has('-d') || flags.has('--directory'))) return
  const targetDir = valuesOf(values, '-t', '--target-directory')[0]
  const dest = targetDir ?? plain[plain.length - 1]
  const sources = targetDir === undefined ? plain.slice(0, -1) : plain
  // A link made with one name only is made in the current folder.
  if (program === 'ln' && targetDir === undefined && plain.length === 1) {
    const only = plain[0] as Value
    if (unknown(only.at)) return dynamicPath()
    return writes({ kind: 'copy', to: named('.'), from: [named(only.value)], into: true, link: true, via: 'ln' })
  }
  // Paths from input (`xargs cp -t dir`), or a source only known as it runs: what lands is not known, where it lands is.
  if (fills && dest !== undefined && !unknown(dest.at)) return writes({ kind: 'unknown', to: named(dest.value), what: `files ${program} copies from paths only known as it runs`, deep: true })
  if (dest === undefined || sources.length === 0) return
  if (unknown(dest.at)) return dynamicPath()
  // A copy to another machine writes nothing here.
  if ((program === 'rsync' || program === 'scp') && REMOTE.test(dest.value)) return
  if (sources.some(item => unknown(item.at))) {
    return writes({ kind: 'unknown', to: named(dest.value), what: `files ${program} copies from paths only known as it runs`, deep: true })
  }
  if (program === 'ditto' && (flags.has('-x') || flags.has('-c'))) {
    return writes({ kind: 'unknown', to: named(dest.value), what: flags.has('-x') ? 'the files unpacked from an archive' : 'an archive ditto makes', deep: flags.has('-x') })
  }
  // A source on another machine: what arrives is only known as it runs.
  if ((program === 'rsync' || program === 'scp') && sources.some(item => REMOTE.test(item.value))) {
    return writes({ kind: 'unknown', to: named(dest.value), what: `files ${program} fetches from another machine`, deep: true })
  }
  const noTarget = flags.has('-T') || flags.has('--no-target-directory')
  const into = targetDir !== undefined || (!noTarget && (sources.length > 1 || /[\\/]$/.test(dest.value))) ? true : noTarget ? false : undefined
  const contents = program === 'ditto' || (program === 'rsync' && sources.every(item => /\/$/.test(item.value))) || sources.every(item => /\/\.$/.test(item.value))
  const move = program === 'mv' || program === 'gmv'
  writes({
    kind: 'copy',
    to: named(dest.value),
    from: sources.map(item => named(item.value)),
    ...(into === undefined ? {} : { into }),
    ...(contents ? { contents } : {}),
    ...(move ? { move } : {}),
    ...(program === 'ln' ? { link: true } : {}),
    via: program,
  })
  // A move takes the files away from where they were.
  if (move) for (const item of sources) writes({ kind: 'remove', to: named(item.value) })
}

/** `git clone` into a folder, and the subcommands that change the files of the tree they run in. */
function readGit(args: readonly string[], unknown: (at: number) => boolean, where: Where, out: ShellWrites, depth: number, writes: Writes, dynamicPath: () => void): void {
  // What git itself runs (`-c alias.x='!…'`, `rebase --exec`) is read as commands too.
  for (const script of gitScripts(args).scripts) readNested(script, where, out, depth)
  let at = 0
  /** The folder git works in, `-C` after `-C`; undefined once one is only known as it runs. */
  let tree: string | undefined = '.'
  let workTree: string | undefined
  let known = true
  for (; at < args.length; at += 1) {
    const arg = args[at] as string
    if (!arg.startsWith('-')) break
    const value = arg === '-C' || arg === '--work-tree' ? args[at + 1] : undefined
    if (value !== undefined && unknown(at + 1)) known = false
    if (arg === '-C') tree = tree === undefined ? undefined : join(tree, value ?? '.')
    else if (arg === '--work-tree') workTree = value
    else if (arg.startsWith('--work-tree=')) workTree = arg.slice('--work-tree='.length)
    if (arg === '-C' || arg === '--work-tree' || arg === '-c' || arg === '--git-dir' || arg === '--namespace' || arg === '--exec-path' || arg === '--config-env') at += 1
  }
  const sub = args[at]
  const rest = args.slice(at + 1)
  const base = at + 1
  const inTree = (path: string): Named => ({ path: join(tree, path) ?? path, cwd: where.cwd })
  if (sub === 'clone') {
    const { values, flags, plain } = options(rest, 'boujc', [...CLONE_VALUES])
    const repo = plain[0]
    if (repo === undefined) return
    const dir = plain[1]
    if (!known || (dir !== undefined && unknown(base + dir.at))) return dynamicPath()
    const target = dir?.value ?? lastPart(repo.value).replace(/\.git$/i, '')
    if (unknown(base + repo.at)) {
      if (dir === undefined) return dynamicPath()
      return writes({ kind: 'unknown', to: inTree(target), what: 'a repository only known as it runs', deep: true })
    }
    const ref = valuesOf(values, '-b', '--branch', '--revision')[0]?.value
    const submodules = [...flags, ...values.keys()].some(flag => flag === '--recursive' || flag.startsWith('--recurse-submodules'))
    return writes({ kind: 'clone', to: inTree(target), url: repo.value, ...(ref === undefined ? {} : { ref }), submodules })
  }
  if (sub === 'worktree' && rest[0] === 'add') {
    // `-b`, `-B` and `--reason` take a value: the path is the first plain word after them.
    const path = options(rest.slice(1), 'bB', ['--reason', '--orphan']).plain[0]
    if (path === undefined) return
    if (!known || unknown(base + 1 + path.at)) return dynamicPath()
    return writes({ kind: 'unknown', to: inTree(path.value), what: 'a checkout git makes', deep: true })
  }
  if (sub === 'archive') {
    const output = rest.find(arg => arg.startsWith('--output='))?.slice('--output='.length) ?? (rest.includes('-o') ? rest[rest.indexOf('-o') + 1] : undefined)
    if (output === undefined) return
    if (!known) return dynamicPath()
    return writes({ kind: 'unknown', to: inTree(output), what: 'an archive git makes' })
  }
  const changes =
    (sub !== undefined && GIT_CHANGES.has(sub)) ||
    (sub === 'reset' && rest.some(arg => arg === '--hard' || arg === '--merge' || arg === '--keep')) ||
    (sub === 'stash' && !['list', 'show', 'create', 'store'].includes(rest[0] ?? '')) ||
    (sub === 'submodule' && ['update', 'add', 'init', 'sync', 'absorbgitdirs'].includes(rest[0] ?? ''))
  if (!changes) return
  if (!known) return dynamicPath()
  writes({ kind: 'unknown', to: inTree(workTree ?? '.'), what: `git ${sub} changes the files there`, deep: true })
}

/** The files curl writes: `-o`, `-O` (named after the address) and the other files it can be told to write. */
function readCurl(args: readonly string[], unknown: (at: number) => boolean, named: (path: string) => Named, writes: Writes, dynamicPath: () => void): void {
  const { values, flags, plain } = options(args, CURL_VALUES, [...CURL_FILES, '--output-dir', '--data', '--header', '--request', '--user', '--user-agent', '--referer', '--cookie', '--form', '--upload-file', '--proxy', '--write-out', '--config', '--max-time', '--range', '--url'])
  const dir = valuesOf(values, '--output-dir')[0]
  if (dir !== undefined && unknown(dir.at)) return dynamicPath()
  const where = (file: string): Named => named(dir === undefined || /^(?:\/|~)/.test(file) ? file : `${dir.value.replace(/\/+$/, '')}/${file}`)
  for (const file of valuesOf(values, '-o', '--output')) {
    if (file.value === '-' || file.value === '/dev/null') continue
    if (unknown(file.at)) dynamicPath()
    else writes({ kind: 'unknown', to: where(file.value), what: 'a download' })
  }
  for (const file of valuesOf(values, '-c', '-D', ...[...CURL_FILES].filter(item => item !== '--output'))) {
    if (file.value === '-' || file.value === '/dev/null') continue
    if (unknown(file.at)) dynamicPath()
    else writes({ kind: 'unknown', to: named(file.value), what: 'a file curl keeps' })
  }
  if (!(flags.has('-O') || flags.has('--remote-name') || flags.has('--remote-name-all'))) return
  // `-J` takes the name the server sends: only the folder is known.
  if (flags.has('-J') || flags.has('--remote-header-name')) return writes({ kind: 'unknown', to: named(dir?.value ?? '.'), what: 'a download named by the server', deep: true })
  for (const url of [...plain, ...valuesOf(values, '--url')]) {
    if (unknown(url.at)) dynamicPath()
    else writes({ kind: 'unknown', to: where(lastPart(url.value.replace(/[?#].*$/, '')) || 'index.html'), what: 'a download' })
  }
}

/** The files wget writes: `-O`, or one named after each address in the folder `-P` names, and its log. */
function readWget(args: readonly string[], unknown: (at: number) => boolean, named: (path: string) => Named, writes: Writes, dynamicPath: () => void): void {
  const { values, flags, plain } = options(args, WGET_VALUES, ['--output-document', '--directory-prefix', '--output-file', '--append-output'])
  for (const file of valuesOf(values, '-o', '-a', '--output-file', '--append-output')) {
    if (unknown(file.at)) dynamicPath()
    else writes({ kind: 'unknown', to: named(file.value), what: "wget's log" })
  }
  const document = valuesOf(values, '-O', '--output-document')[0]
  if (document !== undefined) {
    if (document.value === '-') return
    if (unknown(document.at)) return dynamicPath()
    return writes({ kind: 'unknown', to: named(document.value), what: 'a download' })
  }
  const dir = valuesOf(values, '-P', '--directory-prefix')[0]
  if (dir !== undefined && unknown(dir.at)) return dynamicPath()
  const folder = dir?.value ?? '.'
  if (flags.has('-r') || flags.has('--recursive') || flags.has('-m') || flags.has('--mirror')) return writes({ kind: 'unknown', to: named(folder), what: 'the pages wget fetches', deep: true })
  for (const url of plain) {
    if (unknown(url.at)) dynamicPath()
    else writes({ kind: 'unknown', to: named(`${folder.replace(/\/+$/, '')}/${lastPart(url.value.replace(/[?#].*$/, '')) || 'index.html'}`), what: 'a download' })
  }
}

/** Where an archive is unpacked: `unzip -d`, `tar -C`, `7z x -o`, or the current folder. */
function readArchive(program: string, args: readonly string[], unknown: (at: number) => boolean, named: (path: string) => Named, writes: Writes, dynamicPath: () => void): void {
  let folder: string | undefined = '.'
  let folderAt = -1
  if (program === 'unzip') {
    // Listing, testing or printing to the screen writes nothing.
    if (args.some(arg => /^-[A-Za-z]*[pltvZz]/.test(arg))) return
    folderAt = args.indexOf('-d') === -1 ? -1 : args.indexOf('-d') + 1
    const joined = args.findIndex(arg => /^-d.+/.test(arg))
    if (folderAt !== -1) folder = args[folderAt]
    else if (joined !== -1) {
      folder = (args[joined] as string).slice(2)
      folderAt = joined
    }
  } else if (/^7z/.test(program)) {
    if (args[0] !== 'x' && args[0] !== 'e') return
    folderAt = args.findIndex(arg => arg.startsWith('-o'))
    if (folderAt !== -1) folder = (args[folderAt] as string).slice(2)
  } else {
    // tar: extracting, whether the mode is bundled first (`xzf`), given as a short option, or as --extract.
    const extracts = args.some((arg, at) => (at === 0 && /^[A-Za-z]*x[A-Za-z]*$/.test(arg)) || /^-[A-Za-wyz]*x/.test(arg) || arg === '--extract' || arg === '--get')
    if (!extracts) return
    const short = args.indexOf('-C')
    const long = args.findIndex(arg => arg === '--directory' || arg.startsWith('--directory='))
    const joined = args.findIndex(arg => /^-C.+/.test(arg))
    if (short !== -1) {
      folderAt = short + 1
      folder = args[folderAt]
    } else if (long !== -1) {
      const arg = args[long] as string
      folderAt = arg.includes('=') ? long : long + 1
      folder = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[long + 1]
    } else if (joined !== -1) {
      folderAt = joined
      folder = (args[joined] as string).slice(2)
    }
  }
  if (folder === undefined) return
  if (folderAt !== -1 && unknown(folderAt)) return dynamicPath()
  writes({ kind: 'unknown', to: named(folder), what: `the files ${program} unpacks`, deep: true })
}

/** sed's scripts: given with `-e` (apart, attached as `-e'…'` or bundled as `-ne'…'`), `--expression`, or as the first plain word. */
function sedScripts(args: readonly string[]): string[] {
  const scripts: string[] = []
  let given = false
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] as string
    const attached = /^-[A-Za-z]*e(.+)$/s.exec(arg)?.[1] ?? (arg.startsWith('--expression=') ? arg.slice('--expression='.length) : undefined)
    if (attached !== undefined) {
      scripts.push(attached)
      given = true
    } else if (/^-[A-Za-z]*e$/.test(arg) || arg === '--expression') {
      scripts.push(args[at + 1] ?? '')
      given = true
      at += 1
    }
  }
  const first = args.find((arg, at) => !arg.startsWith('-') && !/^-[A-Za-z]*e$|^--expression$/.test(args[at - 1] ?? ''))
  if (!given && first !== undefined) scripts.push(first)
  return scripts
}

/** `sed -i`: each file it edits in place; and a script whose `w` command writes a file, or whose `e` runs one. */
function readSedInPlace(args: readonly string[], unknown: (at: number) => boolean, named: (path: string) => Named, writes: Writes, dynamicPath: () => void, out: ShellWrites, own: Own): void {
  if (sedScripts(args).some(script => /(?:^|[/;}\d$])\s*[wWe](?:\s+\S|$)/m.test(script)) || args.some(arg => /^-[A-Za-z]*f/.test(arg) || arg.startsWith('--file'))) {
    out.unseen.push({ reason: 'sed runs a script that may write files', ...own })
  }
  const inPlace = args.findIndex(arg => /^-[A-Za-z]*i/.test(arg) || arg.startsWith('--in-place'))
  if (inPlace === -1) return
  const flag = args[inPlace] as string
  // A bare -i on macOS takes the next word, often '', as the backup suffix; otherwise the suffix is attached.
  // A next word only known as it runs may be that suffix too.
  const next = args[inPlace + 1]
  const separate = flag === '-i' && next !== undefined && (next === '' || next.startsWith('.') || unknown(inPlace + 1)) ? inPlace + 1 : undefined
  const suffix = separate !== undefined ? (args[separate] as string) : flag.startsWith('--in-place') ? flag.slice('--in-place'.length).replace(/^=/, '') : flag.slice(flag.indexOf('i') + 1)
  const suffixUnknown = unknown(separate ?? inPlace) && isDynamic(suffix)
  let script = !args.some(arg => /^-[A-Za-z]*[ef]/.test(arg) || arg.startsWith('--expression') || arg.startsWith('--file'))
  args.forEach((arg, at) => {
    if (at === separate) return
    if (arg.startsWith('-')) return
    // The value of -e or -f is a script, not a file.
    const before = args[at - 1] ?? ''
    if (/^-[A-Za-z]*[ef]$/.test(before) || before === '--expression' || before === '--file') return
    if (script) {
      script = false
      return
    }
    if (unknown(at)) return dynamicPath()
    writes({ kind: 'unknown', to: named(arg), what: 'an edit sed makes', edit: true })
    // The backup of the file as it was is a copy of it, which a suffix can put anywhere (GNU sed's `-i'old/*'`).
    if (suffixUnknown) dynamicPath()
    else for (const backup of sedBackups(arg, suffix)) writes({ kind: 'unknown', to: named(backup), what: 'the copy sed keeps of the file it edits' })
  })
}

/**
 * Where sed keeps the file it edits in place, given the backup suffix: none
 * for an empty one. GNU sed puts each `*` the file's name and, when that
 * names no folder, keeps it beside the file; BSD sed adds the suffix as it is.
 * Both are given, so neither sed's choice is missed.
 */
function sedBackups(path: string, suffix: string): string[] {
  if (suffix === '') return []
  if (!suffix.includes('*')) return [`${path}${suffix}`]
  const slash = path.lastIndexOf('/')
  const name = suffix.split('*').join(path.slice(slash + 1))
  return [name.includes('/') ? name : `${path.slice(0, slash + 1)}${name}`, `${path}${suffix}`]
}

/** `find … -exec cmd {} ;`: the command it runs for each file, whose paths come from what it finds; and the files `-fprint` writes. */
function readFind(args: readonly string[], where: Where, out: ShellWrites, depth: number, writes: Writes, named: (path: string) => Named): void {
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] as string
    if (/^-(?:exec|execdir|ok|okdir)$/.test(arg)) {
      const end = args.findIndex((item, place) => place > at && (item === ';' || item === '+'))
      const words = args.slice(at + 1, end === -1 ? args.length : end)
      readCommand({ words }, where, out, depth + 1, true)
      at = end === -1 ? args.length : end
    } else if (/^-(?:fprint0?|fprintf|fls)$/.test(arg) && args[at + 1] !== undefined) {
      writes({ kind: 'unknown', to: named(args[at + 1] as string), what: 'the list find writes' })
      at += 1
    }
  }
}

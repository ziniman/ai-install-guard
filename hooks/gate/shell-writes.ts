// What a shell command Claude is about to run writes, read from its text
// alone: the files its redirections write, and those cp, mv, install, ln,
// rsync, ditto, git, curl, wget, unzip, tar, tee, sed -i, perl -i, ruby -i
// and dd make. A program the guard does not know is judged by the paths it is
// given; what it writes on its own, unnamed, is not seen. Nothing here runs
// anything or touches the disk.

import { CLAUDE, INTERPRETERS, QUIET, SHELLS, gitScripts, isDynamic, programAt, programName, splitShell, type ShellCommand } from './requests'

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
   */
  | { kind: 'unknown'; to: Named; what: string; deep?: boolean }

/** A part of the command only known as it runs; `text` is what to look for Claude's folder in, the whole command when unset. */
export type Unseen = { reason: string; text?: string }

export type ShellWrites = { writes: ShellWrite[]; unseen: Unseen[] }

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

/** The folder commands run in as the script goes on; `cd` changes it for the commands after. */
type Where = { cwd: string | undefined }

function readScript(text: string, where: Where, out: ShellWrites, depth: number): void {
  if (depth > MAX_DEPTH) {
    out.unseen.push({ reason: 'commands are nested too deep to read' })
    return
  }
  for (const command of splitShell(text).commands) readCommand(command, where, out, depth, false)
}

/** A script that runs in a shell of its own: a folder it changes to stays its own. */
function readNested(text: string, where: Where, out: ShellWrites, depth: number): void {
  readScript(text, { cwd: where.cwd }, out, depth + 1)
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
  for (const script of placed.scripts) readNested(script, where, out, depth)
  const fills = fromInput || placed.fromInput
  const word = words[placed.index]
  const program = word === undefined ? '' : programName(word)
  const args = words.slice(placed.index + 1)
  /** Whether the argument at `at` is only known as the command runs; a home folder's `~` is known. */
  const unknown = (at: number): boolean => expands.has(placed.index + 1 + at) && isDynamic(args[at] as string)
  const named = (path: string): Named => ({ path, cwd: where.cwd })
  const ownText = [...words, command.input ?? ''].join(' ')

  for (const target of command.targets ?? []) {
    if (target.expands && isDynamic(target.path)) {
      out.unseen.push({ reason: 'it writes to a file only known as it runs' })
      continue
    }
    out.writes.push(redirected(command, program, args, unknown, named(target.path), target.append, where))
  }
  if (word === undefined) return
  if (expands.has(placed.index) && isDynamic(word)) {
    out.unseen.push({ reason: 'it runs a program only known as it runs' })
    return
  }
  const writes = (write: ShellWrite): void => {
    // A write whose paths come from input could be anywhere.
    if (fills) out.unseen.push({ reason: `${program} is given paths from its input, which the guard does not see` })
    else out.writes.push(write)
  }
  const dynamicPath = (): void => {
    out.unseen.push({ reason: `${program} writes to a path only known as it runs` })
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
      else readNested(script, where, out, depth)
      return
    }
    if (command.input !== undefined) return readNested(command.input, where, out, depth)
    // A script file is code already on disk, judged as any program is, by the paths it is given.
    const file = args.findIndex(arg => !arg.startsWith('-'))
    if (file !== -1) return pathsGiven(lastPart(args[file] as string), args.slice(file + 1), at => unknown(file + 1 + at), named, writes)
    out.unseen.push({ reason: `${program} runs a script from its input, which the guard does not read`, text: ownText })
    return
  }
  if (program === 'source' || program === '.') {
    if (args[0] !== undefined) pathsGiven(lastPart(args[0]), args.slice(1), at => unknown(1 + at), named, writes)
    return
  }
  if (program === 'eval') {
    readNested(args.join(' '), where, out, depth)
    return
  }
  const language = program.replace(/\.exe$/, '').replace(/^(python[23]?)\.\d+$/, '$1')
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
      if (!known) out.unseen.push({ reason: `${program} runs code from its input, which the guard does not read`, text: ownText })
      else if (filledIn) out.unseen.push({ reason: `${program} runs code only known as it runs` })
      else if (mayChange(ownText)) out.unseen.push({ reason: `${program} runs code that may write files or run programs`, text: ownText })
      // Perl or Ruby told to edit files in place (`-i`) writes the files named after its code.
      else if (language === 'perl' || language === 'ruby') readInPlace(language, args, unknown, where, writes, dynamicPath, fills, out, ownText, command.input)
      return
    }
    // A script file or a module (`python3 -m pip …`) is code already on disk: judged by the paths it is given, not by where it is.
    const from = module !== -1 ? module + 2 : file + 1
    pathsGiven(module !== -1 ? (args[module + 1] ?? program) : lastPart(args[file] as string), args.slice(from), at => unknown(from + at), named, writes)
    return
  }
  if (program === 'find') {
    readFind(args, where, out, depth, writes, named)
    return
  }
  // awk's program can write a file (`print > "f"`) or run a command; one that might is code the guard does not read.
  if (/^[gmn]?awk$/.test(program)) {
    const fromFile = args.some(arg => arg === '-f' || arg.startsWith('--file'))
    const text = args.find(arg => !arg.startsWith('-'))
    if (fromFile || (text !== undefined && /[>|]|\bsystem\s*\(|\bgetline\b/.test(text))) out.unseen.push({ reason: `${program} runs a program that may write files`, text: ownText })
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
    readSedInPlace(args, unknown, named, writes, dynamicPath, out, ownText)
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
  pathsGiven(program, args, unknown, named, writes)
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
  /\bsub\x70rocess|\bchild_\x70rocess|\bs\x70awn|\bexe\x63|\bsyste\x6d\b|\x70open|\bfork\s*\(|\bOpen3|\bProcessBuilder|\bgetRuntime|\bshell_exe\x63|\bpassthru|\bproc_open|\bdo shell s\x63ript|\bDeno\.(?:run|Command)|\bStart-Process|\bInvoke-|\biex\b|\bSet-Content|\bAdd-Content|\bOut-File|\bNew-Item|\bRemove-Item|\bCopy-Item|\bMove-Item|\bRename-Item/i,
  /\b(?:instance_|class_|module_)?eva\x6c\b|\bFunction\s*\(|__im\x70ort__|\bim\x70ortlib|\bgetattr|\bsetattr|\bglobals\s*\(|\bcom\x70ile\s*\(|\bmarshal|\bpickle|\bbase64|\bb\d\ddecode|\ba85decode|\bunhexlify|\bfromhex|\bcodecs|\\x[0-9a-fA-F]{2}|\bchr\s*\(|\bfromCharCode|\batob\b/i,
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
 * it can be part of an expression, Perl's `do FILE`, Ruby's `load`), or a
 * hand on the list of files it edits or the folder they are named in: the
 * list by name (`ARGV`, Ruby's `$*` and `ARGF`), Perl's symbolic references
 * and symbol table (`@{"AR"."GV"}`, `$::{…}`), Ruby's calls by name (`send`,
 * `const_get`), and `chdir`. Read over the code alone, so words in a
 * replacement are not taken for a statement.
 */
const IN_PLACE_LOADS = {
  perl: /(?:^|[;{}])\s*(?:use|no)\b|\brequire\b|\bdo\s*['"$]/m,
  ruby: /\b(?:require(?:_relative)?|load|autoload)\b/,
} as const
const IN_PLACE_CHOOSES = {
  perl: /\bARGV\b|[@*$%&]\s*\{\s*[^}\w\s]|::\s*\{|\bchdir\b/,
  ruby: /\bARGV\b|\$\*|\bARGF\b|\bchdir\b|\bconst_get\b|\.\s*(?:public_)?send\b|\b__send__\b|\bsend\s*\(|\bbinding\b/,
} as const

/**
 * `perl -i` and `ruby -i`: each file named after the code is edited in
 * place, and with a suffix (`-i.bak`) a copy of it is kept as well, each a
 * write of content only known as it runs. With no file, it edits its input
 * and writes nothing. A module loaded beside it (`-M`, `-m`, `-d:`, `-r`, or
 * by name in the code) is code the guard does not read, and so is code that
 * chooses which files it edits.
 */
function readInPlace(language: 'perl' | 'ruby', args: readonly string[], unknown: (at: number) => boolean, where: Where, writes: Writes, dynamicPath: () => void, fills: boolean, out: ShellWrites, ownText: string, input: string | undefined): void {
  const spec = SCRIPT_SWITCHES[language]
  let suffix: Value | undefined
  /** The code given inline, each `-e` apart. */
  const code: string[] = []
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
      if (spec.code.includes(name)) code.push(value.value)
      else if (name === 'i') suffix = value
      else if (language === 'perl' ? name === 'M' || name === 'm' : name === 'r') module = true
      else if (name === 'x' ? rest !== '' : language === 'ruby' && (name === 'C' || name === 'X')) folder = value
      at = value.at
      break
    }
  }
  if (suffix === undefined) return
  // With no code inline, a here-document is the script.
  const source = code.length > 0 ? code.join('\n') : (input ?? '')
  if (module || IN_PLACE_LOADS[language].test(source)) {
    out.unseen.push({ reason: `${language} loads a module beside the files it edits in place, which the guard does not read`, text: ownText })
    return
  }
  if (IN_PLACE_CHOOSES[language].test(source)) {
    out.unseen.push({ reason: `${language} edits files in place that its code chooses as it runs`, text: ownText })
    return
  }
  if (fills) {
    out.unseen.push({ reason: `${language} is given paths from its input, which the guard does not see` })
    return
  }
  const cwd = folder === undefined ? where.cwd : unknown(folder.at) ? undefined : join(where.cwd, folder.value)
  // With no code given inline, the first word left names the script.
  for (let file = code.length > 0 ? at : at + 1; file < args.length; file += 1) {
    const path = args[file] as string
    if (path === '-') continue
    if (unknown(file)) {
      dynamicPath()
      continue
    }
    writes({ kind: 'unknown', to: { path, cwd }, what: `an edit ${language} makes` })
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
      writes({ kind: 'unknown', to: named(path), what: `what ${program} writes when given this path` })
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
function readSedInPlace(args: readonly string[], unknown: (at: number) => boolean, named: (path: string) => Named, writes: Writes, dynamicPath: () => void, out: ShellWrites, ownText: string): void {
  if (sedScripts(args).some(script => /(?:^|[/;}\d$])\s*[wWe](?:\s+\S|$)/m.test(script)) || args.some(arg => /^-[A-Za-z]*f/.test(arg) || arg.startsWith('--file'))) {
    out.unseen.push({ reason: 'sed runs a script that may write files', text: ownText })
  }
  const inPlace = args.findIndex(arg => /^-[A-Za-z]*i/.test(arg) || arg.startsWith('--in-place'))
  if (inPlace === -1) return
  let script = !args.some(arg => /^-[A-Za-z]*[ef]/.test(arg) || arg.startsWith('--expression') || arg.startsWith('--file'))
  args.forEach((arg, at) => {
    // A bare -i on macOS takes the next word, often '', as the backup suffix.
    if (at === inPlace + 1 && args[inPlace] === '-i' && (arg === '' || arg.startsWith('.'))) return
    if (arg.startsWith('-')) return
    // The value of -e or -f is a script, not a file.
    const before = args[at - 1] ?? ''
    if (/^-[A-Za-z]*[ef]$/.test(before) || before === '--expression' || before === '--file') return
    if (script) {
      script = false
      return
    }
    if (unknown(at)) dynamicPath()
    else writes({ kind: 'unknown', to: named(arg), what: 'an edit sed makes' })
  })
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

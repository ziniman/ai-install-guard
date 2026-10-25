import type { InventoryFile, ScannedTree } from '../inventory'
import { magicOf } from './magic'
import { basename, dirname, extension, findAll, joinPath, lineOf, spanKinds, type Match } from './text'

/**
 * What a file is to Claude Code, which decides how much a finding in it
 * matters. A file anything loads or runs (a hooks module, a script a hook or
 * skill names) counts in full; a test or doc file nothing refers to is only
 * reported.
 */
export type FileRole =
  | 'module'
  | 'hook-script'
  | 'server'
  | 'prompt-script'
  | 'hooks-config'
  | 'mcp-config'
  | 'manifest'
  | 'prompt'
  | 'bin'
  | 'code'
  | 'test'
  | 'doc'
  | 'other'

/** Earlier wins when a file has several roles. */
const ROLE_ORDER: readonly FileRole[] = [
  'module',
  'hook-script',
  'server',
  'prompt-script',
  'hooks-config',
  'mcp-config',
  'manifest',
  'prompt',
  'bin',
  'code',
  'test',
  'doc',
  'other',
]

export type CandidateKind = 'plugin' | 'skill' | 'marketplace' | 'folder'

export type ModuleUse = { name: string; file: string; line: number; detail?: string }

export type ModuleInfo = {
  /** The module hooks.json names, resolved from the root. */
  entry: string
  /** As hooks.json spells it (`./register.tsx`), which is how the validator names it. */
  declaredAs: string
  /** It and every plugin file it imports. */
  files: string[]
  events: ModuleUse[]
  calls: ModuleUse[]
  envNames: ModuleUse[]
  urls: ModuleUse[]
}

export type HookCommand = {
  file: string
  line?: number
  event: string
  matcher?: string
  type: string
  command: string
}

export type McpServer = {
  name: string
  file: string
  line?: number
  type?: string
  command?: string
  args: string[]
  url?: string
  env: Record<string, string>
  headers: Record<string, string>
}

export type ScanContext = {
  tree: ScannedTree
  files: InventoryFile[]
  kind: CandidateKind
  /** The parsed `.claude-plugin/plugin.json`, when there is one and it parses. */
  manifest?: Record<string, unknown>
  manifestError?: string
  readme?: { path: string; text: string }
  modules: ModuleInfo[]
  hookCommands: HookCommand[]
  /** Every file a classic hook command names, whatever role it ends up with. */
  hookScripts: Set<string>
  /**
   * The interpreter a hook or server runs a file with (`sh hooks/x.js` runs
   * it as shell), which decides how it is read whatever its extension says.
   */
  interpreters: Map<string, 'js' | 'python' | 'shell' | 'other'>
  /** The candidate's own files each live code file loads, as written in it. */
  imports: ReadonlyMap<string, readonly string[]>
  hookConfigErrors: { file: string; error: string }[]
  mcpServers: McpServer[]
  /** Markdown the model reads: skills, commands, agents, output styles. */
  prompts: string[]
  text: (path: string) => string | undefined
  roleOf: (path: string) => FileRole
}

const decoder = new TextDecoder('utf-8')

const CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'py', 'sh', 'bash', 'zsh', 'fish', 'rb', 'pl',
  'php', 'ps1', 'psm1', 'bat', 'cmd', 'go', 'rs', 'java', 'kt', 'swift', 'lua', 'applescript', 'vbs',
])

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown'])

const PROMPT_DIRS = ['skills', 'commands', 'agents', 'output-styles']

/** Plain-text files a prompt may tell the model to read, besides Markdown. */
const PROMPT_TEXT = /\.(?:txt|text|rst|prompt)$/i

const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', 'fixtures', '__fixtures__', 'testdata', 'spec', 'specs', 'e2e', 'test-support', 'testing', 'test-utils', 'test-helpers', '__mocks__', 'mocks'])

const DOC_NAMES = /^(readme|changelog|changes|history|license|licence|copying|notice|contributing|code_of_conduct|security|authors)(\..*)?$/i

export function isCodeFile(path: string, text?: string): boolean {
  return CODE_EXTENSIONS.has(extension(path)) || (text !== undefined && text.startsWith('#!'))
}

export function isMarkdown(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extension(path))
}

export function isTestPath(path: string): boolean {
  const segments = path.split('/')
  const name = basename(path)
  return (
    segments.slice(0, -1).some(segment => TEST_SEGMENTS.has(segment.toLowerCase())) ||
    /\.(test|spec)\.[a-z0-9]+$/i.test(name) ||
    /^test_.*\.py$/i.test(name) ||
    /_test\.(go|py)$/i.test(name)
  )
}

/** Repository files Claude Code never loads: CI configuration and git and editor dotfiles. */
const REPO_FILES = /^(?:\.github|\.gitlab|\.circleci|\.husky|\.vscode|\.idea|\.devcontainer)\/|^(?:\.gitignore|\.gitattributes|\.gitmodules|\.npmignore|\.editorconfig|\.prettierrc[\w.]*|\.eslintrc[\w.]*|\.gitlab-ci\.yml|\.travis\.yml|renovate\.json|dependabot\.yml)$/

export function isDocPath(path: string): boolean {
  const first = path.split('/')[0]?.toLowerCase()
  // A doc name on a code file (history.js, security.ts) is still code.
  const isDocName = DOC_NAMES.test(basename(path)) && !CODE_EXTENSIONS.has(extension(path))
  return isDocName || first === 'docs' || first === 'doc' || REPO_FILES.test(path)
}

export function buildContext(tree: ScannedTree): ScanContext {
  const files = tree.inventory.entries.filter((entry): entry is InventoryFile => entry.kind === 'file')
  const paths = new Set(files.map(file => file.path))
  // An in-folder link stands for the file it lands on: Claude Code follows it.
  const aliases = new Map<string, string>()
  const dirAliases: { link: string; target: string }[] = []
  const dirs = new Set(tree.inventory.entries.filter(entry => entry.kind === 'dir').map(entry => entry.path))
  for (const entry of tree.inventory.entries) {
    if (entry.kind !== 'link' || !entry.isInside || entry.landsAt === undefined) continue
    if (paths.has(entry.landsAt)) aliases.set(entry.path, entry.landsAt)
    else if (dirs.has(entry.landsAt)) dirAliases.push({ link: entry.path, target: entry.landsAt })
  }
  /** The file a path reaches, through a link to a file or a link to a folder on the way. */
  const realOf = (path: string): string | undefined => {
    if (paths.has(path)) return path
    const viaFile = aliases.get(path)
    if (viaFile !== undefined) return viaFile
    for (const { link, target } of dirAliases) {
      if (path.startsWith(`${link}/`)) {
        const real = `${target}/${path.slice(link.length + 1)}`
        if (paths.has(real)) return real
      }
    }
    return undefined
  }
  const texts = new Map<string, string>()
  const byPath = new Map(files.map(file => [file.path, file]))
  // Any file that is not a known binary format is read as text, NUL bytes
  // and all: a NUL in a comment must not hide the code after it. Paths are
  // read through in-folder links, as Claude Code reads them.
  const text = (asked: string): string | undefined => {
    const path = realOf(asked) ?? asked
    const cached = texts.get(path)
    if (cached !== undefined) return cached
    const file = byPath.get(path)
    const bytes = tree.contents.get(path)
    if (file === undefined || bytes === undefined) return undefined
    if (!file.isText && magicOf(bytes) !== undefined) return undefined
    const decoded = file.isText ? decoder.decode(bytes) : decoder.decode(bytes).replace(/\u0000/g, ' ')
    texts.set(path, decoded)
    return decoded
  }

  const roles = new Map<string, FileRole>()
  const assign = (path: string, role: FileRole): void => {
    const current = roles.get(path)
    if (current === undefined || ROLE_ORDER.indexOf(role) < ROLE_ORDER.indexOf(current)) {
      roles.set(path, role)
    }
  }

  const manifestPath = '.claude-plugin/plugin.json'
  let manifest: Record<string, unknown> | undefined
  let manifestError: string | undefined
  const realManifest = realOf(manifestPath)
  if (realManifest !== undefined) {
    assign(realManifest, 'manifest')
    const parsed = parseJson(text(realManifest))
    if (parsed.ok && isRecord(parsed.value)) manifest = parsed.value
    else manifestError = parsed.ok ? 'plugin.json is not a JSON object' : parsed.error
  }
  if (paths.has('.claude-plugin/marketplace.json')) assign('.claude-plugin/marketplace.json', 'manifest')

  const hasPluginLayout =
    realManifest !== undefined ||
    realOf('hooks/hooks.json') !== undefined ||
    realOf('.mcp.json') !== undefined ||
    files.some(file => PROMPT_DIRS.some(dir => file.path.startsWith(`${dir}/`)))
  const kind: CandidateKind = realOf('SKILL.md') !== undefined
    ? 'skill'
    : hasPluginLayout
      ? 'plugin'
      : paths.has('.claude-plugin/marketplace.json')
        ? 'marketplace'
        : 'folder'

  // Markdown the model reads.
  const promptRoots = kind === 'skill' ? [''] : [...PROMPT_DIRS, ...manifestPaths(manifest, ['commands', 'agents', 'skills', 'outputStyles'])]
  // Claude Code loads these by place, whatever they are named: a skill in
  // skills/testing/ is still a skill. Only a standalone skill's own README
  // and similar files are left out.
  // A folder link under a prompt root makes its target's files prompts too.
  const roots = [...promptRoots]
  for (const { link, target } of dirAliases) {
    if (promptRoots.some(root => root !== '' && (link === root || link.startsWith(`${root}/`)))) roots.push(target)
  }
  const underRoot = (path: string): boolean =>
    roots.some(root => (root === '' ? !DOC_NAMES.test(basename(path)) || path.includes('/') : path === root || path.startsWith(`${root}/`)))
  const prompts = files.map(file => file.path).filter(path => isMarkdown(path) && underRoot(path))
  // A markdown link under a prompt root (skills/x/SKILL.md -> ../../docs/x.md)
  // makes the file it lands on a prompt too.
  for (const [link, real] of aliases) {
    if (isMarkdown(link) && underRoot(link) && !prompts.includes(real)) prompts.push(real)
  }
  for (const path of prompts) assign(path, 'prompt')

  // Classic hooks and hooks modules.
  const hookCommands: HookCommand[] = []
  const hookConfigErrors: { file: string; error: string }[] = []
  const moduleEntries: { path: string; declaredAs: string }[] = []
  const hookFiles = new Set<string>(['hooks/hooks.json', ...manifestPaths(manifest, ['hooks'])])
  for (const file of hookFiles) {
    const real = realOf(file)
    if (real === undefined) continue
    assign(real, 'hooks-config')
    const parsed = parseJson(text(real))
    if (!parsed.ok || !isRecord(parsed.value)) {
      hookConfigErrors.push({ file: real, error: parsed.ok ? 'not a JSON object' : parsed.error })
      continue
    }
    collectHookCommands(parsed.value, real, text(real) ?? '', hookCommands)
    for (const entry of stringList(parsed.value.modules)) {
      // Module paths are relative to where Claude Code reads hooks.json from.
      const resolved = joinPath(dirname(file), entry)
      if (resolved !== undefined) moduleEntries.push({ path: resolved, declaredAs: entry })
    }
  }
  if (manifest !== undefined && isRecord(manifest.hooks) && realManifest !== undefined) {
    // Inline hooks: `{ "hooks": { Event: [...] } }` or the event map itself,
    // and hooks modules named there (relative to the plugin root).
    const inline = manifest.hooks
    const events = isRecord(inline.hooks) ? inline : { hooks: Object.fromEntries(Object.entries(inline).filter(([key]) => key !== 'modules' && key !== 'description')) }
    collectHookCommands(events, realManifest, text(realManifest) ?? '', hookCommands)
    for (const entry of stringList(inline.modules)) {
      const resolved = joinPath('', entry)
      if (resolved !== undefined) moduleEntries.push({ path: resolved, declaredAs: entry })
    }
  }

  const modules = moduleEntries.map(entry => readModule(entry.path, entry.declaredAs, realOf, text))
  for (const info of modules) for (const file of info.files) assign(file, 'module')

  // MCP servers.
  const mcpServers: McpServer[] = []
  const mcpFiles = new Set<string>(['.mcp.json', ...manifestPaths(manifest, ['mcpServers'])])
  for (const file of mcpFiles) {
    const real = realOf(file)
    if (real === undefined) continue
    assign(real, 'mcp-config')
    const parsed = parseJson(text(real))
    if (parsed.ok && isRecord(parsed.value)) collectMcpServers(parsed.value, real, text(real) ?? '', mcpServers)
  }
  if (manifest !== undefined && isRecord(manifest.mcpServers) && realManifest !== undefined) {
    collectMcpServers({ mcpServers: manifest.mcpServers }, realManifest, text(realManifest) ?? '', mcpServers)
  }

  // Files (and links) that hooks, servers or prompts name are run, not just shipped.
  const linkPaths = tree.inventory.entries.filter(entry => entry.kind === 'link').map(entry => entry.path)
  // `hooks//run.sh`, `"hooks/run.sh"` and `cd hooks && sh run.sh` all name
  // hooks/run.sh: paths are compared with quotes and doubled slashes
  // removed, and a bare file name counts when one file has it.
  const nameIndexes = new Map<string, { normalized: string; words: Set<string> }>()
  const indexOf = (haystack: string): { normalized: string; words: Set<string> } => {
    const cached = nameIndexes.get(haystack)
    if (cached !== undefined) return cached
    const normalized = haystack.replace(/["'`]/g, ' ').replace(/\/{2,}/g, '/')
    const words = new Set(normalized.split(/[\s;&|()<>=,]+/).map(word => word.split('/').pop() ?? word))
    const index = { normalized, words }
    nameIndexes.set(haystack, index)
    return index
  }
  const namedIn = (haystack: string, path: string): boolean => {
    const { normalized, words } = indexOf(haystack)
    // The full path, as a whole: openapi.md does not name api.md.
    for (let at = normalized.indexOf(path); at !== -1; at = normalized.indexOf(path, at + 1)) {
      const before = normalized[at - 1]
      const after = normalized[at + path.length]
      if ((before === undefined || !/[\w.-]/.test(before)) && (after === undefined || !/[\w-]/.test(after))) return true
    }
    return words.has(basename(path)) && nameCount.get(basename(path)) === 1
  }
  const referenced = (haystack: string, role: FileRole, skipMarkdown: boolean): void => {
    for (const path of [...paths, ...linkPaths]) {
      if (skipMarkdown && isMarkdown(path)) continue
      const named = namedIn(haystack, path)
      if (!named) continue
      assign(path, role)
      const real = aliases.get(path)
      if (real !== undefined) assign(real, role)
    }
  }
  const nameCount = new Map<string, number>()
  for (const path of [...paths, ...linkPaths]) nameCount.set(basename(path), (nameCount.get(basename(path)) ?? 0) + 1)
  const hookScripts = new Set<string>()
  const interpreters = new Map<string, 'js' | 'python' | 'shell' | 'other'>()
  // Run by two interpreters, a file is read as no language at all: no
  // comment is trusted, so neither reading can hide what the other runs.
  const noteInterpreter = (command: string, path: string): void => {
    const language = interpreterNaming(command, path)
    if (language === undefined) return
    const real = aliases.get(path) ?? path
    const known = interpreters.get(real)
    interpreters.set(real, known === undefined || known === language ? language : 'other')
  }
  for (const hook of hookCommands) {
    referenced(hook.command, 'hook-script', false)
    for (const path of [...paths, ...linkPaths]) {
      if (!namedIn(hook.command, path)) continue
      hookScripts.add(aliases.get(path) ?? path)
      noteInterpreter(hook.command, path)
    }
  }
  for (const server of mcpServers) {
    const command = [server.command ?? '', ...server.args].join(' ')
    referenced(command, 'server', false)
    for (const path of [...paths, ...linkPaths]) if (namedIn(command, path)) noteInterpreter(command, path)
  }
  // Markdown a prompt tells the model to read is a prompt too, however it is
  // named (a skill's own README): followed until nothing new is named.
  const promptSet = new Set(prompts)
  for (let index = 0; index < prompts.length; index += 1) {
    const body = text(prompts[index] as string) ?? ''
    for (const path of [...paths, ...linkPaths]) {
      // Markdown or plain text: a skill may keep its instructions in references/notes.txt.
      if (!(isMarkdown(path) || PROMPT_TEXT.test(path)) || !namedIn(body, path)) continue
      const real = aliases.get(path) ?? path
      if (paths.has(real) && !promptSet.has(real)) {
        promptSet.add(real)
        prompts.push(real)
      }
    }
  }
  for (const path of prompts) assign(path, 'prompt')
  for (const prompt of prompts) {
    const body = text(prompt) ?? ''
    referenced(body, 'prompt-script', true)
    // A script named relative to the skill's own folder.
    for (const path of paths) {
      if (!isMarkdown(path) && path.startsWith(`${dirname(prompt)}/`) && body.includes(path.slice(dirname(prompt).length + 1))) {
        assign(path, 'prompt-script')
      }
    }
  }
  if (kind === 'skill') {
    for (const file of files) if (!isMarkdown(file.path) && isCodeFile(file.path, text(file.path))) assign(file.path, 'prompt-script')
  } else {
    for (const file of files) {
      const skillDir = file.path.match(/^skills\/[^/]+\//)
      if (skillDir !== null && !isMarkdown(file.path) && isCodeFile(file.path, text(file.path))) assign(file.path, 'prompt-script')
    }
  }
  for (const file of files) if (file.path.startsWith('bin/')) assign(file.path, 'bin')

  for (const file of files) {
    if (isTestPath(file.path)) assign(file.path, 'test')
    else if (isDocPath(file.path)) assign(file.path, 'doc')
    else if (isCodeFile(file.path, text(file.path))) assign(file.path, 'code')
  }

  // Whatever live code loads is live too, even when it sits in a test or
  // docs folder: a hook script that requires ./test/helper.js runs it.
  const queue = files.map(file => file.path).filter(path => LIVE_CODE_ROLES.has(roles.get(path) ?? 'other'))
  const visited = new Set(queue)
  const imports = new Map<string, string[]>()
  while (queue.length > 0) {
    const from = queue.shift() as string
    const targets = localImports(from, text(from) ?? '', realOf)
    imports.set(from, targets)
    for (const target of targets) {
      assign(target, 'code')
      if (!visited.has(target)) {
        visited.add(target)
        queue.push(target)
      }
    }
  }

  const readmePath = files.map(file => file.path).find(path => /^readme(\.md|\.markdown|\.txt)?$/i.test(path))
  const readmeText = readmePath === undefined ? undefined : text(readmePath)

  return {
    tree,
    files,
    kind,
    manifest,
    manifestError,
    readme: readmePath !== undefined && readmeText !== undefined ? { path: readmePath, text: readmeText } : undefined,
    modules,
    hookCommands,
    hookScripts,
    interpreters,
    imports,
    hookConfigErrors,
    mcpServers,
    prompts,
    text,
    roleOf: path => roles.get(path) ?? 'other',
  }
}

/** The interpreter a command runs `path` with, when it names one right before it. */
function interpreterNaming(command: string, path: string): 'js' | 'python' | 'shell' | undefined {
  const normalized = command.replace(/["']/g, ' ').replace(/\/{2,}/g, '/')
  const at = normalized.includes(path) ? normalized.indexOf(path) : normalized.indexOf(basename(path))
  if (at === -1) return undefined
  const languageOfWord = (word: string): 'js' | 'python' | 'shell' | undefined => {
    const program = basename(word).toLowerCase()
    if (/^(?:sh|bash|zsh|dash|ksh|fish|source|\.)$/.test(program)) return 'shell'
    if (/^(?:node|deno|bun|tsx|ts-node)$/.test(program)) return 'js'
    if (/^python\d*(?:\.\d+)?$/.test(program)) return 'python'
    return undefined
  }
  // `cat x.js | sh` pipes the file into an interpreter.
  const piped = /^[^;&|]*\|\s*(\S+)/.exec(normalized.slice(at + path.length))?.[1]
  if (piped !== undefined && languageOfWord(piped) !== undefined) return languageOfWord(piped)
  // Otherwise the nearest interpreter before it in the same command, past
  // options and their values (`bash -o pipefail x.js` is bash). Another file
  // in between is what the interpreter runs: in `bash run.sh x.py`, x.py is
  // run.sh's argument, read as its own extension says.
  // Up to the word that holds the path: `./x.py` and `${ROOT}/x.py` are one word.
  const before = normalized.slice(0, normalized.slice(0, at).search(/\S*$/)).split(/[;&|]/).pop() ?? ''
  const words = before.trim().split(/\s+/).reverse()
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string
    const language = languageOfWord(word)
    if (language !== undefined) return language
    // A file right after an option is the option's value (`node --require ./setup.js x.py`).
    const option = words[index + 1]
    const optionValue = option !== undefined && option.startsWith('-') && !option.includes('=')
    if (!word.startsWith('-') && !optionValue && (word.includes('/') || /\.[A-Za-z]\w{0,4}$/.test(word))) return undefined
  }
  return undefined
}

const LIVE_CODE_ROLES: ReadonlySet<FileRole> = new Set(['module', 'hook-script', 'server', 'prompt-script', 'bin', 'code'])

/** Relative files a source file loads: JS/TS imports and requires, Python relative imports, shell source. */
function localImports(path: string, source: string, realOf: (path: string) => string | undefined): string[] {
  const out: string[] = []
  const dir = dirname(path)
  const add = (spec: string, suffixes: readonly string[]): void => {
    const base = joinPath(dir, spec)
    if (base === undefined) return
    for (const suffix of suffixes) {
      const real = realOf(base + suffix)
      if (real !== undefined) {
        out.push(real)
        return
      }
    }
  }
  for (const match of findAll(source, /\b(?:from|import)\s*['"](\.{1,2}\/[^'"\n]{1,300})['"]|\b(?:require|import)\s*\(\s*['"](\.{1,2}\/[^'"\n]{1,300})['"]\s*\)/g, Number.MAX_SAFE_INTEGER)) {
    const spec = /['"](\.{1,2}\/[^'"\n]{1,300})['"]/.exec(match.text)?.[1]
    const base = spec === undefined ? undefined : joinPath(dir, spec)
    // The same resolution as a hooks module's imports: `./x.js` written for `./x.ts`.
    const real = base === undefined ? undefined : resolveModuleFile(base, realOf)
    if (real !== undefined) out.push(real)
  }
  // Python's imports are read only in Python: `import helper from 'helper'` is JavaScript's.
  const python = /\.pyw?$/i.test(path) || /^#![^\n]*\bpython/.test(source)
  // A script's own folder is first on Python's path, so `import llm` beside it
  // loads ./llm.py. `import a.b` loads a and a/b; `from a import b` loads a,
  // and a/b when b is a submodule; leading dots climb from the file's folder.
  const pythonModule = (dots: string, dotted: string): void => {
    const up = '../'.repeat(Math.max(0, dots.length - 1))
    const parts = dotted.split('.').filter(part => part !== '')
    for (let depth = 1; depth <= parts.length; depth += 1) add(`./${up}${parts.slice(0, depth).join('/')}`, ['.py', '/__init__.py'])
  }
  for (const match of python ? findAll(source, /^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm, Number.MAX_SAFE_INTEGER) : []) {
    // `import a.b as c` loads a.b: the alias is only its name here.
    for (const name of (/import[ \t]+([\w., \t]+)/.exec(match.text)?.[1] ?? '').split(',')) pythonModule('', name.trim().split(/\s+/)[0] ?? '')
  }
  for (const match of python ? findAll(source, /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]{0,2000}\)|[\w, \t]+)/gm, Number.MAX_SAFE_INTEGER) : []) {
    const parts = /from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]{0,2000}\)|[\w, \t]+)/.exec(match.text)
    if (parts === null) continue
    const [, dots = '', module = '', list = ''] = parts
    if (module !== '') pythonModule(dots, module)
    // Each imported name may be a submodule: `from api import transport` can load api/transport.py.
    for (const name of list.replace(/[()]/g, ' ').split(',')) {
      const imported = /^\s*(\w+)/.exec(name)?.[1]
      if (imported !== undefined) pythonModule(dots, module === '' ? imported : `${module}.${imported}`)
    }
  }
  for (const match of findAll(source, /(?:^|[;&|]\s*)(?:source|\.)\s+["']?(\.{1,2}\/[^\s"';]{1,300})/gm, Number.MAX_SAFE_INTEGER)) {
    const spec = /(\.{1,2}\/[^\s"';]{1,300})/.exec(match.text)?.[1]
    if (spec !== undefined) add(spec, [''])
  }
  return out
}

/** Roles whose findings count in full. Tests and docs nothing refers to are only reported. */
export function isLive(role: FileRole): boolean {
  return role !== 'test' && role !== 'doc'
}

function readModule(
  entry: string,
  declaredAs: string,
  realOf: (path: string) => string | undefined,
  text: (path: string) => string | undefined,
): ModuleInfo {
  const info: ModuleInfo = { entry, declaredAs, files: [], events: [], calls: [], envNames: [], urls: [] }
  const queue = [entry]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const file = resolveModuleFile(queue.shift() as string, realOf)
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    info.files.push(file)
    const source = text(file) ?? ''
    // `from './x'`, `import './x'`, `require('./x')`, `import('./x')`: each a short,
    // linear pattern, so a module full of import tokens cannot stall the scan.
    for (const match of findAll(source, /\b(?:from|import)\s*['"](\.{1,2}\/[^'"\n]{1,300})['"]|\b(?:require|import)\s*\(\s*['"](\.{1,2}\/[^'"\n]{1,300})['"]\s*\)/g, Number.MAX_SAFE_INTEGER)) {
      const spec = /['"](\.{1,2}\/[^'"\n]{1,300})['"]/.exec(match.text)?.[1]
      const target = spec === undefined ? undefined : joinPath(dirname(file), spec)
      if (target !== undefined) queue.push(target)
    }
    // A whole-line comment that names `$.process.run` runs nothing. Strings
    // still count: a template literal's `${...}` holds code.
    const kindAt = spanKinds(source, 'js')
    const inCode = (match: Match): boolean => kindAt(match.index) !== 'comment'
    for (const match of findAll(source, /\bon\s*\(\s*(['"`])([^'"`\n]{1,200})\1(\s*,\s*\{[^}]{0,500}\})?/g, 10_000).filter(inCode)) {
      const parts = /\(\s*(['"`])([^'"`\n]{1,200})\1(?:\s*,\s*(\{[^}]{0,500}\}))?/.exec(match.text)
      if (parts?.[2] !== undefined) {
        info.events.push({ name: parts[2], file, line: match.line, detail: parts[3]?.replace(/\s+/g, ' ') })
      }
    }
    // `$.noun.method`, `$.noun?.method`, `$['noun'].method`, and a bare `$.noun`
    // (kept in a variable and called later), which counts as every method of it.
    for (const match of findAll(source, DOLLAR_CALL, 10_000).filter(inCode)) {
      const parts = DOLLAR_PARTS.exec(match.text)
      const noun = parts?.[1] ?? parts?.[2]
      const method = parts?.[3] ?? parts?.[4]
      if (noun === undefined) continue
      info.calls.push({ name: method === undefined ? `${noun}.*` : `${noun}.${method}`, file, line: match.line })
    }
    for (const match of findAll(source, /\$\s*\.\s*env\s*\.\s*(?:get|set)\s*\(\s*(['"`])([^'"`\n]{1,200})\1/g, 100)) {
      const name = /(['"`])([^'"`\n]{1,200})\1/.exec(match.text)?.[2]
      if (name !== undefined) info.envNames.push({ name, file, line: match.line })
    }
    for (const match of findAll(source, /https?:\/\/[^\s'"`)<>]+/g, 100)) {
      info.urls.push({ name: match.text, file, line: match.line })
    }
  }
  return info
}

/** A use of a noun on `$`, with the method when one follows. */
const DOLLAR_CALL = /\$\s*(?:\?\.\s*|\.\s*)?(?:\.\s*[A-Za-z_]\w{0,40}|\[\s*['"`][A-Za-z_]\w{0,40}['"`]\s*\])(?:\s*(?:\?\.|\.)\s*[A-Za-z_]\w{0,40}|\s*\[\s*['"`][A-Za-z_]\w{0,40}['"`]\s*\])?/g
const DOLLAR_PARTS = /\$\s*(?:\?\.\s*|\.\s*)?(?:\.?\s*([A-Za-z_]\w{0,40})|\[\s*['"`]([A-Za-z_]\w{0,40})['"`]\s*\])(?:\s*(?:\?\.|\.)\s*([A-Za-z_]\w{0,40})|\s*\[\s*['"`]([A-Za-z_]\w{0,40})['"`]\s*\])?/

const MODULE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js']

function resolveModuleFile(path: string, realOf: (path: string) => string | undefined): string | undefined {
  for (const suffix of MODULE_SUFFIXES) {
    const real = realOf(path + suffix)
    if (real !== undefined) return real
  }
  // `./x.js` written for a `./x.ts` source.
  const stripped = path.replace(/\.(js|jsx|mjs|cjs)$/, '')
  if (stripped === path) return undefined
  for (const suffix of MODULE_SUFFIXES) {
    const real = realOf(stripped + suffix)
    if (real !== undefined) return real
  }
  return undefined
}

function collectHookCommands(config: Record<string, unknown>, file: string, raw: string, out: HookCommand[]): void {
  const events = isRecord(config.hooks) ? config.hooks : {}
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (!isRecord(group)) continue
      const matcher = typeof group.matcher === 'string' ? group.matcher : undefined
      for (const hook of Array.isArray(group.hooks) ? group.hooks : []) {
        if (!isRecord(hook)) continue
        const type = typeof hook.type === 'string' ? hook.type : 'command'
        const command =
          typeof hook.command === 'string'
            ? hook.command
            : typeof hook.prompt === 'string'
              ? hook.prompt
              : typeof hook.url === 'string'
                ? hook.url
                : JSON.stringify(hook)
        out.push({ file, line: lineOf(raw, JSON.stringify(command).slice(1, -1)), event, matcher, type, command })
      }
    }
  }
}

function collectMcpServers(config: Record<string, unknown>, file: string, raw: string, out: McpServer[]): void {
  const servers = isRecord(config.mcpServers) ? config.mcpServers : {}
  for (const [name, value] of Object.entries(servers)) {
    if (!isRecord(value)) continue
    out.push({
      name,
      file,
      line: lineOf(raw, JSON.stringify(name)),
      type: typeof value.type === 'string' ? value.type : undefined,
      command: typeof value.command === 'string' ? value.command : undefined,
      args: stringList(value.args),
      url: typeof value.url === 'string' ? value.url : undefined,
      env: stringRecord(value.env),
      headers: stringRecord(value.headers),
    })
  }
}

/** Paths the manifest names for these keys, relative to the root. */
function manifestPaths(manifest: Record<string, unknown> | undefined, keys: readonly string[]): string[] {
  if (manifest === undefined) return []
  const out: string[] = []
  for (const key of keys) {
    const value = manifest[key]
    const list = typeof value === 'string' ? [value] : stringList(value)
    for (const item of list) {
      const resolved = joinPath('', item)
      if (resolved !== undefined && resolved !== '') out.push(resolved.replace(/\/$/, ''))
    }
  }
  return out
}

export function parseJson(raw: string | undefined): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw === undefined) return { ok: false, error: 'not readable as text' }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

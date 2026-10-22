import type { InventoryFile, ScannedTree } from '../inventory'
import { basename, dirname, extension, findAll, joinPath, lineOf } from './text'

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
  return DOC_NAMES.test(basename(path)) || first === 'docs' || first === 'doc' || REPO_FILES.test(path)
}

export function buildContext(tree: ScannedTree): ScanContext {
  const files = tree.inventory.entries.filter((entry): entry is InventoryFile => entry.kind === 'file')
  const paths = new Set(files.map(file => file.path))
  // An in-folder link stands for the file it lands on: Claude Code follows it.
  const aliases = new Map<string, string>()
  for (const entry of tree.inventory.entries) {
    if (entry.kind === 'link' && entry.isInside && entry.landsAt !== undefined && paths.has(entry.landsAt)) aliases.set(entry.path, entry.landsAt)
  }
  const realOf = (path: string): string | undefined => (paths.has(path) ? path : aliases.get(path))
  const texts = new Map<string, string>()
  const text = (path: string): string | undefined => {
    const cached = texts.get(path)
    if (cached !== undefined) return cached
    const file = files.find(entry => entry.path === path)
    const bytes = tree.contents.get(path)
    if (file === undefined || !file.isText || bytes === undefined) return undefined
    const decoded = decoder.decode(bytes)
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
  if (paths.has(manifestPath)) {
    assign(manifestPath, 'manifest')
    const parsed = parseJson(text(manifestPath))
    if (parsed.ok && isRecord(parsed.value)) manifest = parsed.value
    else manifestError = parsed.ok ? 'plugin.json is not a JSON object' : parsed.error
  }
  if (paths.has('.claude-plugin/marketplace.json')) assign('.claude-plugin/marketplace.json', 'manifest')

  const hasPluginLayout =
    paths.has(manifestPath) ||
    paths.has('hooks/hooks.json') ||
    paths.has('.mcp.json') ||
    files.some(file => PROMPT_DIRS.some(dir => file.path.startsWith(`${dir}/`)))
  const kind: CandidateKind = paths.has('SKILL.md')
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
  const prompts = files
    .map(file => file.path)
    .filter(path => isMarkdown(path))
    .filter(path => promptRoots.some(root => (root === '' ? !DOC_NAMES.test(basename(path)) || path.includes('/') : path === root || path.startsWith(`${root}/`))))
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
  if (manifest !== undefined && isRecord(manifest.hooks)) {
    collectHookCommands(manifest.hooks, manifestPath, text(manifestPath) ?? '', hookCommands)
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
  if (manifest !== undefined && isRecord(manifest.mcpServers)) {
    collectMcpServers({ mcpServers: manifest.mcpServers }, manifestPath, text(manifestPath) ?? '', mcpServers)
  }

  // Files (and links) that hooks, servers or prompts name are run, not just shipped.
  const linkPaths = tree.inventory.entries.filter(entry => entry.kind === 'link').map(entry => entry.path)
  const referenced = (haystack: string, role: FileRole, skipMarkdown: boolean): void => {
    for (const path of [...paths, ...linkPaths]) {
      if (skipMarkdown && isMarkdown(path)) continue
      if (!haystack.includes(path)) continue
      assign(path, role)
      const real = aliases.get(path)
      if (real !== undefined) assign(real, role)
    }
  }
  for (const hook of hookCommands) referenced(hook.command, 'hook-script', false)
  for (const server of mcpServers) referenced([server.command ?? '', ...server.args].join(' '), 'server', false)
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
    hookConfigErrors,
    mcpServers,
    prompts,
    text,
    roleOf: path => roles.get(path) ?? 'other',
  }
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
    for (const match of findAll(source, /\b(?:from|import)\s*['"](\.{1,2}\/[^'"\n]{1,300})['"]|\b(?:require|import)\s*\(\s*['"](\.{1,2}\/[^'"\n]{1,300})['"]\s*\)/g, 500)) {
      const spec = /['"](\.{1,2}\/[^'"\n]{1,300})['"]/.exec(match.text)?.[1]
      const target = spec === undefined ? undefined : joinPath(dirname(file), spec)
      if (target !== undefined) queue.push(target)
    }
    for (const match of findAll(source, /\bon\s*\(\s*(['"`])([^'"`\n]{1,200})\1(\s*,\s*\{[^}]{0,500}\})?/g, 200)) {
      const parts = /\(\s*(['"`])([^'"`\n]{1,200})\1(?:\s*,\s*(\{[^}]{0,500}\}))?/.exec(match.text)
      if (parts?.[2] !== undefined) {
        info.events.push({ name: parts[2], file, line: match.line, detail: parts[3]?.replace(/\s+/g, ' ') })
      }
    }
    for (const match of findAll(source, /\$\s*\.\s*([A-Za-z_]+)\s*\.\s*([A-Za-z_]+)/g, 500)) {
      info.calls.push({ name: match.text.replace(/[\s$]/g, '').replace(/^\./, ''), file, line: match.line })
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

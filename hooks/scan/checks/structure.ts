import type { InventoryFile, InventoryLink } from '../inventory'
import { isLive, isRecord, isTestPath, parseJson, type ScanContext } from './context'
import { CLAUDE_SETTINGS } from './patterns'
import { basename, dirname, extension, findFirst, joinPath } from './text'
import { row, type CheckResult, type Evidence, type Status } from './types'
import type { ValidatorReport } from './validator'

const GROUP = 'structure' as const
const LARGE_FILE = 1024 * 1024
const MINIFIED_LINE = 1000

export function structureChecks(ctx: ScanContext, validator: ValidatorReport | undefined): CheckResult[] {
  return [
    manifestCheck(ctx, validator),
    componentsCheck(ctx),
    filesCheck(ctx),
    linksCheck(ctx),
    imagesCheck(ctx),
    settingsCheck(ctx),
  ]
}

function manifestCheck(ctx: ScanContext, validator: ValidatorReport | undefined): CheckResult {
  const base = {
    id: 'structure.manifest',
    group: GROUP,
    title: 'Manifest and Claude Code validation',
    advice: 'Claude Code refuses or misreads what fails validation; a candidate that does not validate cannot be judged as written.',
  }
  const evidence: Evidence[] = []
  if (ctx.manifestError !== undefined) {
    evidence.push({ file: '.claude-plugin/plugin.json', excerpt: `does not parse: ${ctx.manifestError}`, status: 'fail' })
  }
  for (const problem of ctx.hookConfigErrors) {
    evidence.push({ file: problem.file, excerpt: `does not parse: ${problem.error}`, status: 'fail' })
  }
  if (validator?.ran === true) {
    for (const error of validator.errors) evidence.push({ file: error.file, excerpt: error.message, status: 'fail' })
  }
  if (evidence.length > 0) {
    return row(base, evidence, 'fail')
  }
  if (validator?.ran === false) {
    return { ...base, status: 'info', severity: 'none', evidence: [{ file: '-', excerpt: `claude plugin validate did not run: ${validator.reason}` }] }
  }
  const warnings = validator?.ran === true ? validator.warnings.length : 0
  return {
    ...base,
    status: 'pass',
    severity: 'none',
    evidence: validator?.ran === true && warnings > 0
      ? [{ file: '-', excerpt: `claude plugin validate: ${warnings} warning${warnings === 1 ? '' : 's'}, no errors`, status: 'pass' }]
      : [],
  }
}

function componentsCheck(ctx: ScanContext): CheckResult {
  const count = (prefix: string, test: (path: string) => boolean = () => true): number =>
    ctx.files.filter(file => file.path.startsWith(prefix) && test(file.path)).length
  const parts: string[] = [`a ${ctx.kind}`]
  const skills = new Set(ctx.prompts.filter(path => /(^|\/)SKILL\.md$/.test(path)).map(path => dirname(path)))
  if (skills.size > 0) parts.push(`${skills.size} skill${skills.size === 1 ? '' : 's'}`)
  const commands = ctx.prompts.filter(path => path.startsWith('commands/')).length
  if (commands > 0) parts.push(`${commands} command${commands === 1 ? '' : 's'}`)
  const agents = ctx.prompts.filter(path => path.startsWith('agents/')).length
  if (agents > 0) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`)
  if (ctx.modules.length > 0) parts.push(`${ctx.modules.length} hooks module${ctx.modules.length === 1 ? '' : 's'} (a mod)`)
  if (ctx.hookCommands.length > 0) parts.push(`${ctx.hookCommands.length} classic hook${ctx.hookCommands.length === 1 ? '' : 's'}`)
  if (ctx.mcpServers.length > 0) parts.push(`${ctx.mcpServers.length} MCP server${ctx.mcpServers.length === 1 ? '' : 's'}`)
  if (ctx.files.some(file => file.path === '.lsp.json')) parts.push('LSP servers')
  const bins = count('bin/')
  if (bins > 0) parts.push(`${bins} file${bins === 1 ? '' : 's'} in bin/ (added to your PATH)`)
  if (ctx.files.some(file => file.path === 'settings.json')) parts.push('default settings')
  return {
    id: 'structure.components',
    group: GROUP,
    title: 'What it ships',
    status: 'info',
    severity: 'none',
    evidence: [{ file: '-', excerpt: parts.join(', ') }],
    advice: 'Each kind of component reaches your machine differently; the groups below check each one.',
  }
}

type Magic = 'elf' | 'mach-o' | 'pe' | 'wasm' | 'zip' | 'gzip' | 'bzip2' | 'xz' | '7z' | 'rar' | 'zstd' | 'tar' | 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf'

const EXECUTABLE: ReadonlySet<Magic> = new Set(['elf', 'mach-o', 'pe', 'wasm'])
const ARCHIVE: ReadonlySet<Magic> = new Set(['zip', 'gzip', 'bzip2', 'xz', '7z', 'rar', 'zstd', 'tar'])
const IMAGE_EXTENSIONS: Record<string, Magic> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' }
const NATIVE_EXTENSIONS = new Set(['so', 'dylib', 'dll', 'node', 'exe', 'o', 'a', 'pyc', 'pyo', 'class', 'jar', 'wasm'])
const ARCHIVE_EXTENSIONS = new Set(['zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst', 'tar', 'jar', 'whl', 'docx', 'xlsx', 'pptx', 'skill'])

export function magicOf(bytes: Uint8Array): Magic | undefined {
  const at = (offset: number, ...values: number[]): boolean => values.every((value, i) => bytes[offset + i] === value)
  if (at(0, 0x7f, 0x45, 0x4c, 0x46)) return 'elf'
  if (at(0, 0xfe, 0xed, 0xfa, 0xce) || at(0, 0xfe, 0xed, 0xfa, 0xcf) || at(0, 0xce, 0xfa, 0xed, 0xfe) || at(0, 0xcf, 0xfa, 0xed, 0xfe) || at(0, 0xca, 0xfe, 0xba, 0xbe)) return 'mach-o'
  if (at(0, 0x4d, 0x5a)) return 'pe'
  if (at(0, 0x00, 0x61, 0x73, 0x6d)) return 'wasm'
  if (at(0, 0x50, 0x4b, 0x03, 0x04) || at(0, 0x50, 0x4b, 0x05, 0x06)) return 'zip'
  if (at(0, 0x1f, 0x8b)) return 'gzip'
  if (at(0, 0x42, 0x5a, 0x68)) return 'bzip2'
  if (at(0, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return 'xz'
  if (at(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return '7z'
  if (at(0, 0x52, 0x61, 0x72, 0x21)) return 'rar'
  if (at(0, 0x28, 0xb5, 0x2f, 0xfd)) return 'zstd'
  if (at(257, 0x75, 0x73, 0x74, 0x61, 0x72)) return 'tar'
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp'
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return 'pdf'
  return undefined
}

function filesCheck(ctx: ScanContext): CheckResult {
  const evidence: Evidence[] = []
  const strict = ctx.kind === 'skill' || ctx.modules.length > 0
  for (const file of ctx.files) {
    const bytes = ctx.tree.contents.get(file.path)
    if (bytes === undefined) continue
    const ext = extension(file.path)
    const magic = magicOf(bytes)
    const live = isLive(ctx.roleOf(file.path))
    const cap = (status: Status): Status => (live ? status : 'info')
    const inSkillOrMod = strict || file.path.startsWith('skills/') || ctx.roleOf(file.path) === 'module'

    if ((magic !== undefined && EXECUTABLE.has(magic)) || NATIVE_EXTENSIONS.has(ext) || basename(file.path).endsWith('.pyc')) {
      const disguised = magic !== undefined && EXECUTABLE.has(magic) && !NATIVE_EXTENSIONS.has(ext) && ext !== '' && ext !== 'bin'
      const what = magic === undefined ? `compiled file (.${ext})` : `${magic} binary`
      evidence.push({
        file: file.path,
        excerpt: disguised ? `${what} named like a .${ext} file` : `${what}: cannot be reviewed as source`,
        status: cap(disguised || inSkillOrMod ? 'fail' : 'warn'),
      })
      continue
    }
    if ((magic !== undefined && ARCHIVE.has(magic)) || ARCHIVE_EXTENSIONS.has(ext)) {
      const disguised = magic !== undefined && ARCHIVE.has(magic) && !ARCHIVE_EXTENSIONS.has(ext)
      evidence.push({
        file: file.path,
        excerpt: disguised ? `${magic} archive named like a .${ext} file` : `${magic ?? ext} archive: its contents are not scanned`,
        status: cap(disguised ? 'fail' : 'warn'),
      })
      continue
    }
    const expectedImage = IMAGE_EXTENSIONS[ext]
    if (expectedImage !== undefined && magic !== expectedImage) {
      evidence.push({ file: file.path, excerpt: `named .${ext} but is ${magic === undefined ? (file.isText ? 'text' : 'not an image') : magic}`, status: cap('fail') })
      continue
    }
    if (file.size > LARGE_FILE) {
      evidence.push({ file: file.path, excerpt: `${(file.size / LARGE_FILE).toFixed(1)} MB: large for a plugin file`, status: cap('warn') })
    }
    if (/^(js|mjs|cjs)$/.test(ext) && (file.path.endsWith('.min.js') || longestLine(ctx.text(file.path) ?? '') > MINIFIED_LINE)) {
      evidence.push({ file: file.path, excerpt: 'minified or bundled JavaScript: hard to review', status: cap('warn') })
    }
  }
  for (const entry of ctx.tree.inventory.entries) {
    if (entry.kind === 'other') evidence.push({ file: entry.path, excerpt: 'not a regular file (a device, pipe or socket)', status: 'warn' })
  }
  return row(
    {
      id: 'structure.files',
      group: GROUP,
      title: 'Unexpected files',
      advice: 'Binaries, archives and minified code cannot be reviewed here. Prefer plugins that ship readable source, and treat a file whose content does not match its name as hostile.',
    },
    evidence,
  )
}

function longestLine(text: string): number {
  let longest = 0
  let start = 0
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      longest = Math.max(longest, i - start)
      start = i + 1
    }
  }
  return longest
}

function linksCheck(ctx: ScanContext): CheckResult {
  const evidence: Evidence[] = []
  for (const entry of ctx.tree.inventory.entries) {
    if (entry.kind !== 'link') continue
    evidence.push(describeLink(entry, ctx))
  }
  return row(
    {
      id: 'structure.links',
      group: GROUP,
      title: 'Symbolic links',
      advice: 'A link that leaves the folder makes Claude Code read or run files outside the plugin, such as your keys. Do not install a plugin that ships one.',
    },
    evidence,
  )
}

function describeLink(link: InventoryLink, ctx: ScanContext): Evidence {
  // A link in a test folder that nothing names is only reported.
  const climbsOut = link.target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(link.target) || joinPath(dirname(link.path), link.target) === undefined
  const live = !isTestPath(link.path) || ctx.roleOf(link.path) !== 'other'
  if (climbsOut || (link.landsAt !== undefined && !link.isInside)) {
    return { file: link.path, excerpt: `links outside the folder to ${link.target}`, status: live ? 'fail' : 'info' }
  }
  if (link.landsAt === undefined) {
    return { file: link.path, excerpt: `links to ${link.target}, which does not exist`, status: live ? 'warn' : 'info' }
  }
  return { file: link.path, excerpt: `links inside the folder to ${link.landsAt}`, status: 'info' }
}

function imagesCheck(ctx: ScanContext): CheckResult {
  const evidence: Evidence[] = []
  for (const file of ctx.files) {
    const bytes = ctx.tree.contents.get(file.path)
    if (bytes === undefined) continue
    const trailing = trailingBytes(bytes)
    if (trailing !== undefined && trailing.extra > 0) {
      evidence.push({
        file: file.path,
        excerpt: `${trailing.extra} byte${trailing.extra === 1 ? '' : 's'} after the end of the ${trailing.format} image`,
        status: isLive(ctx.roleOf(file.path)) ? 'fail' : 'info',
      })
    } else if (trailing?.malformed === true) {
      evidence.push({ file: file.path, excerpt: `malformed ${trailing.format}: its end could not be found`, status: 'warn' })
    }
    if (extension(file.path) === 'svg') {
      const found = findFirst(ctx.text(file.path) ?? '', /<script\b|\son[a-z]+\s*=|<foreignObject\b|javascript:/i)
      if (found !== undefined) evidence.push({ file: file.path, line: found.line, excerpt: `SVG with active content: ${found.excerpt}`, status: 'warn' })
    }
  }
  return row(
    {
      id: 'structure.images',
      group: GROUP,
      title: 'Data hidden in images',
      advice: 'Bytes after an image ends are invisible when the image is shown and are a common way to smuggle a payload. Do not install a plugin whose images carry them.',
    },
    evidence,
  )
}

/** For a PNG, JPEG or WebP: how many bytes follow the image's own end. */
export function trailingBytes(bytes: Uint8Array): { format: string; extra: number; malformed?: true } | undefined {
  const magic = magicOf(bytes)
  if (magic === 'png') {
    let offset = 8
    while (offset + 12 <= bytes.length) {
      const length = (((bytes[offset] as number) << 24) | ((bytes[offset + 1] as number) << 16) | ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number)) >>> 0
      const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8))
      offset += 12 + length
      if (type === 'IEND') return { format: 'PNG', extra: Math.max(0, bytes.length - offset) }
    }
    return { format: 'PNG', extra: 0, malformed: true }
  }
  if (magic === 'jpeg') {
    const end = jpegEnd(bytes)
    if (end === undefined) return { format: 'JPEG', extra: 0, malformed: true }
    const rest = bytes.slice(end)
    return { format: 'JPEG', extra: rest.every(byte => byte === 0) ? 0 : rest.length }
  }
  if (magic === 'webp') {
    const size = ((bytes[4] as number) | ((bytes[5] as number) << 8) | ((bytes[6] as number) << 16) | ((bytes[7] as number) << 24)) >>> 0
    return { format: 'WebP', extra: Math.max(0, bytes.length - (size + 8 + (size % 2))) }
  }
  return undefined
}

function jpegEnd(bytes: Uint8Array): number | undefined {
  let offset = 2
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined
    let marker = bytes[offset + 1] as number
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset += 1
      marker = bytes[offset + 1] as number
    }
    if (marker === 0xd9) return offset + 2
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = (((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number)) >>> 0
    offset += 2 + length
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker that is not a stuffed 0xFF00 or a restart.
      while (offset + 1 < bytes.length) {
        if (bytes[offset] === 0xff) {
          const next = bytes[offset + 1] as number
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break
        }
        offset += 1
      }
    }
  }
  return undefined
}

function settingsCheck(ctx: ScanContext): CheckResult {
  const evidence: Evidence[] = []
  for (const file of ctx.files) {
    if (!/^settings(\.local)?\.json$/.test(basename(file.path)) || !isLive(ctx.roleOf(file.path))) continue
    const raw = ctx.text(file.path) ?? ''
    const parsed = parseJson(raw)
    if (!parsed.ok || !isRecord(parsed.value)) continue
    const settings = parsed.value
    const granted = isRecord(settings.permissions) ? settings.permissions : undefined
    if (granted !== undefined && (Array.isArray(granted.allow) || typeof granted.defaultMode === 'string')) {
      evidence.push({ file: file.path, excerpt: 'grants itself permissions (an allow list or a default mode)', status: 'fail' })
    }
    const hit = findFirst(raw, CLAUDE_SETTINGS)
    if (hit !== undefined) evidence.push({ file: file.path, line: hit.line, excerpt: hit.excerpt, status: 'fail' })
    for (const key of ['hooks', 'apiKeyHelper', 'statusLine', 'awsAuthRefresh', 'otelHeadersHelper']) {
      if (key in settings) evidence.push({ file: file.path, excerpt: `sets ${key}, which runs commands`, status: 'warn' })
    }
  }
  return row(
    {
      id: 'structure.settings',
      group: GROUP,
      title: 'Bundled Claude Code settings',
      advice: 'A plugin should never change your permissions. Settings that run commands deserve the same scrutiny as hooks.',
    },
    evidence,
  )
}

export type { InventoryFile }

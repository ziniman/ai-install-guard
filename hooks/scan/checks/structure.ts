import type { InventoryFile, InventoryLink } from '../inventory'
import { isLive, isRecord, isTestPath, parseJson, type ScanContext } from './context'
import { CLAUDE_SETTINGS } from './patterns'
import { ARCHIVE, ARCHIVE_EXTENSIONS, EXECUTABLE, IMAGE_EXTENSIONS, magicOf, NATIVE_EXTENSIONS, TEXT_EXTENSIONS } from './magic'
import { basename, dirname, extension, findFirst, joinPath } from './text'
import { row, type CheckResult, type Evidence, type Status } from './types'

export { magicOf }
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
    filledInCheck(ctx),
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

function filesCheck(ctx: ScanContext): CheckResult {
  const evidence: Evidence[] = []
  const strict = ctx.kind === 'skill' || ctx.modules.length > 0
  for (const file of ctx.files) {
    const bytes = ctx.tree.contents.get(file.path)
    if (bytes === undefined) continue
    // A versioned native library (libfoo.so.1, libbar.1.dylib) is a .so or .dylib.
    const versioned = /\.(so|dylib)(?:\.\d+)+$|\.\d+\.(dylib)$/.exec(basename(file.path))
    const ext = versioned !== null ? ((versioned[1] ?? versioned[2]) as string) : extension(file.path)
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
    const expectedImage = Object.hasOwn(IMAGE_EXTENSIONS, ext) ? IMAGE_EXTENSIONS[ext] : undefined
    if (expectedImage !== undefined && magic !== expectedImage) {
      evidence.push({ file: file.path, excerpt: `named .${ext} but is ${magic === undefined ? (file.isText ? 'text' : 'not an image') : magic}`, status: cap('fail') })
      continue
    }
    if (!file.isText && TEXT_EXTENSIONS.has(ext)) {
      evidence.push({ file: file.path, excerpt: `named .${ext} but holds NUL bytes, which hide its text from text tools`, status: cap('warn') })
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
  const isAbsolute = link.target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(link.target)
  const climbsOut = !isAbsolute && joinPath(dirname(link.path), link.target) === undefined
  const role = ctx.roleOf(link.path)
  const live = role !== 'other' || !isTestPath(link.path)
  if (isAbsolute && link.isInside) {
    // It lands inside here, but an absolute path lands somewhere else on every other machine.
    return { file: link.path, excerpt: `absolute link to ${link.target}: where it leads depends on the machine`, status: live ? 'warn' : 'info' }
  }
  if (isAbsolute || climbsOut || (link.landsAt !== undefined && !link.isInside)) {
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
    const end = size + 8 + (size % 2)
    // A size that claims more than the file holds is forged or broken.
    if (end > bytes.length + (size % 2)) return { format: 'WebP', extra: 0, malformed: true }
    return { format: 'WebP', extra: Math.max(0, bytes.length - end) }
  }
  if (magic === 'gif') {
    const end = gifEnd(bytes)
    if (end === undefined) return { format: 'GIF', extra: 0, malformed: true }
    return { format: 'GIF', extra: bytes.length - end }
  }
  return undefined
}

/** Where a GIF's trailer (0x3B) ends, walking its blocks; undefined when malformed. */
function gifEnd(bytes: Uint8Array): number | undefined {
  if (bytes.length < 13) return undefined
  let offset = 13
  const flags = bytes[10] as number
  if ((flags & 0x80) !== 0) offset += 3 * (1 << ((flags & 0x07) + 1))
  const skipSubBlocks = (): boolean => {
    while (offset < bytes.length) {
      const size = bytes[offset] as number
      offset += 1
      if (size === 0) return true
      offset += size
    }
    return false
  }
  while (offset < bytes.length) {
    const block = bytes[offset] as number
    if (block === 0x3b) return offset + 1
    if (block === 0x21) {
      offset += 2
      if (!skipSubBlocks()) return undefined
    } else if (block === 0x2c) {
      if (offset + 10 > bytes.length) return undefined
      const local = bytes[offset + 9] as number
      offset += 10
      if ((local & 0x80) !== 0) offset += 3 * (1 << ((local & 0x07) + 1))
      offset += 1
      if (!skipSubBlocks()) return undefined
    } else {
      return undefined
    }
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

/**
 * Files whose real content is not in the folder: Git LFS pointers, whose file
 * is downloaded at install, and paths a git filter rewrites on checkout. The
 * scan reads what is stored, so the code that runs could be anything.
 */
function filledInCheck(ctx: ScanContext): CheckResult {
  const evidence: Evidence[] = []
  for (const file of ctx.files) {
    const name = basename(file.path)
    if (name === '.gitattributes') {
      // A line covers the files its pattern names under its own folder:
      // rewriting only tests or docs is noted, live code is a warning.
      const folder = dirname(file.path)
      const lines = (ctx.text(file.path) ?? '').split('\n')
      for (let index = 0; index < lines.length && index < 1000; index += 1) {
        const line = (lines[index] as string).trim()
        if (line.startsWith('#') || line.startsWith('[attr]')) continue
        const driver = /(?:^|\s)filter=([^\s]{1,100})/.exec(line)?.[1]
        if (driver === undefined) continue
        const pattern = line.split(/\s/)[0] as string
        const coversLive = ctx.files.some(other => {
          const rel = folder === '' ? other.path : other.path.startsWith(`${folder}/`) ? other.path.slice(folder.length + 1) : undefined
          return rel !== undefined && attributeMatches(pattern, rel) && isLive(ctx.roleOf(other.path))
        })
        evidence.push({ file: file.path, line: index + 1, excerpt: `git rewrites these files with the "${driver}" filter on checkout: ${line.slice(0, 200)}`, status: coversLive ? 'warn' : 'info' })
      }
      continue
    }
    if (file.size > 1024) continue
    const text = ctx.text(file.path)
    if (text === undefined || !text.startsWith('version https://git-lfs.github.com/spec/')) continue
    evidence.push({
      file: file.path,
      excerpt: 'a Git LFS pointer: the real file is downloaded when it is installed, and this scan could not read it',
      // Images and docs often live in LFS; code that runs must not.
      status: isLive(ctx.roleOf(file.path)) ? 'fail' : 'info',
    })
    if (evidence.length >= 20) break
  }
  return row(
    {
      id: 'structure.fetched',
      group: GROUP,
      title: 'Files filled in at install',
      advice: 'The scan reads what the repository stores. A file that Git LFS downloads or a filter rewrites at install can hold different code, which was not checked.',
    },
    evidence,
  )
}

/**
 * Whether a .gitattributes pattern names `path` (relative to the attributes
 * file's folder): no slash matches the name at any depth, a slash anchors it,
 * `*` and `?` stay within a folder and `**` crosses them. A pattern too
 * elaborate to match cheaply counts as matching, which can only warn more.
 */
export function attributeMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith('/')) return false
  if (pattern.length > 200 || path.length > 1000 || (pattern.match(/[*?[]/g) ?? []).length > 8) return true
  const anchored = pattern.includes('/')
  const body = pattern.startsWith('/') ? pattern.slice(1) : pattern
  let source = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string
    if (char === '*' && body[index + 1] === '*') {
      if (body[index + 2] === '/') {
        source += '(?:.*/)?'
        index += 2
      } else {
        source += '.*'
        index += 1
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '[' && body.indexOf(']', index + 2) !== -1) {
      const end = body.indexOf(']', index + 2)
      source += `[${body.slice(index + 1, end).replace(/^!/, '^').replace(/[\\\]]/g, '\\$&')}]`
      index = end
    } else {
      source += char.replace(/[.+^${}()|\\[\]]/g, '\\$&')
    }
  }
  try {
    return new RegExp(`^${source}$`).test(anchored ? path : basename(path))
  } catch {
    return true
  }
}

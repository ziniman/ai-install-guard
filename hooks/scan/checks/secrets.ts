import { isLive, type ScanContext } from './context'
import { SECRET_KEYS } from './patterns'
import { basename, findAll } from './text'
import { row, type CheckResult, type Evidence } from './types'

const GROUP = 'secrets' as const

const PLACEHOLDER = /^(?:|<.*>|\$\{.*\}|your[-_ ].*|xx+|\*+|changeme|change-me|todo|tbd|none|null|example|placeholder|dummy|test|secret|password|\.\.\.)$/i

/**
 * A binary file's text for the key patterns: UTF-16 decoded as such (a BOM,
 * or NUL in every other byte), anything else with printable ASCII and line
 * breaks kept and every other byte a space.
 */
function asciiOf(bytes: Uint8Array | undefined): string | undefined {
  if (bytes === undefined) return undefined
  // Decoded by hand: a mod's TextDecoder need not know UTF-16.
  const utf16 = utf16Of(bytes)
  if (utf16 !== undefined) {
    let text = ''
    const little = utf16 === 'utf-16le'
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = little ? (bytes[i] as number) | ((bytes[i + 1] as number) << 8) : ((bytes[i] as number) << 8) | (bytes[i + 1] as number)
      text += String.fromCharCode(code)
    }
    return text
  }
  let out = ''
  for (const byte of bytes) out += byte === 10 || (byte >= 32 && byte < 127) ? String.fromCharCode(byte) : ' '
  return out
}

function utf16Of(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  const sample = Math.min(bytes.length, 400) & ~1
  if (sample < 8) return undefined
  let evenNul = 0
  let oddNul = 0
  for (let i = 0; i < sample; i += 2) {
    if (bytes[i] === 0) evenNul += 1
    if (bytes[i + 1] === 0) oddNul += 1
  }
  const half = sample / 2
  if (oddNul > half * 0.8 && evenNul < half * 0.2) return 'utf-16le'
  if (evenNul > half * 0.8 && oddNul < half * 0.2) return 'utf-16be'
  return undefined
}

export function secretChecks(ctx: ScanContext): CheckResult[] {
  const keys: Evidence[] = []
  for (const file of ctx.files) {
    // Binary files are read too, as ASCII: a NUL byte must not hide a key.
    const text = file.isText ? ctx.text(file.path) : asciiOf(ctx.tree.contents.get(file.path))
    if (text === undefined) continue
    const live = isLive(ctx.roleOf(file.path))
    for (const { kind, pattern } of SECRET_KEYS) {
      for (const match of findAll(text, pattern, 3)) {
        // A committed key is the author's leak, not a way in to you: worth a look, never a reason on its own to refuse.
        keys.push({ file: file.path, line: match.line, excerpt: kind, status: live ? 'warn' : 'info' })
      }
    }
  }

  const envFiles: Evidence[] = []
  for (const file of ctx.files) {
    const name = basename(file.path)
    if (!/^\.env(?:\..+)?$/.test(name) || /\.(?:example|sample|template|dist|defaults?|schema)$/i.test(name)) continue
    const text = ctx.text(file.path) ?? asciiOf(ctx.tree.contents.get(file.path)) ?? ''
    const lines = text.split(/\r?\n/)
    const filled = lines
      .map((line, index) => ({ index, match: /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]{0,200})[ \t]*=(.*)$/.exec(line) }))
      .filter(item => item.match !== null && !PLACEHOLDER.test((item.match[2] as string).trim().replace(/^['"]|['"]$/g, '')))
    if (filled.length > 0) {
      const first = filled[0] as { index: number; match: RegExpExecArray }
      envFiles.push({
        file: file.path,
        line: first.index + 1,
        excerpt: `${filled.length} variable${filled.length === 1 ? '' : 's'} with values, first ${first.match[1]}`,
        status: isLive(ctx.roleOf(file.path)) ? 'warn' : 'info',
      })
    }
  }

  return [
    row(
      {
        id: 'secrets.keys',
        group: GROUP,
        title: 'Committed keys and tokens',
        advice: 'A real key in a public plugin is already leaked, and one that looks real may be bait. The value is never shown here.',
      },
      keys,
      'warn',
    ),
    row(
      {
        id: 'secrets.env-files',
        group: GROUP,
        title: '.env files with values',
        advice: 'A .env file with values ships someone\'s configuration, often their secrets.',
      },
      envFiles,
      'warn',
    ),
  ]
}

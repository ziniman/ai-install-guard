// Tests for the chat skill's scanner, run with node:test by `npm run
// test:skill` after the build. They run the built scripts/scan.js the way a
// chat does, on the fixtures on disk and on zips made from them, and check it
// reaches the same verdicts as the mod's own tests (hooks/checks.test.ts).
// No test reaches the network.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(REPO, 'skill', 'ai-install-guard', 'scripts', 'scan.js')
const FIXTURES = path.join(REPO, 'fixtures')
const { writeZip } = createRequire(import.meta.url)(path.join(REPO, 'scripts', 'build-skill.js'))

const EXIT = { safe: 0, caution: 1, reject: 2, unverified: 3 }

let work
let tmp

before(() => {
  assert.ok(fs.existsSync(SCRIPT), 'build the skill first: npm run build:skill')
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-skill-test.'))
  // The scanner's own temporary folders go here, so the tests can see them removed.
  tmp = path.join(work, 'tmp')
  fs.mkdirSync(tmp)
})

after(() => {
  fs.rmSync(work, { recursive: true, force: true })
})

function run(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp } })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function scanJson(...args) {
  const result = run('--json', ...args)
  return { ...result, report: JSON.parse(result.stdout) }
}

/** Every row that is not a pass or a note, as `id:status`, sorted, as checks.test.ts counts them. */
function flagged(report) {
  return report.results
    .filter(row => row.status === 'fail' || row.status === 'warn')
    .map(row => `${row.id}:${row.status}`)
    .sort()
}

/** The table of what each fixture trips, read from the mod's own tests so the two cannot drift. */
function fixtureCases() {
  const source = fs.readFileSync(path.join(REPO, 'hooks', 'checks.test.ts'), 'utf8')
  const cases = []
  for (const match of source.matchAll(/\{ fixture: '([^']+)', flags: \[([^\]]*)\], verdict: '(\w+)' \}/g)) {
    cases.push({ fixture: match[1], flags: [...match[2].matchAll(/'([^']+)'/g)].map(flag => flag[1]).sort(), verdict: match[3] })
  }
  return cases
}

/** A fixture's files as zip entries under `prefix`, links kept as links. */
function fixtureEntries(name, prefix) {
  const entries = []
  const walk = (dir, rel) => {
    for (const child of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, child)
      const childRel = rel === '' ? child : `${rel}/${child}`
      const stats = fs.lstatSync(full)
      if (stats.isSymbolicLink()) entries.push({ name: `${prefix}${childRel}`, data: fs.readlinkSync(full), mode: 0o120777 })
      else if (stats.isDirectory()) {
        entries.push({ name: `${prefix}${childRel}/`, mode: 0o040755 })
        walk(full, childRel)
      } else entries.push({ name: `${prefix}${childRel}`, data: fs.readFileSync(full), mode: 0o100644 })
    }
  }
  walk(path.join(FIXTURES, name), '')
  return entries
}

function zipFile(name, entries) {
  const file = path.join(work, name)
  fs.writeFileSync(file, writeZip(entries))
  return file
}

function leftovers() {
  return fs.readdirSync(tmp)
}

describe('each fixture gets the verdict the mod gives it', () => {
  const cases = fixtureCases()

  test('the table was read whole', () => {
    const onDisk = fs.readdirSync(FIXTURES).filter(name => fs.lstatSync(path.join(FIXTURES, name)).isDirectory())
    assert.deepEqual(cases.map(item => item.fixture).sort(), onDisk.sort())
  })

  for (const { fixture, flags, verdict } of cases) {
    test(`${fixture}: ${verdict}`, () => {
      const { status, report } = scanJson(path.join(FIXTURES, fixture))

      assert.deepEqual(flagged(report), flags)
      assert.equal(report.verdict.kind, verdict)
      assert.equal(status, EXIT[verdict])
    })
  }
})

describe('zip archives', () => {
  for (const name of ['clean-plugin', 'curl-hook', 'mcp-curl', 'symlink-outside']) {
    test(`${name}, zipped in a folder as GitHub does, scans like the folder`, () => {
      const folder = scanJson(path.join(FIXTURES, name)).report
      const zip = zipFile(`${name}-main.zip`, [{ name: `${name}-main/`, mode: 0o040755 }, ...fixtureEntries(name, `${name}-main/`)])
      const { status, report } = scanJson(zip)

      assert.equal(report.target, `${name}-main.zip/${name}-main`)
      assert.equal(report.verdict.kind, folder.verdict.kind)
      assert.deepEqual(flagged(report), flagged(folder))
      assert.equal(report.treeHash, folder.treeHash)
      assert.equal(status, EXIT[folder.verdict.kind])
      assert.deepEqual(leftovers(), [])
    })
  }

  test('a zip with the plugin at its top is scanned there', () => {
    const { report } = scanJson(zipFile('flat.zip', fixtureEntries('mcp-curl', '')))

    assert.equal(report.target, 'flat.zip')
    assert.equal(report.verdict.kind, 'reject')
    assert.deepEqual(flagged(report), ['mcp.launch:fail', 'mcp.remote:warn'])
  })

  test('macOS archive litter beside the folder is not taken for a second folder', () => {
    const entries = [...fixtureEntries('clean-plugin', 'clean-plugin/'), { name: '__MACOSX/clean-plugin/._README.md', data: 'x' }, { name: '.DS_Store', data: 'x' }]
    const { report } = scanJson(zipFile('finder.zip', entries))

    assert.equal(report.target, 'finder.zip/clean-plugin')
    assert.equal(report.verdict.kind, 'safe')
  })

  test('a README beside the plugin folder: the plugin is scanned as one', () => {
    const entries = [{ name: 'README.md', data: '# Notes\n' }, ...fixtureEntries('skill-injection', 'notes-plugin/')]
    const { report } = scanJson(zipFile('beside.zip', entries))

    assert.equal(report.target, 'beside.zip/notes-plugin')
    assert.deepEqual(flagged(report), ['prompts.injection:fail'])
  })

  test('an empty folder or a link named like a plugin part does not hide the plugin beside it', () => {
    const decoys = [{ name: 'commands/', mode: 0o040755 }, { name: '.mcp.json', data: '/dev/null', mode: 0o120777 }]
    const { report } = scanJson(zipFile('decoy.zip', [...decoys, ...fixtureEntries('skill-injection', 'helper/')]))

    assert.equal(report.target, 'decoy.zip/helper')
    assert.deepEqual(flagged(report), ['prompts.injection:fail'])
  })

  test('two plugins side by side: Could not verify until one is named', () => {
    const zip = zipFile('pair.zip', [...fixtureEntries('clean-plugin', 'one/'), ...fixtureEntries('curl-hook', 'two/')])
    const { status, report } = scanJson(zip)

    assert.equal(status, EXIT.unverified)
    assert.match(report.verdict.reasons[0], /2 plugins or skills side by side .*--path/)
    assert.equal(scanJson('--path', 'two', zip).report.verdict.kind, 'reject')
  })

  test('--path picks a folder inside the zip', () => {
    const entries = [...fixtureEntries('curl-hook', 'repo/plugins/one/'), ...fixtureEntries('clean-plugin', 'repo/plugins/two/')]
    const zip = zipFile('market.zip', entries)

    assert.equal(scanJson('--path', 'plugins/one', zip).report.verdict.kind, 'reject')
    assert.equal(scanJson('--path', 'plugins/two', zip).report.verdict.kind, 'safe')
  })

  test('the text report quotes the evidence and names the zip, not the temporary folder', () => {
    const zip = zipFile('curl.zip', fixtureEntries('curl-hook', 'curl-hook/'))
    const { status, stdout } = run('--details', zip)

    assert.equal(status, EXIT.reject)
    assert.match(stdout, /^Verdict: Do not install$/m)
    assert.match(stdout, /hooks\/hooks\.json:8 .*curl -s https:\/\/telemetry\.example\.net/)
    assert.match(stdout, /^Folder: curl\.zip\/curl-hook \(unpacked from the zip\)$/m)
    assert.doesNotMatch(stdout, /ai-install-guard-zip\./)
  })

  // Each archive here is refused before anything is written, and the answer is never a pass.
  const refused = {
    'a path that climbs out': [[{ name: '../escaped.txt', data: 'x' }], /could land outside/],
    'an absolute path': [[{ name: '/tmp/escaped.txt', data: 'x' }], /could land outside/],
    'a Windows drive path': [[{ name: 'C:/escaped.txt', data: 'x' }], /could land outside/],
    'a backslash in a name': [[{ name: 'a\\..\\escaped.txt', data: 'x' }], /could land outside/],
    'the same name twice': [[{ name: 'a.txt', data: 'x' }, { name: 'a.txt', data: 'y' }], /listed more than once/],
    'a file beneath a link': [[{ name: 'skills', data: '/etc', mode: 0o120777 }, { name: 'skills/x.md', data: 'x' }], /beneath skills, which is a link/],
    'a special file': [[{ name: 'pipe', data: '', mode: 0o010644 }], /special file/],
    'a file over the per-file limit': [[{ name: 'big.txt', data: Buffer.alloc(4 * 1024 * 1024 + 1) }], /per-file limit/],
  }
  for (const [what, [entries, reason]] of Object.entries(refused)) {
    test(`${what}: Could not verify`, () => {
      const { status, report } = scanJson(zipFile('refused.zip', entries))

      assert.equal(report.verdict.kind, 'unverified')
      assert.match(report.verdict.reasons[0], reason)
      assert.equal(status, EXIT.unverified)
      assert.equal(fs.existsSync(path.join(work, 'escaped.txt')), false)
      assert.equal(fs.existsSync(path.join(tmp, 'escaped.txt')), false)
      assert.deepEqual(leftovers(), [])
    })
  }

  test('a damaged or a fake archive: Could not verify', () => {
    const whole = writeZip(fixtureEntries('clean-plugin', ''))
    const cut = path.join(work, 'cut.zip')
    fs.writeFileSync(cut, whole.subarray(0, whole.length - 30))
    const fake = path.join(work, 'notes.zip')
    fs.writeFileSync(fake, 'not a zip\n')

    assert.equal(scanJson(cut).report.verdict.kind, 'unverified')
    assert.equal(scanJson(fake).report.verdict.kind, 'unverified')
  })

  test('a link is unpacked as a link and judged, never followed', () => {
    const entries = [...fixtureEntries('clean-plugin', ''), { name: 'docs/key', data: '../../../../../../.ssh/id_ed25519', mode: 0o120777 }]
    const { report } = scanJson(zipFile('link.zip', entries))

    assert.equal(report.verdict.kind, 'reject')
    assert.ok(flagged(report).includes('structure.links:fail'))
  })
})

describe('the command line', () => {
  test('no target is a usage mistake', () => {
    const { status, stderr } = run()

    assert.equal(status, 64)
    assert.match(stderr, /name a folder, zip or repository/)
  })

  test('an unknown option is a usage mistake', () => {
    assert.equal(run('--install', path.join(FIXTURES, 'clean-plugin')).status, 64)
  })

  test('--version prints the package version', () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))

    assert.equal(run('--version').stdout.trim(), version)
  })

  test('--ref on a folder: Could not verify', () => {
    const { status, report } = scanJson('--ref', 'v1', path.join(FIXTURES, 'clean-plugin'))

    assert.equal(status, EXIT.unverified)
    assert.match(report.verdict.reasons[0], /--ref applies to a repository/)
  })

  test('--path cannot leave the folder', () => {
    const { status, report } = scanJson('--path', '../curl-hook', path.join(FIXTURES, 'clean-plugin'))

    assert.equal(status, EXIT.unverified)
    assert.match(report.verdict.reasons[0], /not inside/)
  })

  test('a missing path: Could not verify', () => {
    assert.equal(scanJson(path.join(work, 'nowhere')).report.verdict.kind, 'unverified')
  })

  test('a plain http source is refused before any fetch', () => {
    const { status, report } = scanJson('http://example.com/owner/repo')

    assert.equal(status, EXIT.unverified)
    assert.match(report.verdict.reasons[0], /only https/)
  })

  test('hidden characters from a candidate never reach the output as themselves', () => {
    const hidden = /[\u{E0000}-\u{E007F}\u202A-\u202E\u2066-\u2069\u200B-\u200F]/u
    const target = path.join(FIXTURES, 'skill-hidden-tags')

    assert.doesNotMatch(run('--details', target).stdout, hidden)
    assert.doesNotMatch(run('--json', target).stdout, hidden)
    assert.match(run('--details', target).stdout, /ignore all previous instructions/)
  })
})

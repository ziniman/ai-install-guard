import { describe, expect, test } from 'claude-code/testing'

import { splitArgs } from './register'
import type { Host } from './scan/host'
import { LIMITS, takeInventory } from './scan/inventory'
import { formatInventory } from './scan/report'
import { safeLine, safeText } from './scan/safe-text'
import { FIXTURES } from './test-support/fixtures.gen'
import { HOME, memoryHost, serveFixture, typed, type FixtureFiles } from './test-support/memfs'

const CLEAN = FIXTURES['clean-plugin'] as FixtureFiles
const text = (value: string) => ({ base64: btoa(value) })

describe('/guard scan on a local folder', () => {
  test('lists and hashes every file of a plugin', async ($, on) => {
    serveFixture(on, '/work/clean-plugin', CLEAN)
    const { text: report } = await $.command.run(typed('guard', 'scan /work/clean-plugin'))

    expect(report).toContain('AI Install Guard: /work/clean-plugin')
    expect(report).toContain('Files: 4')
    expect(report).toContain('skills/greet/SKILL.md')
    expect(report).toMatch(/Tree hash: sha256:[0-9a-f]{64}/)
  })

  test('expands ~ to the home folder', async ($, on) => {
    serveFixture(on, `${HOME}/plugins/clean`, CLEAN)
    const { text: report } = await $.command.run(typed('guard', 'scan ~/plugins/clean'))

    expect(report).toContain(`Folder: ${HOME}/plugins/clean`)
  })

  test('reads link targets through PowerShell where there is no readlink', async ($, on) => {
    serveFixture(on, '/work/linked', { 'README.md': text('x\n'), 'docs/readme': { link: '../README.md' } }, { platform: 'windows' })
    const { text: report } = await $.command.run(typed('guard', 'scan /work/linked'))

    expect(report).toContain('docs/readme  link to ../README.md')
  })

  test('says it could not verify a folder that is not there', async ($, on) => {
    serveFixture(on, '/work/clean-plugin', CLEAN)
    const { text: report } = await $.command.run(typed('guard', 'scan /work/missing'))

    expect(report).toContain('Could not verify /work/missing')
  })

  test('answers with usage when no path is given', async $ => {
    const { text: report } = await $.command.run(typed('guard', ''))

    expect(report).toContain('/guard scan <path>')
  })
})

describe('inventory', () => {
  test('the tree hash is stable and changes when one byte changes', async () => {
    const first = await takeInventory(memoryHost('/a', CLEAN), '/a')
    const again = await takeInventory(memoryHost('/b', CLEAN), '/b')
    const edited = await takeInventory(
      memoryHost('/a', { ...CLEAN, 'README.md': text('# clean-plugin.\n') }),
      '/a',
    )

    expect(again.inventory.treeHash).toBe(first.inventory.treeHash)
    expect(edited.inventory.treeHash).not.toBe(first.inventory.treeHash)
  })

  test('records a symbolic link with its target and where it lands, and never reads through it', async () => {
    const files: FixtureFiles = {
      'README.md': text('hello\n'),
      'docs/inside': { link: '../README.md' },
      'docs/keys': { link: '../../../home/tester/.ssh/id_ed25519' },
      'docs/gone': { link: 'missing.md' },
    }
    const { inventory } = await takeInventory(memoryHost('/p/plugin', files), '/p/plugin')
    const links = inventory.entries.filter(entry => entry.kind === 'link')

    expect(links).toEqual([
      { kind: 'link', path: 'docs/gone', target: 'missing.md', isInside: false },
      { kind: 'link', path: 'docs/inside', target: '../README.md', landsAt: 'README.md', isInside: true },
      {
        kind: 'link',
        path: 'docs/keys',
        target: '../../../home/tester/.ssh/id_ed25519',
        landsAt: '/home/tester/.ssh/id_ed25519',
        isInside: false,
      },
    ])
  })

  test('a link counts by its stored target, so the hash is the same on every machine', async () => {
    const tree = (target: string): FixtureFiles => ({ 'README.md': text('x\n'), 'docs/link': { link: target } })
    const here = await takeInventory(memoryHost('/home/a/plugin', tree('../../outside')), '/home/a/plugin')
    const there = await takeInventory(memoryHost('/srv/b/plugin', tree('../../outside')), '/srv/b/plugin')
    const otherDangling = await takeInventory(memoryHost('/home/a/plugin', tree('nope-1')), '/home/a/plugin')
    const anotherDangling = await takeInventory(memoryHost('/home/a/plugin', tree('nope-2')), '/home/a/plugin')

    expect(there.inventory.treeHash).toBe(here.inventory.treeHash)
    expect(anotherDangling.inventory.treeHash).not.toBe(otherDangling.inventory.treeHash)
  })

  test('two different file names never share a tree hash', async () => {
    const withNewline = await takeInventory(memoryHost('/r', { 'a\nb': text('same') }), '/r')
    const withEscapes = await takeInventory(memoryHost('/r', { '"a\\nb"': text('same') }), '/r')

    expect(withEscapes.inventory.treeHash).not.toBe(withNewline.inventory.treeHash)
  })

  test('an empty folder changes the tree hash', async () => {
    const plain = await takeInventory(memoryHost('/r', { 'README.md': text('x') }), '/r')
    const withFolder = await takeInventory(memoryHost('/r', { 'README.md': text('x'), empty: { dir: true } }), '/r')

    expect(withFolder.inventory.treeHash).not.toBe(plain.inventory.treeHash)
  })

  test('refuses to read a file that turned into a link after it was listed', async () => {
    const host = memoryHost('/r', { 'README.md': text('x'), 'notes.md': text('y') })
    const swapped: Host = {
      ...host,
      stat: async (path, options) =>
        path === '/r/notes.md' ? { kind: 'file', size: 1, isLink: true, realPath: '/home/tester/.ssh/id_rsa' } : host.stat(path, options),
      readBytes: async path => {
        if (path === '/r/notes.md') throw new Error('test: read a swapped link')
        return host.readBytes(path)
      },
    }

    await expect(takeInventory(swapped, '/r')).rejects.toThrow(/notes.md changed while it was being scanned/)
  })

  test('limits apply to the bytes read, not only to the listed size', async () => {
    const host = memoryHost('/r', { 'grows.txt': text('small') })
    const growing: Host = {
      ...host,
      readBytes: async () => new Uint8Array(LIMITS.maxFileBytes + 1),
    }

    await expect(takeInventory(growing, '/r')).rejects.toThrow(/over the 4.0 MB per-file limit/)
  })

  test('refuses a tree with more links than the link limit, before reading any of them', async () => {
    const files: FixtureFiles = { 'README.md': text('x') }
    for (let i = 0; i <= LIMITS.maxLinks; i += 1) files[`l${i}`] = { link: 'README.md' }
    const host = memoryHost('/links', files)
    let readlinks = 0
    const counting: Host = { ...host, readLink: path => ((readlinks += 1), host.readLink(path)) }

    await expect(takeInventory(counting, '/links')).rejects.toThrow(/more than 500 symbolic links/)
    expect(readlinks).toBe(0)
  })

  test('folders count toward the entry limit', async () => {
    const files: FixtureFiles = {}
    for (let i = 0; i <= LIMITS.maxEntries; i += 1) files[`d${i}`] = { dir: true }

    await expect(takeInventory(memoryHost('/deep', files), '/deep')).rejects.toThrow(/more than 5000 files and folders/)
  })

  test('a backslash in a POSIX folder name is part of the name', async () => {
    const { inventory } = await takeInventory(memoryHost('/r/we\\ird', { 'README.md': text('x') }), '/r/we\\ird')

    expect(inventory.root).toBe('/r/we\\ird')
    expect(inventory.entries.map(entry => entry.path)).toEqual(['README.md'])
  })

  test('leaves out the root .git folder', async () => {
    const files: FixtureFiles = { 'README.md': text('hi\n'), '.git/HEAD': text('ref: refs/heads/main\n') }
    const { inventory } = await takeInventory(memoryHost('/r', files), '/r')

    expect(inventory.skipped).toEqual(['.git'])
    expect(inventory.entries.map(entry => entry.path)).toEqual(['README.md'])
  })

  test('marks files with NUL bytes as binary', async () => {
    const files: FixtureFiles = { 'tool.bin': { base64: 'AAECAw==' }, 'notes.txt': text('plain\n') }
    const { inventory } = await takeInventory(memoryHost('/r', files), '/r')
    const byPath = Object.fromEntries(inventory.entries.map(entry => [entry.path, entry]))

    expect(byPath['tool.bin']).toMatchObject({ isText: false })
    expect(byPath['notes.txt']).toMatchObject({ isText: true })
  })

  test('refuses a tree with more entries than the limit', async () => {
    const files: FixtureFiles = {}
    for (let i = 0; i <= LIMITS.maxEntries; i += 1) files[`f${i}.txt`] = text('x')

    await expect(takeInventory(memoryHost('/big', files), '/big')).rejects.toThrow(/more than 5000 files/)
  })
})

describe('untrusted text in reports', () => {
  test('hidden and control characters are shown as code points', () => {
    expect(safeText('a\u001b[31mred')).toBe('a<U+001B>[31mred')
    expect(safeText('x\u200by')).toBe('x<U+200B>y')
    expect(safeText('tag\u{e0041}')).toBe('tag<U+E0041>')
    expect(safeText('rtl\u202eexe.md')).toBe('rtl<U+202E>exe.md')
    expect(safeText('line one\nline two')).toBe('line one\nline two')
    expect(safeLine('a\nb\tc')).toBe('a<U+000A>b<U+0009>c')
    expect(safeText('\u061c\u034f\u115f\u1160\u3164\u2028\u2029')).toBe(
      '<U+061C><U+034F><U+115F><U+1160><U+3164><U+2028><U+2029>',
    )
  })

  test('a file name with escapes cannot paint the report', async () => {
    const files: FixtureFiles = { 'evil\u001b[2Jname\u202e.md': text('x') }
    const { inventory } = await takeInventory(memoryHost('/r', files), '/r')
    const report = formatInventory('/r', inventory)

    expect(report).toContain('evil<U+001B>[2Jname<U+202E>.md')
    expect(report).not.toContain('\u001b')
  })
})

describe('arguments', () => {
  test('a quoted path keeps its spaces', () => {
    expect(splitArgs('  scan "/tmp/my plugin" ')).toEqual({ sub: 'scan', rest: '/tmp/my plugin' })
    expect(splitArgs('SCAN ./x')).toEqual({ sub: 'scan', rest: './x' })
    expect(splitArgs('')).toEqual({ sub: '', rest: '' })
  })
})

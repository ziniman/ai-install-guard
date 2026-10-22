import { describe, expect, test } from 'claude-code/testing'

import { splitArgs } from './register'
import { LIMITS, takeInventory } from './scan/inventory'
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

  test('records a symbolic link with where it lands and never reads through it', async () => {
    const files: FixtureFiles = {
      'README.md': text('hello\n'),
      'docs/inside': { link: '../README.md' },
      'docs/keys': { link: '../../../home/tester/.ssh/id_ed25519' },
    }
    const { inventory } = await takeInventory(memoryHost('/p/plugin', files), '/p/plugin')
    const links = inventory.entries.filter(entry => entry.kind === 'link')

    expect(links).toEqual([
      { kind: 'link', path: 'docs/inside', target: 'README.md', isInside: true },
      { kind: 'link', path: 'docs/keys', target: '/home/tester/.ssh/id_ed25519', isInside: false },
    ])
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

describe('arguments', () => {
  test('a quoted path keeps its spaces', () => {
    expect(splitArgs('  scan "/tmp/my plugin" ')).toEqual({ sub: 'scan', rest: '/tmp/my plugin' })
    expect(splitArgs('SCAN ./x')).toEqual({ sub: 'scan', rest: './x' })
    expect(splitArgs('')).toEqual({ sub: '', rest: '' })
  })
})

import type { EngineInterface, On, PluginRegisterInput } from 'claude-code'
import { describe, expect, mock, test, type Engine, type Plugin } from 'claude-code/testing'

import { failedLoad, heldReport, heldToast, judgeLoad, release, remember, toReview, type HeldMod } from './gate/load'
import { takeInventory } from './scan/inventory'
import { FIXTURES } from './test-support/fixtures.gen'
import { memoryHost, serveFixture, typed, type FixtureFiles } from './test-support/memfs'

const ROOT = '/plugins/notes'
const LABEL = 'notes@claude-plugin-test'

/** A mod that marks every prompt, so a test can tell whether it loaded. */
const NOTES: Plugin = {
  name: 'notes',
  register(on) {
    on('prompt.submit', ($, e, next) => next({ ...e, text: `${e.text} (notes)` }))
  },
}

function fixture(name: string): FixtureFiles {
  const files = FIXTURES[name]
  if (files === undefined) throw new Error(`no fixture ${name}`)
  return files
}

const MOD = fixture('mod-http-fetch')

/**
 * Serves `files` as the folder the test engine loads the inline plugin
 * `notes` from, wherever that is, and answers what the engine asks beneath
 * the plugins: a load allowed, a prompt as it arrived.
 */
function world(on: On, files: FixtureFiles, unreadable?: string): void {
  const inline = /^.*\/claude-plugin-test-[^/]+\/notes(?=\/|$)/
  serveFixture(on, ROOT, files, { moved: path => path.replace(inline, ROOT), unreadable: path => unreadable !== undefined && path === `${ROOT}/${unreadable}` })
  on('plugin.register', () => ({ allow: true }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
}

async function treeOf(files: FixtureFiles): Promise<string> {
  return (await takeInventory(memoryHost(ROOT, files), ROOT)).inventory.treeHash
}

function decision(treeHash: string, decision: 'approved' | 'rejected', target = LABEL) {
  return { target, root: ROOT, treeHash, verdict: 'No red flags', verdictKind: 'safe', decision, overridden: false, decidedAt: Date.UTC(2026, 9, 20) }
}

/** What the engine hands the load gate for the mod at ROOT. */
const LOADING: PluginRegisterInput = { name: 'notes', tier: 'user', root: ROOT, provenance: LABEL, uses: { events: ['prompt.submit'], calls: [] } }

/**
 * The little of `$` the load gate reads, for calling it directly: the test
 * engine's own `$` has no store. `files` are at ROOT, `decisions` are stored.
 */
function fakeGuard(files: FixtureFiles, decisions: unknown[]): EngineInterface {
  const host = memoryHost(ROOT, files)
  const toBase64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
  return {
    fs: {
      list: (path: string) => host.list(path),
      stat: (path: string, options?: { resolve: boolean }) => host.stat(path, options),
      read: async (path: string) => ({ base64: toBase64(await host.readBytes(path)) }),
    },
    store: { get: async (key: string) => (key === 'decisions' ? decisions : null) },
  } as unknown as EngineInterface
}

/**
 * Whether the mod loaded. The test engine loads the plugins at the first call
 * on `$`, and a plugin a gate refuses fails that call with the reason, which
 * `reason` keeps.
 */
async function loaded($: Engine, reason: string[] = []): Promise<boolean> {
  try {
    return (await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })).text === 'hi (notes)'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('notes: refused by ai-install-guard: ')) throw error
    reason.push(message.slice(message.indexOf('refused by ai-install-guard: ') + 'refused by ai-install-guard: '.length))
    return false
  }
}

const MARK = (pid: number) => ({ base64: btoa(`{"pid":${pid},"procStart":"Wed Oct 28 16:31:04 2026"}`) })

describe('the mod load gate', () => {
  test('a mod whose files you approved loads', { plugins: [NOTES] }, async ($, on) => {
    world(on, MOD)
    mock.store(on, { decisions: [decision(await treeOf(MOD), 'approved')] })

    expect(await loaded($)).toBe(true)
  })

  test('the same files approved through an install, at a commit, load too', { plugins: [NOTES] }, async ($, on) => {
    world(on, MOD)
    mock.store(on, { decisions: [{ ...decision(await treeOf(MOD), 'approved', 'notes@acme'), root: 'https://github.com/acme/notes.git', sha: 'a'.repeat(40) }] })

    expect(await loaded($)).toBe(true)
  })

  test('a mod you never approved is kept out', { plugins: [NOTES] }, async ($, on) => {
    world(on, MOD)
    mock.store(on)
    const reason: string[] = []

    expect(await loaded($, reason)).toBe(false)
    expect(reason).toEqual([`AI Install Guard kept ${LABEL} from loading: you have not approved these files. Review it in the guard's pane (/guard held), approve it, then run /reload-plugins.`])
  })

  test('a mod whose files changed since you approved it is kept out, and says so', { plugins: [NOTES] }, async ($, on) => {
    world(on, { ...MOD, 'hooks/extra.ts': { base64: btoa('export const x = 1\n') } })
    mock.store(on, { decisions: [decision(await treeOf(MOD), 'approved')] })
    const reason: string[] = []

    expect(await loaded($, reason)).toBe(false)
    expect(reason[0]).toContain('its files changed since you approved it on 2026-10-20')
  })

  test('a mod whose files you rejected stays out, and names the way to judge it again', { plugins: [NOTES] }, async ($, on) => {
    world(on, MOD)
    mock.store(on, { decisions: [decision(await treeOf(MOD), 'rejected')] })
    const reason: string[] = []

    expect(await loaded($, reason)).toBe(false)
    expect(reason).toEqual([`AI Install Guard kept ${LABEL} from loading: you rejected these files on 2026-10-20. /guard forget ${LABEL} judges them again.`])
  })

  test('the newest decision about the same files is the one that holds', { plugins: [NOTES] }, async ($, on) => {
    world(on, MOD)
    const tree = await treeOf(MOD)
    mock.store(on, { decisions: [{ ...decision(tree, 'approved'), decidedAt: 2 }, { ...decision(tree, 'rejected'), sha: 'b'.repeat(40), decidedAt: 1 }] })

    expect(await loaded($)).toBe(true)
  })

  test("Claude Code's in-use marks are not part of what was approved", { plugins: [NOTES] }, async ($, on) => {
    world(on, { ...MOD, '.in_use/17391': MARK(17391), '.in_use/36969': MARK(36969) })
    mock.store(on, { decisions: [decision(await treeOf(MOD), 'approved')] })

    expect(await loaded($)).toBe(true)
  })

  test('a mod that cannot be read is kept out', { plugins: [NOTES] }, async ($, on) => {
    world(on, { ...MOD, 'hooks/big.ts': { base64: btoa('x'.repeat(10)) } }, 'hooks/big.ts')
    mock.store(on)
    const reason: string[] = []

    expect(await loaded($, reason)).toBe(false)
    expect(reason[0]).toContain(`kept ${LABEL} from loading: its folder could not be read`)
  })

  test('when the guard itself fails, the mod stays out, and the refusal says what failed', { plugins: [NOTES] }, async ($, on) => {
    world(on, MOD)
    on('store.get', () => ({ deny: 'the store is gone' }))
    const reason: string[] = []

    expect(await loaded($, reason)).toBe(false)
    expect(reason[0]).toStartWith(`AI Install Guard kept ${LABEL} from loading: the guard failed while checking it (`)
    expect(reason[0]).toContain('the store is gone')
  })

  test("an administrator's managed mod loads as it is", { plugins: [{ ...NOTES, tier: 'append' }] }, async ($, on) => {
    world(on, MOD)
    mock.store(on)

    expect(await loaded($)).toBe(true)
  })
})

// The test engine cannot go on past a plugin it refused, so the session's
// side of a held mod is checked here in parts.
describe('the mods held in a session', () => {
  test('each folder is listed once, and the toast names them all', () => {
    const held: HeldMod[] = []
    remember(held, { label: LABEL, root: ROOT, treeHash: 'sha256:a', why: 'you have not approved these files' })
    remember(held, { label: LABEL, root: ROOT, treeHash: 'sha256:b', why: 'its files changed since you approved it on 2026-10-20' })
    remember(held, { label: 'tally@acme', root: '/plugins/tally', why: 'its folder could not be read (gone)' })

    expect(held.map(mod => mod.treeHash)).toEqual(['sha256:b', undefined])
    expect(heldToast(held)).toBe(`AI Install Guard kept 2 mods from loading: ${LABEL}, tally@acme. The pane shows the first to review: approve it, then run /reload-plugins. /guard held lists them all.`)
    // A mod that loads at a reload, approved since, leaves the list; another folder is left alone.
    release(held, '/plugins/other')
    release(held, ROOT)
    expect(held.map(mod => mod.label)).toEqual(['tally@acme'])
  })

  test('a rejected mod is named, never opened for review', () => {
    const rejected: HeldMod = { label: LABEL, root: ROOT, treeHash: 'sha256:a', why: 'you rejected these files on 2026-10-20', rejected: true }
    const open: HeldMod = { label: 'tally@acme', root: '/plugins/tally', treeHash: 'sha256:b', why: 'you have not approved these files' }

    expect(heldToast([rejected])).toBe(`AI Install Guard kept 1 mod from loading: ${LABEL}. You rejected its files; /guard held lists it.`)
    expect(toReview([rejected])).toBeUndefined()
    expect(toReview([rejected, open])).toBe(open)
  })

  test('a rejected mod is held, and /guard held says where each stands', async () => {
    const tree = await treeOf(MOD)
    const rejected = await judgeLoad(fakeGuard(MOD, [decision(tree, 'rejected')]), LOADING)
    if (rejected.kind !== 'refuse' || rejected.held === undefined) throw new Error('not held')
    expect(rejected.held).toEqual({ label: LABEL, root: ROOT, treeHash: tree, why: 'you rejected these files on 2026-10-20', rejected: true })

    const approved: HeldMod = { label: 'tally@acme', root: '/plugins/tally', treeHash: 'sha256:b', why: 'you have not approved these files' }
    const text = await heldReport(fakeGuard(MOD, [decision(tree, 'rejected'), decision('sha256:b', 'approved', 'tally@acme')]), [rejected.held, approved], false)
    expect(text).toBe(
      [
        'AI Install Guard kept 2 mods from loading in this session, and each is decided:',
        `  ${LABEL}: you rejected these files on 2026-10-20; /guard forget ${LABEL} judges them again`,
        '  tally@acme: approved; run /reload-plugins to load it',
      ].join('\n'),
    )
  })

  test('a failure in the guard names what failed', () => {
    expect(failedLoad(LOADING, { kind: 'timeout' })).toEqual({ label: LABEL, root: ROOT, why: 'the guard failed while checking it (it ran out of time)', reason: `AI Install Guard kept ${LABEL} from loading: the guard failed while checking it (it ran out of time).` })
    expect(failedLoad(LOADING, { kind: 'throw', message: 'bad\u202eline' }).why).toBe('the guard failed while checking it (bad<U+202E>line)')
  })

  test('with nothing held, /guard held says so', async ($, on) => {
    mock.store(on)
    on('command.register', ($, e) => ({ value: { command: e.name } }))

    expect((await $.command.run(typed('guard', 'held'))).text).toBe('AI Install Guard: no mod was kept from loading in this session.')
  })
})

describe("Claude Code's in-use marks", () => {
  test('are left out of the tree hash, and named as not read', async () => {
    // A mark half written when its session stopped is still one.
    const marked = await takeInventory(memoryHost(ROOT, { ...MOD, '.in_use/5693': MARK(5693), '.in_use/79014.tmp.c49eced0': MARK(79014) }), ROOT)
    expect(marked.inventory.treeHash).toBe(await treeOf(MOD))
    expect(marked.inventory.skipped).toEqual(['.in_use'])
  })

  test('count in full when anything else is there', async () => {
    const plain = await treeOf(MOD)
    const extras: FixtureFiles[] = [
      { '.in_use/5693': MARK(5693), '.in_use/hook.js': { base64: btoa('run()') } },
      { '.in_use/5693': { base64: btoa('{"pid":5693,"procStart":"x"};run()') } },
      { '.in_use/5693': MARK(42) },
      { '.in_use/42.tmp.c49eced0': MARK(5693) },
      { '.in_use/5693.js': MARK(5693) },
      { '.in_use/5693': { link: '../hooks/register.ts' } },
      { 'nested/.in_use/5693': MARK(5693) },
    ]
    for (const extra of extras) {
      expect(await treeOf({ ...MOD, ...extra })).not.toBe(plain)
    }
  })
})

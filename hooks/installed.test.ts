import type { On } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'

import { checkToast } from './gate/installed'
import { PANE_ID } from './guard/view'
import { takeInventory } from './scan/inventory'
import { FIXTURES } from './test-support/fixtures.gen'
import { HOME, memoryHost, paneProps, serveFixture, serveUi, typed, type FixtureFiles } from './test-support/memfs'

const CACHE = `${HOME}/.claude/plugins/cache`
const PROJECT = `${HOME}/proj`

function fixture(name: string): FixtureFiles {
  const files = FIXTURES[name]
  if (files === undefined) throw new Error(`no fixture ${name}`)
  return files
}

/** No red flags, and no hooks module. */
const CLEAN = fixture('clean-plugin')
/** A mod with no red flags. */
const MOD = fixture('mod-http-fetch')
/** Worth a look: a skill that brings in text from a web address as it loads. */
const FLAGGED = fixture('skill-inline-fetch')

/** One plugin as Claude Code lists it, and its files. */
type Plugin = { id: string; files: FixtureFiles; enabled?: boolean; scope?: string }

/** Where Claude Code installs a plugin: `<marketplace>/<name>/<version>` under its cache. */
function folderOf(id: string): string {
  const [name, marketplace] = id.split('@')
  return `${marketplace}/${name}/1.0.0`
}

function rootOf(id: string): string {
  return `${CACHE}/${folderOf(id)}`
}

async function treeOf(files: FixtureFiles): Promise<string> {
  return (await takeInventory(memoryHost('/p', files), '/p')).inventory.treeHash
}

function decision(id: string, treeHash: string, decision: 'approved' | 'rejected') {
  return { target: id, root: rootOf(id), treeHash, verdict: 'No red flags', verdictKind: 'safe', decision, overridden: false, decidedAt: Date.UTC(2026, 9, 20) }
}

/**
 * The plugins laid out where Claude Code installs them, its listing of them,
 * and what the engine answers beneath the plugins. `commands` records each
 * slash command the guard runs as the person; `listed` counts the listings.
 */
function world(on: On, plugins: Plugin[], options: { listing?: 'fails'; unreadable?: (path: string) => boolean } = {}): { commands: string[]; listed: () => number } {
  const files: FixtureFiles = {}
  for (const plugin of plugins) for (const [rel, file] of Object.entries(plugin.files)) files[`${folderOf(plugin.id)}/${rel}`] = file
  let listings = 0
  serveFixture(on, CACHE, files, {
    unreadable: options.unreadable,
    run: argv => {
      if (argv.join(' ') === 'claude plugin list --json') {
        listings += 1
        if (options.listing === 'fails') return { exitCode: 1, stdout: '', stderr: 'Error: the plugins file is damaged' }
        return { exitCode: 0, stdout: JSON.stringify(plugins.map(plugin => ({ id: plugin.id, version: '1.0.0', scope: plugin.scope ?? 'user', enabled: plugin.enabled ?? true, installPath: rootOf(plugin.id) }))), stderr: '' }
      }
      if (argv[0] === 'claude') return { exitCode: 127, stdout: '', stderr: 'test: no claude here' }
      return undefined
    },
  })
  const commands: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.run', ($, e) => (commands.push(`/${e.command} ${e.args}`), { text: '' }))
  return { commands, listed: () => listings }
}

/**
 * The guard's store, seeded with `seed`, as a map the test can read. The
 * first check on this machine has run, unless `seed` says otherwise.
 */
function store(on: On, seed: Record<string, unknown> = {}): Map<string, unknown> {
  const stored = new Map<string, unknown>(Object.entries({ 'plugins-baseline': Date.UTC(2026, 9, 1), ...seed }))
  on('store.get', ($, e) => ({ value: stored.get(e.key) }))
  on('store.set', ($, e) => (stored.set(e.key, e.value), { value: undefined }))
  on('store.delete', ($, e) => (stored.delete(e.key), { value: undefined }))
  return stored
}

/** A session starting with a person at the prompt, then /guard held, which waits for the check to finish. */
async function start($: Engine, isInteractive = true): Promise<string> {
  await $.session.start({ cwd: PROJECT, surface: isInteractive ? 'terminal' : null, isInteractive })
  return (await $.command.run(typed('guard', 'held'))).text ?? ''
}

const mountPane = ($: Engine) => $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })

describe('gate F: the plugins on at the start of a session', () => {
  test('a plugin with no red flags is named once, and nothing waits', async ($, on) => {
    world(on, [{ id: 'notes@acme', files: CLEAN }])
    const stored = store(on)
    const ui = serveUi(on)

    const held = await start($)
    expect(ui.toasts).toEqual(['AI Install Guard checked 1 plugin new since it last looked: no red flags (notes@acme).'])
    expect(ui.opened).toEqual([])
    expect(held).toBe('AI Install Guard: no mod was kept from loading in this session, and no plugin on waits for a decision.')
    // Remembered, so the next session names it no more.
    expect(stored.get('skills-checked')).toEqual([await treeOf(CLEAN)])
  })

  test('files checked before, or approved, are not scanned or named again', async ($, on) => {
    world(on, [
      { id: 'notes@acme', files: CLEAN },
      { id: 'watch@acme', files: MOD },
    ])
    store(on, { 'skills-checked': [await treeOf(CLEAN)], decisions: [decision('watch@acme', await treeOf(MOD), 'approved')] })
    const ui = serveUi(on)

    await start($)
    expect(ui.toasts).toEqual([])
    expect(ui.opened).toEqual([])
  })

  test('a plugin with a red flag waits in the pane, and Turn off turns it off as your own /plugin command', async ($, on) => {
    const { commands } = world(on, [{ id: 'notes@acme', files: FLAGGED }])
    const stored = store(on)
    const ui = serveUi(on)

    const held = await start($)
    expect(ui.toasts[0]).toBe('AI Install Guard found 1 plugin on that you have not approved: notes@acme. The pane shows the first: keep it, or turn it off. /guard held lists them all.')
    expect(ui.opened).toContain(PANE_ID)
    expect(held).toContain('notes@acme: Worth a look')

    const pane = await mountPane($)
    expect(await pane.find({ type: 'Text', text: 'On in this session, not approved: notes@acme' })).toBeDefined()
    expect(await pane.find({ key: 'install' })).toMatchObject({ props: { label: 'Keep' } })
    expect(await pane.find({ key: 'reject' })).toMatchObject({ props: { label: 'Turn off' } })
    await pane.press({ key: 'reject' })
    expect(ui.toasts).toContain('AI Install Guard: rejected notes@acme; turning it off')
    expect(commands).toEqual(['/plugin disable notes@acme'])
    expect(stored.get('decisions')).toMatchObject([{ target: 'notes@acme', decision: 'rejected', treeHash: await treeOf(FLAGGED) }])
    await pane.unmount()
  })

  test('a mod whose files you never approved waits too, though it has no red flags, and Keep keeps it on', async ($, on) => {
    const { commands } = world(on, [{ id: 'watch@acme', files: MOD }])
    const stored = store(on)
    const ui = serveUi(on)

    const held = await start($)
    expect(held).toContain('watch@acme: a mod whose files you have not approved')
    const pane = await mountPane($)
    await pane.press({ key: 'install' })
    expect(ui.toasts).toContain('AI Install Guard: kept watch@acme; it stays on')
    expect(commands).toEqual([])
    expect(stored.get('decisions')).toMatchObject([{ target: 'watch@acme', decision: 'approved', treeHash: await treeOf(MOD) }])
    await pane.unmount()
    // Kept: /guard held says so, and opens nothing more.
    const opened = ui.opened.length
    expect((await $.command.run(typed('guard', 'held'))).text).toContain('watch@acme: kept')
    expect(ui.opened.length).toBe(opened)
  })

  test('a mod approved before, whose files changed since, says so', async ($, on) => {
    world(on, [{ id: 'watch@acme', files: MOD }])
    store(on, { decisions: [decision('watch@acme', 'f'.repeat(64), 'approved')] })
    serveUi(on)

    expect(await start($)).toContain('watch@acme: a mod whose files you have not approved; its files changed since you approved it on 2026-10-20')
  })

  test('a plugin whose files you rejected is named, never opened in the pane again', async ($, on) => {
    world(on, [{ id: 'notes@acme', files: FLAGGED }])
    store(on, { decisions: [decision('notes@acme', await treeOf(FLAGGED), 'rejected')] })
    const ui = serveUi(on)

    const held = await start($)
    expect(ui.toasts).toEqual(['AI Install Guard found 1 plugin on that you have not approved: notes@acme. You rejected its files: turn it off in /plugin. /guard held lists it.'])
    expect(ui.opened).toEqual([])
    expect(held).toContain('notes@acme: you rejected these files on 2026-10-20; /plugin disable notes@acme turns it off if it is still on')
    expect(held).toContain('Each is decided.')
  })

  test('a plugin turned off, and an administrator’s, are not read', async ($, on) => {
    world(on, [
      { id: 'notes@acme', files: FLAGGED, enabled: false },
      { id: 'policy@corp', files: FLAGGED, scope: 'managed' },
    ])
    store(on)
    const ui = serveUi(on)

    await start($)
    expect(ui.toasts).toEqual([])
    expect(ui.opened).toEqual([])
  })

  test('a folder that cannot be read waits as Could not verify, and Turn off still turns it off', async ($, on) => {
    // Listed where nothing is: the folder is gone.
    const notes: Plugin = { id: 'notes@acme', files: {} }
    const { commands } = world(on, [notes])
    store(on)
    const ui = serveUi(on)

    const held = await start($)
    expect(held).toContain('notes@acme: its folder could not be read')
    const pane = await mountPane($)
    await pane.press({ key: 'reject' })
    expect(commands).toEqual(['/plugin disable notes@acme'])
    expect(ui.toasts).toContain('AI Install Guard: rejected notes@acme; turning it off')
    await pane.unmount()
    // Turned off, it waits no more: /guard held leaves it out and opens nothing.
    notes.enabled = false
    const opened = ui.opened.length
    expect((await $.command.run(typed('guard', 'held'))).text).toBe('AI Install Guard: no mod was kept from loading in this session, and no plugin on waits for a decision.')
    expect(ui.opened.length).toBe(opened)
  })

  test('files that cannot be read as they are scanned wait as Could not verify, never named as checked', async ($, on) => {
    let reads = 0
    world(on, [{ id: 'notes@acme', files: CLEAN }], { unreadable: path => path === `${rootOf('notes@acme')}/README.md` && ++reads > 1 })
    const stored = store(on)
    serveUi(on)

    const held = await start($)
    expect(held).toContain('notes@acme: the scan could not read it (ai-install-guard: $.fs.read: the file cannot be read)')
    expect(stored.get('skills-checked')).toBeUndefined()
  })

  test('the pane is never taken from a verdict still waiting for you: the toast points to /guard held', async ($, on) => {
    world(on, [
      { id: 'notes@acme', files: FLAGGED },
      { id: 'other@acme', files: FLAGGED, enabled: false },
    ])
    store(on)
    const ui = serveUi(on)
    // A scan you asked for, its verdict in the pane and not yet decided.
    await $.command.run(typed('guard', `scan ${rootOf('other@acme')}`))
    const before = ui.toasts.length
    const opened = ui.opened.length

    // Nor does /guard held take it: it says to decide it first.
    const held = await start($)
    expect(ui.toasts[before]).toBe('AI Install Guard found 1 plugin on that you have not approved: notes@acme. /guard held lists them and opens the first in the pane.')
    expect(held).toContain("The guard's pane holds a verdict still waiting for you: decide it (/guard report reopens it), then run /guard held again to open the next one.")
    expect(ui.opened.length).toBe(opened)
  })

  test('a listing that fails is named, and nothing is held', async ($, on) => {
    world(on, [{ id: 'notes@acme', files: FLAGGED }], { listing: 'fails' })
    store(on)
    const ui = serveUi(on)

    await start($)
    expect(ui.toasts).toEqual(['AI Install Guard could not check the plugins that are on: could not read the installed plugins: Error: the plugins file is damaged'])
  })

  test('a headless run is not checked: it has no pane to show what it finds', async ($, on) => {
    const { listed } = world(on, [{ id: 'notes@acme', files: FLAGGED }])
    store(on)
    const ui = serveUi(on)

    await start($, false)
    expect(listed()).toBe(0)
    expect(ui.toasts).toEqual([])
  })

  test('the first check on this machine names what was already on, opens no pane, and does not name it again', async ($, on) => {
    world(on, [
      { id: 'notes@acme', files: CLEAN },
      { id: 'tips@acme', files: FLAGGED },
      { id: 'watch@acme', files: MOD },
    ])
    const stored = store(on, { 'plugins-baseline': undefined })
    const ui = serveUi(on)

    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true })
    // /guard held waits for the check to finish.
    await $.command.run(typed('guard', 'held'))
    expect(ui.toasts[0]).toBe(
      'AI Install Guard looked at the 3 plugins already on that it had not checked: 1 with no red flags, and 2 worth your look when you like: tips@acme, watch@acme. /guard held opens them one at a time. From now on, it checks a plugin that is new or changed as a session starts.',
    )
    // Each named once: the next session goes by them in silence, and /guard held still lists the two that wait.
    expect(stored.get('skills-checked')).toEqual([await treeOf(CLEAN)])
    expect(stored.get('plugins-baseline')).toEqual({
      at: expect.any(Number),
      waiting: [
        { treeHash: await treeOf(FLAGGED), why: 'Worth a look' },
        { treeHash: await treeOf(MOD), why: 'a mod whose files you have not approved' },
      ],
    })
  })

  test('what the first check named waits quietly in later sessions: no toast, no pane, but /guard held opens it', async ($, on) => {
    world(on, [{ id: 'tips@acme', files: FLAGGED }])
    store(on, { 'plugins-baseline': { at: Date.UTC(2026, 9, 1), waiting: [{ treeHash: await treeOf(FLAGGED), why: 'Worth a look' }] } })
    const ui = serveUi(on)

    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true })
    const held = (await $.command.run(typed('guard', 'held'))).text
    expect(ui.toasts.filter(toast => toast.startsWith('AI Install Guard found') || toast.startsWith('AI Install Guard looked'))).toEqual([])
    expect(held).toContain('tips@acme: Worth a look')
    expect(held).toContain("tips@acme is in the guard's pane: keep it, or turn it off there.")
  })

  test('the first check opens no pane of its own, though /guard held opens the first to look at', async ($, on) => {
    world(on, [{ id: 'tips@acme', files: FLAGGED }])
    store(on, { 'plugins-baseline': undefined })
    const ui = serveUi(on)

    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true })
    const opened = ui.opened.length
    const held = (await $.command.run(typed('guard', 'held'))).text
    expect(opened).toBe(0)
    expect(held).toContain('tips@acme is in the guard\'s pane: keep it, or turn it off there.')
    expect(ui.opened).toContain(PANE_ID)
  })

  test('a plugin you rejected that is on all the same is named once', async ($, on) => {
    world(on, [{ id: 'notes@acme', files: FLAGGED }])
    const stored = store(on, { decisions: [decision('notes@acme', await treeOf(FLAGGED), 'rejected')] })
    serveUi(on)

    await start($)
    expect(stored.get('skills-checked')).toEqual([`rejected ${await treeOf(FLAGGED)} ${Date.UTC(2026, 9, 20)}`])
  })

  test('the same files rejected again, after an approval, are named again', async ($, on) => {
    world(on, [{ id: 'notes@acme', files: FLAGGED }])
    store(on, { 'skills-checked': [`rejected ${await treeOf(FLAGGED)} ${Date.UTC(2026, 9, 2)}`], decisions: [decision('notes@acme', await treeOf(FLAGGED), 'rejected')] })
    const ui = serveUi(on)

    await start($)
    expect(ui.toasts).toEqual(['AI Install Guard found 1 plugin on that you have not approved: notes@acme. You rejected its files: turn it off in /plugin. /guard held lists it.'])
  })

  test('files checked before with no red flags, and rejected since, are named once all the same', async ($, on) => {
    world(on, [{ id: 'notes@acme', files: CLEAN }])
    const stored = store(on, { 'skills-checked': [await treeOf(CLEAN)], decisions: [decision('notes@acme', await treeOf(CLEAN), 'rejected')] })
    const ui = serveUi(on)

    const held = await start($)
    expect(ui.toasts).toEqual(['AI Install Guard found 1 plugin on that you have not approved: notes@acme. You rejected its files: turn it off in /plugin. /guard held lists it.'])
    expect(held).toContain('notes@acme: you rejected these files on 2026-10-20')
    expect(stored.get('skills-checked')).toEqual([`rejected ${await treeOf(CLEAN)} ${Date.UTC(2026, 9, 20)}`, await treeOf(CLEAN)])
  })

  test('a second start in the same session, at a reload, does not check again', async ($, on) => {
    const { listed } = world(on, [{ id: 'notes@acme', files: CLEAN }])
    store(on)
    serveUi(on)

    await start($)
    await start($)
    expect(listed()).toBe(1)
  })
})

describe('the toast at the end of the check', () => {
  const found = (label: string, rejected?: true) => ({ id: label, label, root: `/p/${label}`, why: 'Worth a look', ...(rejected === undefined ? {} : { rejected }) })

  test('what waits comes first, then what was checked', () => {
    expect(checkToast({ found: [found('a@m'), found('b@m')], checked: ['c@m'], baseline: false }, true)).toBe(
      'AI Install Guard found 2 plugins on that you have not approved: a@m, b@m. The pane shows the first: keep it, or turn it off. /guard held lists them all. AI Install Guard checked 1 plugin new since it last looked: no red flags (c@m).',
    )
  })

  test('the first check: what was already on, all with no red flags', () => {
    expect(checkToast({ found: [], checked: ['a@m', 'b@m'], baseline: true }, false)).toBe(
      'AI Install Guard looked at the 2 plugins already on that it had not checked: no red flags. From now on, it checks a plugin that is new or changed as a session starts.',
    )
    expect(checkToast({ found: [], checked: [], baseline: true }, false)).toBeUndefined()
  })

  test('nothing to say is no toast', () => {
    expect(checkToast({ found: [], checked: [], baseline: false }, false)).toBeUndefined()
  })

  test('only rejected files: turn them off', () => {
    expect(checkToast({ found: [found('a@m', true), found('b@m', true)], checked: [], baseline: false }, false)).toBe(
      'AI Install Guard found 2 plugins on that you have not approved: a@m, b@m. You rejected their files: turn them off in /plugin. /guard held lists them.',
    )
  })
})

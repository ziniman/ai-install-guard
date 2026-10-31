import type { On } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'

import { configToast, rejectedNote } from './gate/configured'
import { mcpCandidate, settingsTree } from './gate/gate'
import { runsOf, stable } from './gate/settings'
import { PANE_ID } from './guard/view'
import { takeInventory } from './scan/inventory'
import { virtualHost } from './scan/virtual-host'
import { HOME, paneProps, serveFixture, serveUi, typed, type FixtureFiles } from './test-support/memfs'

const PROJECT = `${HOME}/proj`
const USER_CONFIG = `${HOME}/.claude.json`
const USER_SETTINGS = `${HOME}/.claude/settings.json`
const PROJECT_SETTINGS = `${PROJECT}/.claude/settings.json`

/** Starts a program the scan reads no further: nothing to flag. */
const PLAIN = { command: 'node', args: ['/opt/notes/server.js'] }
/** Worth a look: a package fetched as it starts, at whatever version is newest. */
const LOOSE = { command: 'npx', args: ['-y', '@acme/notes'] }
/** A settings file that runs a command before each shell command. */
const HOOKED = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo checked' }] }] } }

const b64 = (value: unknown) => ({ base64: btoa(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) })

/** The tree hash a server's decisions are kept under, laid out as the gates lay it out. */
async function serverHash(name: string, scope: string, server: Record<string, unknown>): Promise<string> {
  const how = mcpCandidate([{ name, scope, server }])
  return (await takeInventory(virtualHost(how.root, how.files), how.root)).inventory.treeHash
}

/** The tree hash a settings file's decisions are kept under: what it runs, or the whole file as the write gate pins it. */
async function settingsHash(path: string, settings: Record<string, unknown>, whole = false): Promise<string> {
  return (await settingsTree(path, whole ? JSON.stringify(settings, null, 2) : stable(runsOf(settings)))).hash
}

function decision(target: string, treeHash: string, decision: 'approved' | 'rejected') {
  return { target, root: '/ai-install-guard/mcp-server/notes', treeHash, verdict: 'Worth a look', verdictKind: 'caution', decision, overridden: false, decidedAt: Date.UTC(2026, 9, 20) }
}

/**
 * The configuration laid out in the home folder, no plugin installed, and
 * what the engine answers beneath the plugins. `tools` records each tool
 * call that reached the engine.
 */
function world(on: On, files: FixtureFiles, options: { unreadable?: (path: string) => boolean; statFails?: (path: string) => boolean } = {}): { tools: string[] } {
  serveFixture(on, HOME, files, {
    unreadable: options.unreadable,
    statFails: options.statFails,
    run: argv => {
      if (argv.join(' ') === 'claude plugin list --json') return { exitCode: 0, stdout: '[]', stderr: '' }
      if (argv[0] === 'claude') return { exitCode: 127, stdout: '', stderr: 'test: no claude here' }
      return undefined
    },
  })
  const tools: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.run', () => ({ text: '' }))
  on('tool.call', ($, e) => (tools.push(e.tool), { result: { content: [] } }))
  return { tools }
}

/** The guard's store, seeded with `seed`, as a map the test can read. The first checks on this machine have run, unless `seed` says otherwise. */
function store(on: On, seed: Record<string, unknown> = {}): Map<string, unknown> {
  const stored = new Map<string, unknown>(Object.entries({ 'plugins-baseline': { at: 1, waiting: [] }, 'config-baseline': { at: 1, waiting: [] }, ...seed }))
  on('store.get', ($, e) => ({ value: stored.get(e.key) }))
  on('store.set', ($, e) => (stored.set(e.key, e.value), { value: undefined }))
  on('store.delete', ($, e) => (stored.delete(e.key), { value: undefined }))
  return stored
}

const held = async ($: Engine): Promise<string> => (await $.command.run(typed('guard', 'held'))).text ?? ''

/** A session starting in `cwd` with a person at the prompt, then /guard held, which waits for the check to finish. */
async function start($: Engine, cwd = PROJECT): Promise<string> {
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
  return held($)
}
const mountPane = ($: Engine) => $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })
/** A call to a configured server's tool. The declared MCP tools are this machine's, so the name is typed as the engine's own input. */
const mcpTool = (tool: string) => ({ tool, query: 'today' }) as unknown as Parameters<Engine['tool']['call']>[0]

describe('gate F: your configuration at the start of a session', () => {
  test('a server with no red flags is named once, and nothing waits', async ($, on) => {
    world(on, { '.claude.json': b64({ mcpServers: { notes: PLAIN } }) })
    const stored = store(on)
    const ui = serveUi(on)

    expect(await start($)).toBe('AI Install Guard: no mod was kept from loading in this session, and no plugin or configuration waits for a decision.')
    expect(ui.toasts).toEqual(['AI Install Guard checked 1 MCP server new since it last looked: no red flags (MCP server notes (user scope)).'])
    expect(ui.opened).toEqual([])
    expect(stored.get('skills-checked')).toEqual([await serverHash('notes', 'user', PLAIN)])
  })

  test('a server checked before, or approved as Claude added it, is not scanned or named again', async ($, on) => {
    world(on, { '.claude.json': b64({ mcpServers: { notes: PLAIN }, projects: { [PROJECT]: { mcpServers: { search: LOOSE } } } }) })
    store(on, { 'skills-checked': [await serverHash('notes', 'user', PLAIN)], decisions: [decision('MCP server search', await serverHash('search', `local ${PROJECT}`, LOOSE), 'approved')] })
    const ui = serveUi(on)

    await start($)
    expect(ui.toasts).toEqual([])
    expect(ui.opened).toEqual([])
  })

  test("a server with a red flag waits in the pane; Reject refuses its tools and says how to remove it", async ($, on) => {
    const { tools } = world(on, { '.claude.json': b64({ projects: { [PROJECT]: { mcpServers: { notes: LOOSE } }, '/elsewhere': { mcpServers: { other: LOOSE } } } }) })
    const stored = store(on)
    const ui = serveUi(on)

    await start($)
    // Only this folder's servers are this session's.
    expect(ui.toasts).toContain('AI Install Guard found 1 MCP server in your configuration that you have not approved: MCP server notes (local scope). The pane shows the first: keep it, or reject it. /guard held lists them all.')
    expect(ui.opened).toContain(PANE_ID)
    expect((await $.tool.call(mcpTool('mcp__notes__search'))).deny).toBeUndefined()

    const pane = await mountPane($)
    expect(await pane.find({ type: 'Text', text: 'In your configuration, not approved: MCP server notes (local scope)' })).toBeDefined()
    expect(await pane.find({ key: 'install' })).toMatchObject({ props: { label: 'Keep' } })
    expect(await pane.find({ key: 'reject' })).toMatchObject({ props: { label: 'Reject' } })
    await pane.press({ key: 'reject' })
    expect(ui.toasts).toContain('AI Install Guard: rejected MCP server notes (local scope); the guard refuses its tools; claude mcp remove notes -s local, run in this folder, removes it')
    expect(stored.get('decisions')).toMatchObject([{ decision: 'rejected', treeHash: await serverHash('notes', `local ${PROJECT}`, LOOSE) }])

    const refused = await $.tool.call(mcpTool('mcp__notes__search'))
    expect(refused.deny).toBe('AI Install Guard refused this tool: it comes from the MCP server notes (local scope), which the person rejected. Tell the person; the guard refuses its tools; claude mcp remove notes -s local, run in this folder, removes it.')
    // Another server's tools, and a name that only starts the same, go on.
    expect((await $.tool.call(mcpTool('mcp__notes_two__search'))).deny).toBeUndefined()
    expect(tools).toEqual(['mcp__notes__search', 'mcp__notes_two__search'])
    expect(await held($)).toContain('MCP server notes (local scope): you rejected it on ')
  })

  test('a server you rejected before stays refused in a later session, named once', async ($, on) => {
    const hash = await serverHash('notes', `project ${PROJECT}`, LOOSE)
    const { tools } = world(on, { 'proj/.mcp.json': b64({ mcpServers: { notes: LOOSE } }) })
    store(on, { decisions: [decision('MCP server notes', hash, 'rejected')], 'skills-checked': [`rejected ${hash} ${Date.UTC(2026, 9, 20)}`] })
    const ui = serveUi(on)

    await start($)
    expect(ui.toasts).toEqual([])
    expect(ui.opened).toEqual([])
    expect((await $.tool.call(mcpTool('mcp__notes__search'))).deny).toContain('it comes from the MCP server notes (project scope), which the person rejected')
    expect(tools).toEqual([])
    expect(await held($)).toContain('MCP server notes (project scope): you rejected it on 2026-10-20; the guard refuses its tools; claude mcp remove notes -s project removes it')
  })

  test('a settings file that runs a command waits, and Keep approves what it runs, whatever else changes in it', async ($, on) => {
    world(on, { 'proj/.claude/settings.json': b64({ theme: 'dark', ...HOOKED }) })
    const stored = store(on)
    const ui = serveUi(on)

    await start($)
    expect(ui.toasts).toContain(`AI Install Guard found 1 settings file in your configuration that you have not approved: settings file ${PROJECT_SETTINGS}. The pane shows the first: keep it, or reject it. /guard held lists them all.`)
    const pane = await mountPane($)
    expect(await pane.find({ type: 'Text', text: 'What this file runs on its own' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /runs echo checked on PreToolUse/ })).toBeDefined()
    await pane.press({ key: 'install' })
    expect(ui.toasts).toContain(`AI Install Guard: kept settings file ${PROJECT_SETTINGS}`)
    // Pinned to what it runs, so a theme changed later asks nothing.
    expect(stored.get('decisions')).toMatchObject([{ decision: 'approved', treeHash: await settingsHash(PROJECT_SETTINGS, HOOKED), root: PROJECT_SETTINGS }])
  })

  test('a settings file changed since you approved it shows only what changed', async ($, on) => {
    const before = HOOKED
    const after = { hooks: { ...HOOKED.hooks, Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }
    world(on, { '.claude/settings.json': b64(after) })
    store(on, { decisions: [decision('settings', await settingsHash(USER_SETTINGS, before), 'approved')], 'settings-kept': [{ path: USER_SETTINGS, runs: stable(runsOf(before)) }] })
    serveUi(on)

    await start($)
    const pane = await mountPane($)
    expect(await pane.find({ type: 'Text', text: 'What changed in what it runs since you approved it' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /runs say done on Stop/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /echo checked/ })).toBeUndefined()
  })

  test('a settings file Claude changed and you approved at the write gate is not asked about again', async ($, on) => {
    world(on, { '.claude/settings.json': b64(HOOKED) })
    const stored = store(on, { decisions: [decision('settings', await settingsHash(USER_SETTINGS, HOOKED, true), 'approved')] })
    const ui = serveUi(on)

    await start($)
    expect(ui.toasts).toEqual([])
    expect(stored.get('settings-kept')).toEqual([{ path: USER_SETTINGS, runs: stable(runsOf(HOOKED)) }])
  })

  test('settings that run nothing, and a folder whose settings are your own, are read once and judged by what runs', async ($, on) => {
    world(on, { '.claude/settings.json': b64({ theme: 'dark', hooks: {} }) })
    store(on)
    const ui = serveUi(on)

    await start($, HOME)
    expect(ui.toasts).toEqual([])
  })

  test('a configuration file the guard cannot read is named as Could not verify', async ($, on) => {
    world(on, { '.claude.json': b64({ mcpServers: { notes: PLAIN } }) }, { unreadable: path => path === USER_CONFIG })
    store(on)
    const ui = serveUi(on)

    await start($)
    expect(ui.toasts).toContain(`AI Install Guard found 1 configuration file in your configuration that you have not approved: ${USER_CONFIG}. The pane shows the first: keep it, or reject it. /guard held lists them all.`)
    const pane = await mountPane($)
    expect(await pane.find({ type: 'Text', text: 'Could not verify' })).toBeDefined()
  })

  test('the first check on a machine names everything in one note and opens no pane; /guard held opens them later', async ($, on) => {
    world(on, { '.claude.json': b64({ mcpServers: { notes: PLAIN, search: LOOSE } }), '.claude/settings.json': b64(HOOKED) })
    const stored = store(on, { 'config-baseline': undefined })
    const ui = serveUi(on)

    const answer = await start($)
    expect(stored.get('config-baseline')).toMatchObject({ waiting: [{ why: 'Worth a look' }, { why: 'Worth a look' }] })
    // The note says /guard held opens them: the check opened none itself.
    expect(ui.toasts[0]).toBe(
      `AI Install Guard looked at the 2 MCP servers and 1 settings file in your configuration that it had not checked: 1 with no red flags, and 2 worth your look when you like: MCP server search (user scope), settings file ${USER_SETTINGS}. /guard held opens them one at a time. From now on, it checks one that is new or changed as a session starts.`,
    )
    expect(answer).toContain('found these in your configuration that you have not approved:\n  MCP server search (user scope): Worth a look\n  settings file')
    expect(answer).toContain("The MCP server search (user scope) is in the guard's pane")
    expect(ui.opened).toContain(PANE_ID)
  })

  test("a rejected server's tools are refused from a session's first call, before any check, and in a headless run", async ($, on) => {
    const hash = await serverHash('notes', 'user', LOOSE)
    const { tools } = world(on, { '.claude.json': b64({ mcpServers: { notes: LOOSE } }) })
    store(on, { decisions: [decision('MCP server notes', hash, 'rejected')] })
    serveUi(on)

    await $.session.start({ cwd: PROJECT, surface: null, isInteractive: false })
    expect((await $.tool.call(mcpTool('mcp__notes__search'))).deny).toContain('it comes from the MCP server notes (user scope), which the person rejected')
    // Plugins' servers and Claude Code's own tools go on, with nothing read for them.
    expect((await $.tool.call(mcpTool('mcp__plugin_notes_notes__search'))).deny).toBeUndefined()
    expect(tools).toEqual(['mcp__plugin_notes_notes__search'])
  })

  test('a server approved as `claude mcp add` added it, or under the real name of a linked folder, counts as approved', async ($, on) => {
    const added = { command: 'npx', args: ['-y', '@acme/notes'] }
    // As Claude Code saves it: its type named, and an empty environment.
    const saved = { type: 'stdio', ...added, env: {} }
    world(on, { proj: { link: 'real' }, 'real/README.md': b64('A project.'), '.claude.json': b64({ projects: { [`${HOME}/real`]: { mcpServers: { notes: saved, search: LOOSE } } } }) })
    store(on, { decisions: [decision('MCP server notes', await serverHash('notes', 'local', added), 'approved')] })
    const ui = serveUi(on)

    await start($)
    // Found under the folder's real name, and only the one never approved waits.
    expect(ui.toasts).toContain('AI Install Guard found 1 MCP server in your configuration that you have not approved: MCP server search (local scope). The pane shows the first: keep it, or reject it. /guard held lists them all.')
  })

  test('several servers Claude writes at once are approved for each, as the check finds them one at a time', async ($, on) => {
    world(on, {})
    const stored = store(on)
    serveUi(on)

    const config = { mcpServers: { notes: LOOSE, search: { command: 'npx', args: ['-y', '@acme/search'] } } }
    const refused = await $.tool.call({ tool: 'Write', file_path: `${PROJECT}/.mcp.json`, content: JSON.stringify(config) })
    expect(refused.deny).toContain('held this')
    const pane = await mountPane($)
    await pane.press({ key: 'install' })
    const kept = (stored.get('decisions') as { treeHash: string; decision: string }[]).filter(item => item.decision === 'approved').map(item => item.treeHash)
    expect(kept).toEqual(expect.arrayContaining([await serverHash('notes', `project ${PROJECT}`, LOOSE), await serverHash('search', `project ${PROJECT}`, config.mcpServers.search)]))
  })

  test('a settings file whose last approved hook is taken away, or that sets a variable that changes what runs, waits', async ($, on) => {
    world(on, { '.claude/settings.json': b64({ theme: 'dark' }), 'proj/.claude/settings.json': b64({ env: { NODE_OPTIONS: '--require /tmp/x.js', EDITOR: 'vim' } }) })
    store(on, { 'settings-kept': [{ path: USER_SETTINGS, runs: stable(runsOf(HOOKED)) }] })
    serveUi(on)

    const answer = await start($)
    expect(answer).toContain(`settings file ${USER_SETTINGS}: Worth a look`)
    expect(answer).toContain(`settings file ${PROJECT_SETTINGS}: Do not install`)
    const pane = await mountPane($)
    expect(await pane.find({ type: 'Text', text: /no longer runs echo checked on PreToolUse/ })).toBeDefined()
  })

  test('a file the guard may not look at is named, not taken as missing, and one readable again is no longer listed', async ($, on) => {
    let broken = true
    world(on, { '.claude.json': b64({ mcpServers: { notes: PLAIN } }) }, { statFails: path => broken && path === USER_CONFIG })
    store(on, { 'skills-checked': [await serverHash('notes', 'user', PLAIN)] })
    serveUi(on)

    const answer = await start($)
    expect(answer).toContain(`${USER_CONFIG}: the guard could not look at it (`)
    expect(answer).toContain('EACCES: permission denied')
    broken = false
    expect(await held($)).toBe('AI Install Guard: no mod was kept from loading in this session, and no plugin or configuration waits for a decision.')
  })

  test('a headless run checks nothing', async ($, on) => {
    world(on, { '.claude.json': b64({ mcpServers: { search: LOOSE } }) })
    const stored = store(on)
    const ui = serveUi(on)

    await $.session.start({ cwd: PROJECT, surface: null, isInteractive: false })
    expect(ui.toasts).toEqual([])
    expect(stored.has('skills-checked')).toBe(false)
  })
})

describe('what Reject says, and what the guard keeps', () => {
  test('a server the guard could not check claims no refusal', () => {
    const request = { origin: 'command' as const, args: 'mcp user notes', label: 'MCP server notes (user scope)', subject: 'configured' as const }
    expect(rejectedNote(request, true)).toBe('AI Install Guard: rejected MCP server notes (user scope); the guard refuses its tools; claude mcp remove notes -s user removes it')
    expect(rejectedNote(request, false)).toBe('AI Install Guard: closed MCP server notes (user scope); the guard could not check it, so nothing was recorded and nothing is refused; claude mcp remove notes -s user removes it')
  })

  test('over the limit, the oldest approval goes before any rejection', async ($, on) => {
    const at = (n: number, kind: 'approved' | 'rejected') => ({ ...decision(`d${n}`, `sha256:${n}`, kind), decidedAt: n })
    world(on, { 'proj/.claude/settings.json': b64(HOOKED) })
    const stored = store(on, { decisions: [...Array.from({ length: 499 }, (_, n) => at(1000 - n, 'approved')), at(1, 'rejected')] })
    serveUi(on)

    await start($)
    await (await mountPane($)).press({ key: 'install' })
    const kept = stored.get('decisions') as { treeHash: string }[]
    expect(kept.length).toBe(500)
    expect(kept[0]?.treeHash).toBe(await settingsHash(PROJECT_SETTINGS, HOOKED))
    expect(kept.at(-1)?.treeHash).toBe('sha256:1')
    expect(kept.some(item => item.treeHash === `sha256:${1000 - 498}`)).toBe(false)
  })
})

describe('the note at the end of the check', () => {
  const found = (key: string, label: string, extra: Record<string, unknown> = {}) => ({ key, label, why: 'Worth a look', ...extra })

  test('names what waits, what was rejected, and what was checked', () => {
    expect(configToast({ baseline: false, checked: [], found: [] }, false)).toBeUndefined()
    expect(configToast({ baseline: false, checked: [], found: [found('mcp user a', 'MCP server a (user scope)', { quiet: true })] }, false)).toBeUndefined()
    expect(configToast({ baseline: false, checked: [], found: [found('mcp user a', 'MCP server a (user scope)')] }, false)).toBe(
      'AI Install Guard found 1 MCP server in your configuration that you have not approved: MCP server a (user scope). /guard held lists them and opens the first in the pane.',
    )
    expect(configToast({ baseline: false, checked: ['MCP server b (user scope)'], found: [found('mcp user a', 'MCP server a (user scope)', { rejected: true }), found('mcp user c', 'MCP server c (user scope)', { rejected: true })] }, false)).toBe(
      'AI Install Guard found 2 MCP servers in your configuration that you have not approved: MCP server a (user scope), MCP server c (user scope). You rejected them: /guard held says how to remove each. AI Install Guard checked 1 MCP server new since it last looked: no red flags (MCP server b (user scope)).',
    )
    expect(configToast({ baseline: true, checked: ['MCP server b (user scope)'], found: [] }, false)).toBe(
      'AI Install Guard looked at the 1 MCP server in your configuration that it had not checked: no red flags. From now on, it checks one that is new or changed as a session starts.',
    )
  })
})

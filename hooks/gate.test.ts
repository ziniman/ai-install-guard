import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { readPluginArgs, readShellCommand, splitShell } from './gate/requests'
import { PANE_ID } from './guard/view'
import type { RunResult } from './scan/host'
import { FIXTURES } from './test-support/fixtures.gen'
import { HOME, paneProps, serveFixture, serveUi, typed, type FixtureFiles } from './test-support/memfs'

function fixture(name: string): FixtureFiles {
  const files = FIXTURES[name]
  if (files === undefined) throw new Error(`no fixture ${name}`)
  return files
}

/** A fixture laid out under `prefix` inside the served folder. */
function nest(prefix: string, files: FixtureFiles): FixtureFiles {
  return Object.fromEntries(Object.entries(files).map(([path, file]) => [`${prefix}/${path}`, file]))
}

describe('reading /plugin', () => {
  test('installs and marketplace additions are read; everything else passes', () => {
    expect(readPluginArgs('install notes@acme')).toEqual({ kind: 'install', request: { kind: 'plugin', verb: 'install', plugin: 'notes', marketplace: 'acme' }, label: '/plugin install notes@acme' })
    expect(readPluginArgs('i notes')).toEqual({ kind: 'install', request: { kind: 'plugin', verb: 'install', plugin: 'notes' }, label: '/plugin install notes' })
    expect(readPluginArgs('marketplace add acme/market')).toEqual({ kind: 'install', request: { kind: 'marketplace', source: 'acme/market' }, label: '/plugin marketplace add acme/market' })
    expect(readPluginArgs('marketplace add "/work/my market"')).toMatchObject({ request: { kind: 'marketplace', source: '/work/my market' } })
    expect(readPluginArgs('')).toEqual({ kind: 'pass', browse: true })
    expect(readPluginArgs('install')).toEqual({ kind: 'pass', browse: true })
    expect(readPluginArgs('manage')).toEqual({ kind: 'pass', browse: false })
    expect(readPluginArgs('marketplace list')).toEqual({ kind: 'pass', browse: false })
    expect(readPluginArgs('uninstall notes@acme')).toEqual({ kind: 'pass', browse: false })
  })

  test('what the guard cannot scan is held as unreadable, with the reason', () => {
    expect(readPluginArgs('install notes --marketplace acme/market')).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('/plugin marketplace add acme/market') })
    expect(readPluginArgs('install notes other')).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('more than one plugin') })
    expect(readPluginArgs('install left-pad@npm')).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('npm') })
    expect(readPluginArgs('install --surprise notes')).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('--surprise') })
    expect(readPluginArgs('install ../notes')).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('not a plugin name') })
    expect(readPluginArgs('marketplace add --claudeai team')).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('claude.ai') })
  })
})

describe("reading Claude's shell commands", () => {
  const install = (plugin: string, marketplace?: string) => ({ kind: 'install', request: { kind: 'plugin', verb: 'install', plugin, ...(marketplace === undefined ? {} : { marketplace }) } })

  test('finds the install however the command is written', () => {
    expect(readShellCommand('claude plugin install notes@acme --scope project')).toMatchObject(install('notes', 'acme'))
    expect(readShellCommand('cd /tmp && claude plugins i notes@acme')).toMatchObject(install('notes', 'acme'))
    expect(readShellCommand('env X=1 /usr/local/bin/claude plugin install notes@acme 2>&1 | tail -5')).toMatchObject(install('notes', 'acme'))
    expect(readShellCommand('bash -lc "claude plugin install notes@acme"')).toMatchObject(install('notes', 'acme'))
    expect(readShellCommand(`sh -c 'eval "claude plugin marketplace add acme/market"'`)).toMatchObject({ kind: 'install', request: { kind: 'marketplace', source: 'acme/market' } })
    expect(readShellCommand('bash <<EOF\nclaude plugin install notes@acme\nEOF')).toMatchObject(install('notes', 'acme'))
    expect(readShellCommand('claude "plugin" install notes@acme # quoted words')).toMatchObject(install('notes', 'acme'))
    expect(readShellCommand('claude plugin update notes@acme')).toMatchObject({ kind: 'install', request: { kind: 'plugin', verb: 'update', plugin: 'notes' } })
  })

  test('commands that install nothing pass', () => {
    for (const command of [
      'ls -la',
      'claude plugin list --json',
      'claude plugin validate .',
      'claude mcp list',
      'grep -rn "claude plugin install" docs',
      "cat > README.md <<'EOF'\nRun claude plugin install notes@acme\nclaude plugin install notes@acme\nEOF",
      'git commit -m "explain claude plugin install"',
    ]) {
      expect(readShellCommand(command)).toEqual({ kind: 'pass', browse: false })
    }
  })

  test('an install the guard cannot read is held, not let through', () => {
    expect(readShellCommand('claude plugin install a@m && claude plugin install b@m')).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('more than one') })
    expect(readShellCommand('claude plugin install $NAME')).toMatchObject({ kind: 'unreadable' })
    expect(readShellCommand('echo "claude plugin install notes@acme" | bash')).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('only known as it runs') })
    expect(readShellCommand('$(echo claude) plugin install notes@acme')).toMatchObject({ kind: 'unreadable' })
    expect(readShellCommand('claude plugin install notes --marketplace acme/market')).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('marketplace add') })
  })

  test('splits like a shell: quotes, separators, redirections and here-documents', () => {
    expect(splitShell(`a 'b c' "d \\"e\\"" f\\ g; h && i | j 2>&1 > out < in`).commands.map(item => item.words)).toEqual([['a', 'b c', 'd "e"', 'f g'], ['h'], ['i'], ['j']])
    expect(splitShell('cat <<-END\n\tbody\n\tEND\nnext').commands).toEqual([{ words: ['cat'], input: 'body' }, { words: ['next'] }])
    expect(splitShell('echo $HOME').dynamic).toBe(true)
    expect(splitShell("echo '$HOME'").dynamic).toBe(false)
  })
})

const SHA = 'a'.repeat(40)
const MOVED = 'c'.repeat(40)
// Everything the gate reads lies under the home folder, served as one tree.
const TEMP = `${HOME}/tmp/ai-install-guard.Gate1234`
const WORK = `${TEMP}/repo`
const MARKET = `${HOME}/.claude/plugins/marketplaces/acme`
const under = (folder: string) => folder.slice(HOME.length + 1)

type Listing = { installed: { id: string }[]; available: Record<string, unknown>[] }

function listing(sha = SHA): Listing {
  return {
    installed: [],
    available: [
      { pluginId: 'notes@acme', name: 'notes', marketplaceName: 'acme', source: { source: 'git-subdir', url: 'https://github.com/acme/tools.git', path: 'plugins/notes', sha } },
      { pluginId: 'curly@acme', name: 'curly', marketplaceName: 'acme', source: { source: 'url', url: 'https://github.com/acme/curly.git', sha } },
      { pluginId: 'local@acme', name: 'local', marketplaceName: 'acme', source: './plugins/local' },
      { pluginId: 'packed@acme', name: 'packed', marketplaceName: 'acme', source: { source: 'npm', package: 'packed' } },
    ],
  }
}

/** The marketplace's own catalog file, where an installed plugin's updates come from. */
const CATALOG = {
  name: 'acme',
  plugins: [
    { name: 'notes', source: { source: 'git-subdir', url: 'https://github.com/acme/tools.git', path: 'plugins/notes', sha: SHA } },
    { name: 'local', source: './plugins/local' },
  ],
}

type World = { core: string[]; ran: string[][]; listing: Listing; served: FixtureFiles }

/**
 * The machine as the gate sees it: the `claude` command answers from a
 * listing, git fetches whatever commit is asked for, and `core` records each
 * /plugin command and shell command that got past the guard.
 */
function world(on: On, files: { work?: FixtureFiles; market?: FixtureFiles } = {}): World {
  const state: World = { core: [], ran: [], listing: listing(), served: {} }
  let fetched = SHA
  const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' })
  const run = (argv: readonly string[]): RunResult | undefined => {
    state.ran.push([...argv])
    if (argv[0] === 'claude') {
      const line = argv.slice(1).join(' ')
      if (line === 'plugin list --available --json') return ok(JSON.stringify(state.listing))
      if (line === 'plugin marketplace list --json') return ok(JSON.stringify([{ name: 'acme', source: 'github', repo: 'acme/market', installLocation: MARKET }]))
      return { exitCode: 1, stdout: '', stderr: `test: no answer for ${line}` }
    }
    if (argv[0] === 'mktemp') return ok(`${TEMP}\n`)
    if (argv[0] === 'rm') return ok()
    if (argv[0] === 'sh') return { exitCode: 1, stdout: '', stderr: 'no shell in this test' }
    if (argv[0] !== 'git') return undefined
    if (argv.includes('ls-remote')) return ok(`ref: refs/heads/main\tHEAD\n${fetched}\tHEAD\n${fetched}\trefs/heads/main\n`)
    if (argv.includes('fetch')) fetched = argv[argv.length - 1] as string
    if (argv.includes('rev-parse')) return ok(`${fetched}\n`)
    if (argv.includes('count-objects')) return ok('size: 0\nsize-pack: 12\n')
    return ok()
  }
  const market = { '.claude-plugin/marketplace.json': { base64: btoa(JSON.stringify(CATALOG)) }, ...files.market }
  state.served = { ...nest(under(WORK), files.work ?? nest('plugins/notes', fixture('clean-plugin'))), ...nest(under(MARKET), market) }
  serveFixture(on, HOME, state.served, { run })
  on('command.run', { command: 'plugin' }, ($, e) => {
    state.core.push(e.args)
    return { text: `core ran /plugin ${e.args}` }
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    state.core.push(e.command)
    return { result: { stdout: 'ran', stderr: '', interrupted: false } }
  })
  return state
}

function seededStore(on: On): Map<string, unknown> {
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', ($, e) => (store.delete(e.key), { value: undefined }))
  return store
}

const mountPane = ($: Engine) => $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })
const fetches = (state: World) => state.ran.filter(argv => argv.includes('fetch')).length

describe('gate A: /plugin install', () => {
  test('holds the install, scans the pinned commit, and installs it once you press Install', async ($, on) => {
    const store = seededStore(on)
    const ui = serveUi(on)
    const state = world(on)
    const answer = await $.command.run(typed('plugin', 'install notes@acme'))

    expect(answer.text).toContain('Safe to install for /plugin install notes@acme at commit aaaaaaaaaaaa')
    expect(answer.text).toContain('Nothing is installed yet')
    expect(state.core).toEqual([])
    expect(ui.opened).toEqual([PANE_ID])

    const pane = await mountPane($)
    expect(await pane.find({ type: 'Text', text: /^Held until you decide: \/plugin install notes@acme$/ })).toBeDefined()
    expect((await pane.find({ key: 'install' }))?.text).toBe('Install')
    await pane.press({ key: 'install' })

    // The approval names this commit of this folder, and the command ran again through the gate.
    const [decision] = store.get('decisions') as { sha?: string; root?: string; target: string }[]
    expect(decision).toMatchObject({ sha: SHA, root: 'https://github.com/acme/tools.git#plugins/notes', target: 'notes@acme' })
    expect(state.core).toEqual(['install notes@acme'])
    expect(fetches(state)).toBe(1)
    expect(ui.toasts).toContain('AI Install Guard: approved; installing /plugin install notes@acme')
    await pane.unmount()
  })

  test('a version you approved before installs without a new scan', async ($, on) => {
    seededStore(on)
    serveUi(on)
    const state = world(on)
    await $.command.run(typed('plugin', 'install notes@acme'))
    const pane = await mountPane($)
    await pane.press({ key: 'install' })
    await pane.unmount()

    const again = await $.command.run(typed('plugin', 'install notes@acme'))
    expect(again.text).toBe('core ran /plugin install notes@acme')
    expect(state.core).toEqual(['install notes@acme', 'install notes@acme'])
    expect(fetches(state)).toBe(1)
  })

  test('a new commit is scanned again, even after an approval', async ($, on) => {
    seededStore(on)
    serveUi(on)
    const state = world(on)
    await $.command.run(typed('plugin', 'install notes@acme'))
    const pane = await mountPane($)
    await pane.press({ key: 'install' })
    await pane.unmount()

    state.listing = listing(MOVED)
    const moved = await $.command.run(typed('plugin', 'install notes@acme'))
    expect(moved.text).toContain(`at commit ${MOVED.slice(0, 12)}`)
    expect(moved.text).toContain('Nothing is installed yet')
    expect(state.core).toEqual(['install notes@acme'])
    expect(fetches(state)).toBe(2)
  })

  test('a commit that moves between the scan and Install is not installed', async ($, on) => {
    seededStore(on)
    const ui = serveUi(on)
    const state = world(on)
    await $.command.run(typed('plugin', 'install notes@acme'))
    state.listing = listing(MOVED)
    const pane = await mountPane($)
    await pane.press({ key: 'install' })

    expect(state.core).toEqual([])
    expect(ui.toasts).toContain(`AI Install Guard: nothing was installed: it now points at commit ${MOVED.slice(0, 12)}, not the one scanned. Run /plugin install notes@acme again to scan it`)
    await pane.unmount()
  })

  test("an installed plugin's update comes from its marketplace's catalog", async ($, on) => {
    seededStore(on)
    serveUi(on)
    const state = world(on)
    state.listing = { installed: [{ id: 'notes@acme' }], available: listing().available.filter(item => item.name !== 'notes') }
    const answer = await $.command.run(typed('plugin', 'update notes@acme'))
    expect(answer.text).toContain('Safe to install for /plugin update notes@acme at commit aaaaaaaaaaaa')
    expect(state.core).toEqual([])
  })

  test('a version you rejected stays rejected', async ($, on) => {
    seededStore(on)
    serveUi(on)
    const state = world(on)
    await $.command.run(typed('plugin', 'install notes@acme'))
    const pane = await mountPane($)
    await pane.press({ key: 'reject' })
    await pane.unmount()

    const again = await $.command.run(typed('plugin', 'install notes@acme'))
    expect(again.text).toContain('you rejected notes@acme at commit aaaaaaaaaaaa')
    expect(again.text).toContain('/guard forget notes@acme')
    expect(state.core).toEqual([])
  })

  test('Do not install installs only after a second, explicit confirmation', async ($, on) => {
    seededStore(on)
    serveUi(on)
    const state = world(on, { work: fixture('curl-hook') })
    const answer = await $.command.run(typed('plugin', 'install curly@acme'))
    expect(answer.text).toContain('Do not install')

    const pane = await mountPane($)
    expect((await pane.find({ key: 'install' }))?.text).toBe('Install anyway')
    await pane.press({ key: 'install' })
    expect(state.core).toEqual([])
    await pane.press({ key: 'confirm' })
    expect(state.core).toEqual(['install curly@acme'])
    await pane.unmount()
  })

  test('what cannot be scanned is Could not verify, and Install anyway lets that command through once', async ($, on) => {
    seededStore(on)
    serveUi(on)
    const state = world(on)
    const answer = await $.command.run(typed('plugin', 'install packed@acme'))
    expect(answer.text).toContain('Could not verify for /plugin install packed@acme')

    const pane = await mountPane($)
    expect(await pane.find({ type: 'Text', text: /npm source, which the guard cannot read yet/ })).toBeDefined()
    await pane.press({ key: 'install' })
    await pane.press({ key: 'confirm' })
    expect(state.core).toEqual(['install packed@acme'])
    await pane.unmount()

    // The pass is used up: the next install is held again.
    const again = await $.command.run(typed('plugin', 'install packed@acme'))
    expect(again.text).toContain('Could not verify')
    expect(state.core).toEqual(['install packed@acme'])
  })

  test('a plugin no marketplace lists is held, not passed on', async ($, on) => {
    seededStore(on)
    serveUi(on)
    const state = world(on)
    const answer = await $.command.run(typed('plugin', 'install ghost@acme'))
    expect(answer.text).toContain('Could not verify')
    const pane = await mountPane($)
    expect(await pane.find({ type: 'Text', text: /not in the marketplaces you added/ })).toBeDefined()
    expect(state.core).toEqual([])
    await pane.unmount()
  })

  test("a marketplace's own copy of a plugin is scanned where it lies", async ($, on) => {
    const store = seededStore(on)
    serveUi(on)
    const state = world(on, { market: nest('plugins/local', fixture('clean-plugin')) })
    const answer = await $.command.run(typed('plugin', 'install local@acme'))
    expect(answer.text).toContain('Safe to install for /plugin install local@acme')
    expect(fetches(state)).toBe(0)

    const pane = await mountPane($)
    await pane.press({ key: 'install' })
    const [decision] = store.get('decisions') as { root?: string; sha?: string }[]
    expect(decision?.root).toBe(`${MARKET}/plugins/local`)
    expect(decision?.sha).toBeUndefined()
    expect(state.core).toEqual(['install local@acme'])
    await pane.unmount()
  })

  test("a marketplace's copy that changes before Install is not installed", async ($, on) => {
    seededStore(on)
    const ui = serveUi(on)
    const state = world(on, { market: nest('plugins/local', fixture('clean-plugin')) })
    await $.command.run(typed('plugin', 'install local@acme'))
    const readme = `${under(MARKET)}/plugins/local/README.md`
    expect(state.served[readme]).toBeDefined()
    state.served[readme] = { base64: btoa('# local\nNow it does something else.\n') }
    const pane = await mountPane($)
    await pane.press({ key: 'install' })

    expect(state.core).toEqual([])
    expect(ui.toasts).toContain('AI Install Guard: nothing was installed: its files changed since the scan. Run /plugin install local@acme again to scan it')
    await pane.unmount()
  })

  test("a link in the way out of the marketplace's folder is refused", async ($, on) => {
    seededStore(on)
    serveUi(on)
    const state = world(on, { market: { 'plugins/local': { link: '/etc' } } })
    const answer = await $.command.run(typed('plugin', 'install local@acme'))
    expect(answer.text).toContain('Could not verify')
    const pane = await mountPane($)
    expect(await pane.find({ type: 'Text', text: /passes through a symbolic link/ })).toBeDefined()
    expect(state.core).toEqual([])
    await pane.unmount()
  })

  test('/plugin marketplace add scans the repository first', async ($, on) => {
    seededStore(on)
    serveUi(on)
    const state = world(on, { work: fixture('clean-plugin') })
    const answer = await $.command.run(typed('plugin', 'marketplace add acme/market'))
    expect(answer.text).toContain('for /plugin marketplace add acme/market at commit')
    expect(state.core).toEqual([])

    const pane = await mountPane($)
    await pane.press({ key: 'install' })
    expect(state.core).toEqual(['marketplace add acme/market'])
    await pane.unmount()
  })

  test("the plugins menu opens, with a note that what it installs is not scanned yet", async ($, on) => {
    seededStore(on)
    const ui = serveUi(on)
    const state = world(on)
    await $.command.run(typed('plugin', ''))
    await $.command.run(typed('plugin', 'install acme'))
    expect(state.core).toEqual(['', 'install acme'])
    expect(ui.toasts.filter(text => text.includes('not scanned yet'))).toHaveLength(2)
  })

  test('a gate that fails refuses the install', async ($, on) => {
    seededStore(on)
    serveUi(on)
    const state = world(on)
    on('state.get', () => ({ deny: 'the state is gone' }))
    const answer = await $.command.run(typed('plugin', 'install notes@acme'))
    expect(answer.text).toContain('stopped this install')
    expect(state.core).toEqual([])
  })
})

describe("gate B: Claude's own install commands", () => {
  const bash = (command: string) => ({ tool: 'Bash' as const, command })

  test('the command is refused with a reason Claude reads, and goes through once you approve', async ($, on) => {
    seededStore(on)
    const ui = serveUi(on)
    const state = world(on)
    const refused = await $.tool.call(bash('claude plugin install notes@acme --scope project'))

    expect(refused.deny).toContain('held this install for the person to review: Safe to install for claude plugin install notes@acme at commit aaaaaaaaaaaa')
    expect(refused.deny).toContain('Do not retry it or install it another way')
    expect(state.core).toEqual([])

    const pane = await mountPane($)
    expect(await pane.find({ type: 'Text', text: /^Claude asked to run: claude plugin install notes@acme --scope project$/ })).toBeDefined()
    await pane.press({ key: 'install' })
    expect(ui.toasts).toContain('AI Install Guard: approved claude plugin install notes@acme. Tell Claude to run the install again; it goes through now')
    expect(state.core).toEqual([])
    await pane.unmount()

    const ran = await $.tool.call(bash('claude plugin install notes@acme --scope project'))
    expect(ran.deny).toBeUndefined()
    expect(state.core).toEqual(['claude plugin install notes@acme --scope project'])
    expect(fetches(state)).toBe(1)
  })

  test('commands that install nothing run as they are, with nothing looked up', async ($, on) => {
    seededStore(on)
    serveUi(on)
    const state = world(on)
    const ran = await $.tool.call(bash('ls -la && claude plugin list'))
    expect(ran.deny).toBeUndefined()
    expect(state.core).toEqual(['ls -la && claude plugin list'])
    expect(state.ran).toEqual([])
  })

  test('an install it cannot read is refused until allowed, and then only once', async ($, on) => {
    seededStore(on)
    serveUi(on)
    const state = world(on)
    const command = 'echo "claude plugin install notes@acme" | bash'
    const refused = await $.tool.call(bash(command))
    expect(refused.deny).toContain('Could not verify')

    const pane = await mountPane($)
    await pane.press({ key: 'install' })
    await pane.press({ key: 'confirm' })
    await pane.unmount()
    expect((await $.tool.call(bash(command))).deny).toBeUndefined()
    expect((await $.tool.call(bash(command))).deny).toContain('Could not verify')
    expect(state.core).toEqual([command])
  })

  test('a rejected version is refused for good', async ($, on) => {
    seededStore(on)
    serveUi(on)
    const state = world(on)
    await $.tool.call(bash('claude plugin install notes@acme'))
    const pane = await mountPane($)
    await pane.press({ key: 'reject' })
    await pane.unmount()

    const again = await $.tool.call(bash('claude plugin install notes@acme'))
    expect(again.deny).toContain('the person rejected this exact version of notes@acme')
    expect(state.core).toEqual([])
  })
})

describe('the gate without a pane', () => {
  test('a headless install answers with the report and installs nothing', async ($, on) => {
    mock.store(on)
    serveUi(on, { placed: false })
    const state = world(on)
    const answer = await $.command.run(typed('plugin', 'install notes@acme'))
    expect(answer.text).toContain('Safe to install')
    expect(answer.text).toContain("approving an install needs the guard's pane")
    expect(state.core).toEqual([])
  })
})

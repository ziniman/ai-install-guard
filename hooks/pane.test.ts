import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import type { GuardView } from '../types'
import { badgeFor } from './guard/badge'
import { PANE_ID } from './guard/view'
import { FIXTURES } from './test-support/fixtures.gen'
import { paneProps, serveFixture, serveUi, typed, type FixtureFiles } from './test-support/memfs'

const SURFACES = ['terminal', 'desktop'] as const
const ROOT = '/work/candidate'

function fixture(name: string): FixtureFiles {
  const files = FIXTURES[name]
  if (files === undefined) throw new Error(`no fixture ${name}`)
  return files
}

describe('the verdict pane', () => {
  for (const surface of SURFACES) {
    test(`a clean plugin: Safe to install, Approve as the main action (${surface})`, async ($, on) => {
      mock.store(on)
      const ui = serveUi(on)
      serveFixture(on, ROOT, fixture('clean-plugin'))
      const { text } = await $.command.run(typed('guard', `scan ${ROOT}`))

      expect(text).toContain('Safe to install')
      expect(text).toContain('The report is in the pane')
      expect(ui.opened).toEqual([PANE_ID])

      const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface, component: 'Pane', requestId: PANE_ID, props: paneProps() })
      expect(await pane.find({ type: 'Text', text: /^Safe to install$/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^\d+ passed · 0 warnings · 0 failed$/ })).toBeDefined()
      expect((await pane.find({ key: 'install' }))?.text).toBe('Approve')
      expect(await pane.find({ key: 'reject' })).toBeDefined()
      expect(await pane.find({ key: 'details' })).toBeDefined()
      expect(await pane.find({ key: 'copy' })).toBeDefined()
      await pane.unmount()
    })

    test(`Do not install: approving needs a second, explicit confirmation (${surface})`, async ($, on) => {
      mock.store(on)
      const ui = serveUi(on)
      serveFixture(on, ROOT, fixture('curl-hook'))
      await $.command.run(typed('guard', `scan ${ROOT}`))
      const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface, component: 'Pane', requestId: PANE_ID, props: paneProps() })

      expect(await pane.find({ type: 'Text', text: /^Do not install$/ })).toBeDefined()
      expect((await pane.find({ key: 'install' }))?.text).toBe('Approve anyway')

      await pane.press({ key: 'install' })
      expect(ui.closed).toEqual([])
      expect((await pane.find({ key: 'confirm' }))?.text).toBe('Yes, approve anyway')

      await pane.press({ key: 'confirm' })
      expect(ui.closed).toEqual([PANE_ID])
      const { text } = await $.command.run(typed('guard', 'list'))
      expect(text).toContain('approved against the verdict')
      expect(text).toContain(ROOT)
      await pane.unmount()
    })

    test(`cancelling the confirmation approves nothing (${surface})`, async ($, on) => {
      mock.store(on)
      const ui = serveUi(on)
      serveFixture(on, ROOT, fixture('curl-hook'))
      await $.command.run(typed('guard', `scan ${ROOT}`))
      const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface, component: 'Pane', requestId: PANE_ID, props: paneProps() })

      await pane.press({ key: 'install' })
      await pane.press({ key: 'cancel' })

      expect(await pane.find({ key: 'confirm' })).toBeUndefined()
      expect((await pane.find({ key: 'install' }))?.text).toBe('Approve anyway')
      expect(ui.closed).toEqual([])
      expect((await $.command.run(typed('guard', 'list'))).text).toContain('no decisions yet')
      await pane.unmount()
    })

    test(`Reject records the rejection and closes the pane (${surface})`, async ($, on) => {
      mock.store(on)
      const ui = serveUi(on)
      serveFixture(on, ROOT, fixture('mod-http-fetch'))
      await $.command.run(typed('guard', `scan ${ROOT}`))
      const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface, component: 'Pane', requestId: PANE_ID, props: paneProps() })

      expect(await pane.find({ type: 'Text', text: /^Install with caution$/ })).toBeDefined()
      expect((await pane.find({ key: 'install' }))?.text).toBe('Approve')
      await pane.press({ key: 'reject' })

      expect(ui.closed).toEqual([PANE_ID])
      expect(ui.toasts.at(-1)).toContain('rejected')
      expect((await $.command.run(typed('guard', 'list'))).text).toContain('rejected')
      await pane.unmount()
    })

    test(`Details opens every row; a row opens on its own (${surface})`, async ($, on) => {
      mock.store(on)
      serveUi(on)
      serveFixture(on, ROOT, fixture('curl-hook'))
      await $.command.run(typed('guard', `scan ${ROOT}`))
      const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface, component: 'Pane', requestId: PANE_ID, props: paneProps() })

      expect(await pane.find({ key: 'detail-hooks.commands' })).toBeUndefined()
      await pane.press({ key: 'toggle-hooks.commands' })
      expect((await pane.find({ key: 'detail-hooks.commands' }))?.text).toContain('hooks/hooks.json:8')
      await pane.press({ key: 'toggle-hooks.commands' })
      await pane.press({ key: 'details' })
      expect(await pane.find({ key: 'detail-hooks.commands' })).toBeDefined()
      expect(await pane.find({ key: 'detail-structure.files' })).toBeDefined()
      expect((await pane.find({ key: 'details' }))?.text).toBe('Fewer details')
      await pane.unmount()
    })

    test(`Copy report copies the full text report (${surface})`, async ($, on) => {
      mock.store(on)
      const ui = serveUi(on)
      serveFixture(on, ROOT, fixture('curl-hook'))
      await $.command.run(typed('guard', `scan ${ROOT}`))
      const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface, component: 'Pane', requestId: PANE_ID, props: paneProps() })

      await pane.press({ key: 'copy' })

      expect(ui.copied[0]).toContain('Verdict: Do not install')
      expect(ui.copied[0]).toContain('Advice:')
      expect(ui.toasts.at(-1)).toContain('report copied')
      await pane.unmount()
    })
  }

  test('while scanning, the status line says so and is cleared after', async ($, on) => {
    mock.store(on)
    const ui = serveUi(on)
    serveFixture(on, ROOT, fixture('clean-plugin'))
    await $.command.run(typed('guard', `scan ${ROOT}`))

    expect(ui.statuses[0]).toContain('scanning /work/candidate')
    expect(ui.statuses.at(-1)).toBeUndefined()
    expect(ui.toasts.at(-1)).toContain('Safe to install for /work/candidate')
  })

  test('without a surface to show the pane, the answer is the text report', async ($, on) => {
    mock.store(on)
    serveUi(on, { placed: false })
    serveFixture(on, ROOT, fixture('curl-hook'))
    const { text } = await $.command.run(typed('guard', `scan ${ROOT}`))

    expect(text).toContain('Verdict: Do not install')
    expect(text).toContain('Shell hooks and the scripts they run')
  })

  test('/guard report reopens the last report, and forget clears decisions', async ($, on) => {
    mock.store(on)
    const ui = serveUi(on)
    serveFixture(on, ROOT, fixture('mod-http-fetch'))
    await $.command.run(typed('guard', `scan ${ROOT}`))
    const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })
    await pane.press({ key: 'install' })
    await pane.unmount()

    expect((await $.command.run(typed('guard', 'report'))).text).toContain('reopened the report')
    expect(ui.opened).toEqual([PANE_ID, PANE_ID])
    expect((await $.command.run(typed('guard', 'list'))).text).toContain('approved')
    expect((await $.command.run(typed('guard', 'forget candidate'))).text).toContain('forgot 1 decision')
    expect((await $.command.run(typed('guard', 'list'))).text).toContain('no decisions yet')
  })

  test('the pane with no scan yet says how to start one', async ($, on) => {
    mock.store(on)
    const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })

    expect((await pane.find({ type: 'Text' }))?.text).toContain('No scan yet')
    await pane.unmount()
  })
})

describe('pane review fixes', () => {
  test('a scan that could not read the folder can be closed, and offers nothing to approve', async ($, on) => {
    mock.store(on)
    const ui = serveUi(on)
    serveFixture(on, ROOT, fixture('clean-plugin'))
    await $.command.run(typed('guard', 'scan /work/missing'))
    const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })

    expect(await pane.find({ type: 'Text', text: /^Could not verify$/ })).toBeDefined()
    expect(await pane.find({ key: 'install' })).toBeUndefined()
    await pane.press({ key: 'reject' })
    expect(ui.closed).toEqual([PANE_ID])
    expect(ui.toasts.at(-1)).toContain('no decision to remember')
    expect((await $.command.run(typed('guard', 'list'))).text).toContain('no decisions yet')
    await pane.unmount()
  })

  test('the pane header shows a hidden character in the target as a code point', async ($, on) => {
    mock.store(on)
    serveUi(on)
    serveFixture(on, '/work/evil\u202eclean', fixture('clean-plugin'))
    await $.command.run(typed('guard', 'scan /work/evil\u202eclean'))
    const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })

    expect((await pane.find({ type: 'Text', text: /^AI Install Guard/ }))?.text).toContain('evil<U+202E>clean')
    await pane.unmount()
  })

  test('a failure to show progress does not fail the scan', async ($, on) => {
    mock.store(on)
    serveUi(on)
    serveFixture(on, ROOT, fixture('clean-plugin'))
    let sets = 0
    on('state.set', ($, e, next) => (++sets === 2 ? { deny: 'test: progress refused' } : next(e)))
    const { text } = await $.command.run(typed('guard', `scan ${ROOT}`))

    expect(text).toContain('Safe to install')
  })

  test('after a failed scan, Copy report copies that failure, not an older report', async ($, on) => {
    mock.store(on)
    const ui = serveUi(on)
    serveFixture(on, ROOT, fixture('curl-hook'))
    await $.command.run(typed('guard', `scan ${ROOT}`))
    await $.command.run(typed('guard', 'scan /work/other'))
    const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })
    await pane.press({ key: 'copy' })

    expect(ui.copied.at(-1)).toContain('AI Install Guard: /work/other')
    expect(ui.copied.at(-1)).toContain('Verdict: Could not verify')
    expect(ui.copied.at(-1)).not.toContain('Shell hooks')
    await pane.unmount()
  })

  test('a reopened report shows the decision, not the buttons', async ($, on) => {
    mock.store(on)
    serveUi(on)
    serveFixture(on, ROOT, fixture('clean-plugin'))
    await $.command.run(typed('guard', `scan ${ROOT}`))
    const first = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })
    await first.press({ key: 'install' })
    await first.unmount()

    await $.command.run(typed('guard', 'report'))
    const again = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })
    expect(await again.find({ key: 'install' })).toBeUndefined()
    expect(await again.find({ type: 'Text', text: /^Approved on / })).toBeDefined()
    await again.unmount()
  })

  test('a scan that fails part way leaves a finished pane, not a scanning one', async ($, on) => {
    mock.store(on)
    serveUi(on)
    on('process.run', ($, e, next) => (e.argv[0] === 'printenv' ? { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } : next(e)))
    const { text } = await $.command.run(typed('guard', 'scan ~/x'))
    const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })

    expect(text).toContain('could not find the home folder')
    expect(await pane.find({ type: 'Text', text: /^Scanning/ })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /^Could not verify$/ })).toBeDefined()
    await pane.unmount()
  })

  test('a headless scan answers with every finding and its advice', async ($, on) => {
    mock.store(on)
    serveUi(on, { placed: false })
    serveFixture(on, ROOT, fixture('curl-hook'))
    const { text } = await $.command.run(typed('guard', `scan ${ROOT}`))

    expect(text).toContain('Advice:')
  })

  test('forget matches a whole name, not part of another', async ($, on) => {
    mock.store(on, {
      decisions: [
        { target: '/w/tool', root: '/w/tool', treeHash: 'sha256:a', verdict: 'Safe to install', verdictKind: 'safe', decision: 'approved', overridden: false, decidedAt: 1 },
        { target: '/w/my-tool-2', root: '/w/my-tool-2', treeHash: 'sha256:b', verdict: 'Safe to install', verdictKind: 'safe', decision: 'approved', overridden: false, decidedAt: 2 },
      ],
    })
    expect((await $.command.run(typed('guard', 'forget tool'))).text).toContain('forgot 1 decision')
    expect((await $.command.run(typed('guard', 'list'))).text).toContain('my-tool-2')
  })
})

describe('pane review fixes, round two', () => {
  test('after a failed scan, /guard report reopens the failure, not an older verdict', async ($, on) => {
    let homeFails = false
    mock.store(on)
    serveUi(on)
    serveFixture(on, ROOT, fixture('clean-plugin'), { homeFails: () => homeFails })
    await $.command.run(typed('guard', `scan ${ROOT}`))
    homeFails = true
    expect((await $.command.run(typed('guard', 'scan ~/other'))).text).toContain('could not find the home folder')
    await $.command.run(typed('guard', 'report'))
    const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })

    expect(await pane.find({ type: 'Text', text: /^Safe to install$/ })).toBeUndefined()
    await pane.unmount()
  })

  test('after forget, the reopened report no longer claims the decision', async ($, on) => {
    mock.store(on)
    serveUi(on)
    serveFixture(on, ROOT, fixture('clean-plugin'))
    await $.command.run(typed('guard', `scan ${ROOT}`))
    const first = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })
    await first.press({ key: 'install' })
    await first.unmount()
    await $.command.run(typed('guard', 'forget candidate'))
    await $.command.run(typed('guard', 'report'))
    const again = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })

    expect(await again.find({ type: 'Text', text: /^Approved/ })).toBeUndefined()
    expect(await again.find({ key: 'install' })).toBeDefined()
    await again.unmount()
  })
})

describe('pane review fixes, round three', () => {
  test('rescanning a tree you already approved shows that decision', async ($, on) => {
    mock.store(on)
    serveUi(on)
    serveFixture(on, ROOT, fixture('clean-plugin'))
    await $.command.run(typed('guard', `scan ${ROOT}`))
    const first = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })
    await first.press({ key: 'install' })
    await first.unmount()
    await $.command.run(typed('guard', `scan ${ROOT}`))
    const again = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })

    expect(await again.find({ key: 'install' })).toBeUndefined()
    expect(await again.find({ type: 'Text', text: /^Approved on \d{4}-\d{2}-\d{2}\./ })).toBeDefined()
    await again.unmount()
  })

  test('a failed save says so and keeps the pane open', async ($, on) => {
    let failWrites = false
    const store = new Map<string, unknown>()
    on('store.get', ($, e) => ({ value: store.get(e.key) }))
    on('store.set', ($, e) => {
      if (failWrites && e.key === 'decisions') return { deny: 'test: store full' }
      store.set(e.key, e.value)
      return { value: undefined }
    })
    on('store.delete', ($, e) => (store.delete(e.key), { value: undefined }))
    const ui = serveUi(on)
    serveFixture(on, ROOT, fixture('clean-plugin'))
    await $.command.run(typed('guard', `scan ${ROOT}`))
    failWrites = true
    const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })
    await pane.press({ key: 'install' })

    expect(ui.toasts.at(-1)).toContain('could not save the decision')
    expect(ui.closed).toEqual([])
    expect(await pane.find({ key: 'install' })).toBeDefined()
    await pane.unmount()
  })

  test('forget finds a folder by its name with a trailing slash', async ($, on) => {
    mock.store(on, { decisions: [{ target: '/w/tool', root: '/w/tool', treeHash: 'sha256:a', verdict: 'Safe to install', verdictKind: 'safe', decision: 'approved', overridden: false, decidedAt: 1 }] })
    expect((await $.command.run(typed('guard', 'forget tool/'))).text).toContain('forgot 1 decision')
  })
})

describe('pane review fixes, round four', () => {
  // A store the test can read and seed: the decision is set on the tree the
  // first scan saw.
  const serveStore = (on: On) => {
    const store = new Map<string, unknown>()
    on('store.get', ($, e) => ({ value: store.get(e.key) }))
    on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
    on('store.delete', ($, e) => (store.delete(e.key), { value: undefined }))
    return store
  }
  const seed = (store: Map<string, unknown>, decision: 'approved' | 'rejected', verdictKind?: string) => {
    const view = store.get('last-view') as GuardView
    store.set('decisions', [{ target: ROOT, root: ROOT, treeHash: view.treeHash, verdict: 'Safe to install', verdictKind, decision, overridden: false, decidedAt: 1 }])
  }
  const rescan = async ($: Engine) => {
    await $.command.run(typed('guard', `scan ${ROOT}`))
    return $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })
  }

  test('an approval does not carry over to a worse verdict for the same tree', async ($, on) => {
    const store = serveStore(on)
    serveUi(on)
    serveFixture(on, ROOT, fixture('curl-hook'))
    await $.command.run(typed('guard', `scan ${ROOT}`))
    seed(store, 'approved', 'safe')
    const pane = await rescan($)

    expect(await pane.find({ key: 'install' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Approved on/ })).toBeUndefined()
    await pane.unmount()
  })

  test('an approval with no recorded verdict is not trusted', async ($, on) => {
    const store = serveStore(on)
    serveUi(on)
    serveFixture(on, ROOT, fixture('clean-plugin'))
    await $.command.run(typed('guard', `scan ${ROOT}`))
    seed(store, 'approved')
    const pane = await rescan($)

    expect(await pane.find({ key: 'install' })).toBeDefined()
    await pane.unmount()
  })

  test('a rejection holds whatever the verdict', async ($, on) => {
    const store = serveStore(on)
    serveUi(on)
    serveFixture(on, ROOT, fixture('curl-hook'))
    await $.command.run(typed('guard', `scan ${ROOT}`))
    seed(store, 'rejected', 'safe')
    const pane = await rescan($)

    expect(await pane.find({ key: 'install' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /^Rejected on/ })).toBeDefined()
    await pane.unmount()
  })
})

describe('a remote scan in the pane', () => {
  const SHA = 'a'.repeat(40)
  const WORK = '/tmp/ai-install-guard.Ef56Gh78/repo'
  let head = SHA
  const git = (argv: readonly string[]) => {
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
    if (argv[0] === 'mktemp') return ok('/tmp/ai-install-guard.Ef56Gh78\n')
    if (argv[0] === 'rm') return ok()
    if (argv[0] !== 'git') return undefined
    if (argv.includes('ls-remote')) return ok(`ref: refs/heads/main\tHEAD\n${head}\tHEAD\n${head}\trefs/heads/main\n`)
    if (argv.includes('rev-parse')) return ok(`${head}\n`)
    if (argv.includes('count-objects')) return ok('size: 0\nsize-pack: 12\n')
    return ok()
  }

  test('shows the commit it fetched and records it with the decision', async ($, on) => {
    const store = new Map<string, unknown>()
    on('store.get', ($, e) => ({ value: store.get(e.key) }))
    on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
    on('store.delete', ($, e) => (store.delete(e.key), { value: undefined }))
    serveUi(on)
    serveFixture(on, WORK, fixture('clean-plugin'), { run: git })
    const answer = await $.command.run(typed('guard', 'scan github:acme/notes'))
    expect(answer.text).toContain('Safe to install')
    const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })

    expect(await pane.find({ type: 'Text', text: new RegExp(`commit ${SHA.slice(0, 12)}`) })).toBeDefined()
    await pane.press({ key: 'install' })
    const [decision] = store.get('decisions') as { sha?: string; root?: string }[]
    expect(decision?.sha).toBe(SHA)
    expect(decision?.root).toBe('https://github.com/acme/notes.git')
    await pane.unmount()
  })

  test('another commit with the same files is judged on its own', async ($, on) => {
    mock.store(on)
    serveUi(on)
    serveFixture(on, WORK, fixture('clean-plugin'), { run: git })
    head = SHA
    await $.command.run(typed('guard', 'scan github:acme/notes'))
    const first = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })
    await first.press({ key: 'install' })
    await first.unmount()
    head = 'c'.repeat(40)
    await $.command.run(typed('guard', 'scan github:acme/notes'))
    const again = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })

    expect(await again.find({ key: 'install' })).toBeDefined()
    expect(await again.find({ type: 'Text', text: /^Approved on/ })).toBeUndefined()
    await again.unmount()
    head = SHA
  })

  test('--ref and --path on a folder are refused', async ($, on) => {
    mock.store(on)
    serveUi(on)
    serveFixture(on, ROOT, fixture('clean-plugin'))
    const answer = await $.command.run(typed('guard', `scan --ref main ${ROOT}`))
    expect(answer.text).toContain('apply to a repository')
  })
})

describe('a row explains itself before it shows code', () => {
  for (const surface of SURFACES) {
    test(`${surface}: the summary first, the code behind its own toggle`, async ($, on) => {
      mock.store(on)
      serveUi(on)
      serveFixture(on, ROOT, fixture('script-exec'))
      await $.command.run(typed('guard', `scan ${ROOT}`))
      const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface, component: 'Pane', requestId: PANE_ID, props: paneProps() })
      await pane.press({ key: 'toggle-code.execution' })

      expect(await pane.find({ type: 'Text', text: /^Starts / })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /runs programs:/ })).toBeUndefined()
      await pane.press({ key: 'code-code.execution' })
      expect(await pane.find({ type: 'Text', text: /runs programs:/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^Hide the code$/ })).toBeDefined()
      await pane.unmount()
    })
  }
})

describe('the README badge', () => {
  const SHA = 'a'.repeat(40)
  const TREE = `sha256:${'b'.repeat(64)}`
  const view = (kind: GuardView['verdict'] extends infer V ? (V extends { kind: infer K } ? K : never) : never, extra: Partial<GuardView> = {}): GuardView => ({
    target: 'acme/notes',
    action: 'approve',
    stage: '',
    verdict: { kind, recommendation: { safe: 'Safe to install', caution: 'Install with caution', reject: 'Do not install', unverified: 'Could not verify' }[kind], reasons: [], counts: { pass: 1, warn: 0, fail: 0, info: 0 } },
    rows: [],
    expanded: [],
    details: false,
    confirming: false,
    treeHash: TREE,
    ...extra,
  })

  test('names the verdict and the exact version, and links to how to check it', () => {
    const made = badgeFor(view('safe', { sha: SHA }))
    expect('markdown' in made && made.markdown).toBe(
      `[![AI Install Guard: Safe to install at aaaaaaa](https://img.shields.io/badge/AI_Install_Guard-safe_to_install_%C2%B7_aaaaaaa-2ea44f)](https://github.com/ziniman/ai-install-guard#review-badge "Scanned at commit ${SHA}, ${TREE}")`,
    )
    const local = badgeFor(view('caution'))
    expect('markdown' in local && local.markdown).toContain('install_with_caution_%C2%B7_tree_bbbbbbbb-dbab09')
  })

  test('there is no badge for Do not install, Could not verify, or nothing scanned', () => {
    expect(badgeFor(view('reject'))).toEqual({ refusal: 'There is no badge for Do not install.' })
    expect(badgeFor(view('unverified'))).toEqual({ refusal: 'There is no badge for Could not verify.' })
    expect('refusal' in badgeFor(undefined)).toBe(true)
    expect('refusal' in badgeFor(view('safe', { treeHash: undefined }))).toBe(true)
  })

  test('/guard badge after a scan, and Copy badge in the pane', async ($, on) => {
    mock.store(on)
    const ui = serveUi(on)
    serveFixture(on, ROOT, fixture('clean-plugin'))
    await $.command.run(typed('guard', `scan ${ROOT}`))
    const answer = await $.command.run(typed('guard', 'badge'))
    expect(answer.text).toContain('[![AI Install Guard: Safe to install at tree ')

    const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })
    await pane.press({ key: 'badge' })
    expect(ui.copied.at(-1)).toContain('img.shields.io/badge/AI_Install_Guard-safe_to_install')
    await pane.unmount()
  })

  test('no Copy badge for a candidate that fails', async ($, on) => {
    mock.store(on)
    serveUi(on)
    serveFixture(on, ROOT, fixture('curl-hook'))
    await $.command.run(typed('guard', `scan ${ROOT}`))
    const pane = await $.ui.mount({ plugin: 'ai-install-guard', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: paneProps() })
    expect(await pane.find({ key: 'badge' })).toBeUndefined()
    expect((await $.command.run(typed('guard', 'badge'))).text).toContain('There is no badge for Do not install')
    await pane.unmount()
  })
})

import { describe, expect, mock, test } from 'claude-code/testing'

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

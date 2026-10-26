import { isTestPath, type ScanContext } from './context'
import type { CheckResult } from './types'

/** Group 1's local part: a license. The rest of provenance needs the repo. */
export function licenseCheck(ctx: ScanContext): CheckResult {
  const file = ctx.files.find(entry => /^(?:license|licence|copying)(?:\.[a-z]+)?$/i.test(entry.path))
  const declared = typeof ctx.manifest?.license === 'string' && ctx.manifest.license.trim() !== '' ? ctx.manifest.license.trim() : undefined
  const found = file?.path ?? (declared === undefined ? undefined : `license "${declared}" in plugin.json`)
  return {
    id: 'provenance.license',
    group: 'provenance',
    title: 'License',
    // A missing license is about your right to the code, not your safety: noted, never a reason to look twice.
    status: found === undefined ? 'info' : 'pass',
    severity: 'none',
    evidence: found === undefined ? [{ file: '-', excerpt: 'no LICENSE file and no license in plugin.json', status: 'info' }] : [{ file: found, excerpt: 'license present', status: 'pass' }],
    advice: 'Without a license you have no clear right to use or change the code, and it is a sign of a hurried or throwaway project.',
  }
}

/** Group 9: reported, never a reason to fail. */
export function qualityChecks(ctx: ScanContext): CheckResult[] {
  const tests = ctx.files.filter(file => isTestPath(file.path)).length
  const readme = ctx.readme?.text ?? ''
  const explainsUninstall = /\b(?:uninstall|remove|disable)\b/i.test(readme)
  return [
    {
      id: 'quality.tests',
      group: 'quality',
      title: 'Tests',
      status: 'info',
      severity: 'none',
      evidence: [{ file: '-', excerpt: tests > 0 ? `${tests} test file${tests === 1 ? '' : 's'} (not run)` : 'no tests found' }],
      advice: 'Tests are a sign of care. They are never run here.',
    },
    {
      id: 'quality.readme',
      group: 'quality',
      title: 'README',
      status: 'info',
      severity: 'none',
      evidence: [
        {
          file: ctx.readme?.path ?? '-',
          excerpt:
            readme.trim().length < 80
              ? 'no README that says what it does'
              : explainsUninstall
                ? 'says what it does and how to remove it'
                : 'does not say how to uninstall',
          status: 'info',
        },
      ],
      advice: 'A README should say what the plugin does, what it needs and how to remove it.',
    },
  ]
}

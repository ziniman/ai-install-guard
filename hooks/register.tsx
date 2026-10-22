import type { Register } from 'claude-code'

import { modHost } from './mod-host'
import type { Host } from './scan/host'
import { formatReport } from './scan/report'
import { safeLine } from './scan/safe-text'
import { scanFolder } from './scan/scan'

const USAGE = [
  'Usage:',
  '  /guard scan <path>            Scan a local plugin, mod or skill folder without installing it',
  '  /guard scan --details <path>  The same, with every finding and the advice for each',
].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'guard',
      description: 'Scan a plugin, mod, skill or MCP server without installing it',
      argumentHint: 'scan [--details] <path>',
    })
    return next(e)
  })

  on('command.run', { command: 'guard' }, async ($, e) => {
    const { sub, rest, details } = splitArgs(e.args)
    const target = rest
    if (sub !== 'scan' || target === '') {
      return { text: USAGE }
    }
    const host = modHost($)
    try {
      const report = await scanFolder(host, target, await expandHome(host, target))
      return { text: formatReport(report, { details }) }
    } catch (error) {
      return { text: `Could not verify ${safeLine(target)}: ${safeLine(reasonOf(error))}` }
    }
  }).catch(() => ({ text: 'AI Install Guard: the command failed before it could answer.' }))
}

/**
 * `scan --details "my folder"` → `{ sub: 'scan', details: true, rest: 'my folder' }`.
 * `--details` counts only as its own token right after the subcommand, so a
 * quoted path that contains it is left whole.
 */
export function splitArgs(args: string): { sub: string; rest: string; details: boolean } {
  const trimmed = args.trim()
  const space = trimmed.search(/\s/)
  const sub = space === -1 ? trimmed : trimmed.slice(0, space)
  let rest = space === -1 ? '' : trimmed.slice(space).trim()
  const details = /^--details(?:\s|$)/.test(rest)
  if (details) rest = rest.slice('--details'.length).trim()
  return { sub: sub.toLowerCase(), rest: unquote(rest), details }
}

function unquote(text: string): string {
  return /^(["']).*\1$/.test(text) ? text.slice(1, -1) : text
}

async function expandHome(host: Host, path: string): Promise<string> {
  if (path !== '~' && !path.startsWith('~/')) {
    return path
  }
  const { exitCode, stdout } = await host.run(['printenv', 'HOME'])
  const home = stdout.trim()
  if (exitCode !== 0 || home === '') {
    throw new Error('could not find the home folder')
  }
  return home + path.slice(1)
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

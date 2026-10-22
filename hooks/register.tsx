import type { Register } from 'claude-code'

import { modHost } from './mod-host'
import type { Host } from './scan/host'
import { takeInventory } from './scan/inventory'
import { formatInventory } from './scan/report'
import { safeLine } from './scan/safe-text'

const USAGE = [
  'Usage:',
  '  /guard scan <path>   Scan a local plugin, mod or skill folder without installing it',
].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'guard',
      description: 'Scan a plugin, mod, skill or MCP server without installing it',
      argumentHint: 'scan <path>',
    })
    return next(e)
  })

  on('command.run', { command: 'guard' }, async ($, e) => {
    const { sub, rest } = splitArgs(e.args)
    if (sub !== 'scan' || rest === '') {
      return { text: USAGE }
    }
    const host = modHost($)
    try {
      const tree = await takeInventory(host, await expandHome(host, rest))
      return { text: formatInventory(rest, tree.inventory) }
    } catch (error) {
      return { text: `Could not verify ${safeLine(rest)}: ${safeLine(reasonOf(error))}` }
    }
  }).catch(() => ({ text: 'AI Install Guard: the command failed before it could answer.' }))
}

/** `scan "my folder"` → `{ sub: 'scan', rest: 'my folder' }`. */
export function splitArgs(args: string): { sub: string; rest: string } {
  const trimmed = args.trim()
  const space = trimmed.search(/\s/)
  const sub = space === -1 ? trimmed : trimmed.slice(0, space)
  const rest = space === -1 ? '' : trimmed.slice(space).trim()
  const unquoted = /^(["']).*\1$/.test(rest) ? rest.slice(1, -1) : rest
  return { sub: sub.toLowerCase(), rest: unquoted }
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

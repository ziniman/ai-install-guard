// The guard's own version, as the copy Claude Code loaded says it: read once
// from its plugin.json, so the pane and the report name the version that
// actually ran the scan.

import type { EngineInterface } from 'claude-code'

let read: Promise<string | undefined> | undefined

/** The loaded guard's version, or undefined when its manifest cannot be read. */
export function ownVersion($: EngineInterface): Promise<string | undefined> {
  read ??= $.fs
    .read(`${$.plugin.root}/.claude-plugin/plugin.json`)
    .then(text => {
      const parsed: unknown = JSON.parse(typeof text === 'string' ? text : '')
      const version = typeof parsed === 'object' && parsed !== null ? (parsed as { version?: unknown }).version : undefined
      return typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]{1,40})?$/.test(version) ? version : undefined
    })
    .catch(() => undefined)
    .then(version => {
      // A manifest that could not be read is tried again next time.
      if (version === undefined) read = undefined
      return version
    })
  return read
}

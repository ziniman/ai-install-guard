// A folder that exists only in memory: the files the guard builds to scan
// something that has no folder of its own, such as the configuration of an
// MCP server Claude is about to add. It lists and reads those files and
// nothing else, has no links, and runs nothing.

import type { Host, HostEntry, HostStat } from './host'

const encoder = new TextEncoder()

/** A host whose only folder is `root`, holding `files` (relative path to text). Network requests go to `fetch`, when given. */
export function virtualHost(root: string, files: Readonly<Record<string, string>>, fetch?: Host['fetch']): Host {
  const top = trim(root)
  const bytes = new Map(Object.entries(files).map(([rel, text]) => [`${top}/${rel}`, encoder.encode(text)]))
  const dirs = new Set([top])
  for (const path of bytes.keys()) {
    for (let dir = path.slice(0, path.lastIndexOf('/')); dir.length > top.length; dir = dir.slice(0, dir.lastIndexOf('/'))) dirs.add(dir)
  }
  const missing = (path: string): Error => new Error(`ENOENT: no such file or directory, '${path}'`)
  return {
    ...(fetch === undefined ? {} : { fetch }),
    list: async raw => {
      const path = trim(raw)
      if (!dirs.has(path)) throw missing(path)
      const names = new Map<string, HostEntry>()
      for (const dir of dirs) if (dir.startsWith(`${path}/`)) {
        const name = dir.slice(path.length + 1).split('/')[0] as string
        names.set(name, { name, kind: 'dir', size: 0, isLink: false })
      }
      for (const [file, content] of bytes) if (file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes('/')) {
        const name = file.slice(path.length + 1)
        names.set(name, { name, kind: 'file', size: content.length, isLink: false })
      }
      return [...names.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
    },
    stat: async (raw, options): Promise<HostStat> => {
      const path = trim(raw)
      const real = options?.resolve === true ? { realPath: path } : {}
      if (dirs.has(path)) return { kind: 'dir', size: 0, isLink: false, ...real }
      const content = bytes.get(path)
      if (content === undefined) throw missing(path)
      return { kind: 'file', size: content.length, isLink: false, ...real }
    },
    readBytes: async raw => {
      const content = bytes.get(trim(raw))
      if (content === undefined) throw missing(trim(raw))
      return content
    },
    readLink: async raw => {
      throw new Error(`${trim(raw)} is not a link: a folder the guard builds has none`)
    },
    run: async () => {
      throw new Error('nothing runs in a folder the guard builds')
    },
  }
}

function trim(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

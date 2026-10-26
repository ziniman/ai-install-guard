// A real folder with one file as it is about to be written: the guard scans
// a skill folder as it would be once Claude's write lands, before it lands.
// Every other file, link and folder is the real one; nothing runs.

import type { Host, HostEntry, HostStat } from './host'

/**
 * `base` with the file at `root`/`rel` holding `content`. The folders on the
 * way to it exist even when they do not yet, as the write would make them.
 */
export function overlayHost(base: Host, root: string, rel: string, content: Uint8Array): Host {
  const top = trim(root)
  const file = `${top}/${rel}`
  const folders = new Set<string>([top])
  for (let dir = file.slice(0, file.lastIndexOf('/')); dir.length > top.length; dir = dir.slice(0, dir.lastIndexOf('/'))) folders.add(dir)
  return {
    ...(base.fetch === undefined ? {} : { fetch: base.fetch }),
    list: async raw => {
      const path = trim(raw)
      // A folder the write would make is empty until it does; one that is there but cannot be listed is an error.
      const real = await base.list(path).catch(async (error: unknown) => {
        if (folders.has(path) && (await base.stat(path).catch(() => undefined)) === undefined) return [] as HostEntry[]
        throw error
      })
      if (!folders.has(path)) return real
      // The child on the way to the file, or the file itself.
      const child = file.slice(path.length + 1).split('/')[0] as string
      const entry: HostEntry = `${path}/${child}` === file ? { name: child, kind: 'file', size: content.length, isLink: false } : { name: child, kind: 'dir', size: 0, isLink: false }
      return [...real.filter(item => item.name !== child), entry].sort((a, b) => (a.name < b.name ? -1 : 1))
    },
    stat: async (raw, options): Promise<HostStat> => {
      const path = trim(raw)
      const real = options?.resolve === true ? { realPath: path } : {}
      if (path === file) return { kind: 'file', size: content.length, isLink: false, ...real }
      if (folders.has(path)) {
        const there = await base.stat(path, options).catch(() => undefined)
        return there?.kind === 'dir' ? there : { kind: 'dir', size: 0, isLink: false, ...real }
      }
      return base.stat(path, options)
    },
    readBytes: async raw => (trim(raw) === file ? content : base.readBytes(raw)),
    readLink: raw => base.readLink(raw),
    run: () => Promise.reject(new Error('nothing runs while the guard reads a write')),
  }
}

function trim(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

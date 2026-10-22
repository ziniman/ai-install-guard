import type { On } from 'claude-code'

import { fromBase64, type Host, type HostEntry, type HostStat } from '../scan/host'

export type FixtureFile = { base64: string } | { link: string }
export type FixtureFiles = Record<string, FixtureFile>

/** The home folder the memory host reports for `printenv HOME`. */
export const HOME = '/home/tester'

/**
 * A host that answers from `files`, laid out under `root`. Reading through a
 * symbolic link throws, so a test fails if the scanner ever follows one.
 */
export function memoryHost(root: string, files: FixtureFiles): Host {
  const dirs = new Set<string>([root])
  for (const rel of Object.keys(files)) {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      dirs.add(`${root}/${parts.slice(0, i).join('/')}`)
    }
  }
  const fileAt = (path: string): FixtureFile | undefined =>
    path.startsWith(`${root}/`) ? files[path.slice(root.length + 1)] : undefined
  const owns = (path: string): boolean => dirs.has(path) || fileAt(path) !== undefined

  const stat = async (raw: string, options?: { resolve: boolean }): Promise<HostStat> => {
    const path = trimSlash(raw)
    const resolve = options?.resolve === true
    if (dirs.has(path)) {
      return { kind: 'dir', size: 0, isLink: false, ...(resolve ? { realPath: path } : {}) }
    }
    const file = fileAt(path)
    if (file === undefined) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
    }
    if ('link' in file) {
      const real = resolveLink(path, file.link)
      const target = fileAt(real)
      const kind = dirs.has(real) ? 'dir' : target !== undefined && 'base64' in target ? 'file' : 'other'
      return { kind, size: 0, isLink: true, ...(resolve ? { realPath: real } : {}) }
    }
    return { kind: 'file', size: fromBase64(file.base64).length, isLink: false, ...(resolve ? { realPath: path } : {}) }
  }

  const list = async (raw: string): Promise<HostEntry[]> => {
    const path = trimSlash(raw)
    if (!dirs.has(path)) {
      throw new Error(`ENOENT: no such directory, scandir '${path}'`)
    }
    const names = new Set<string>()
    for (const candidate of [...dirs, ...Object.keys(files).map(rel => `${root}/${rel}`)]) {
      if (candidate.startsWith(`${path}/`)) {
        names.add(candidate.slice(path.length + 1).split('/')[0] as string)
      }
    }
    return [...names].sort().map(name => {
      const child = `${path}/${name}`
      if (dirs.has(child)) {
        return { name, kind: 'dir', size: 0, isLink: false }
      }
      const file = fileAt(child) as FixtureFile
      return 'link' in file
        ? { name, kind: 'other', size: 0, isLink: true }
        : { name, kind: 'file', size: fromBase64(file.base64).length, isLink: false }
    })
  }

  const readBytes = async (raw: string): Promise<Uint8Array> => {
    const path = trimSlash(raw)
    const file = fileAt(path)
    if (file === undefined) {
      throw new Error(`ENOENT: no such file, open '${path}'`)
    }
    if ('link' in file) {
      throw new Error(`test: the scanner read through the symbolic link ${path}`)
    }
    return fromBase64(file.base64)
  }

  const run: Host['run'] = async argv => {
    if (argv[0] === 'printenv' && argv[1] === 'HOME') {
      return { exitCode: 0, stdout: `${HOME}\n`, stderr: '' }
    }
    return { exitCode: 127, stdout: '', stderr: `test: no answer for ${argv.join(' ')}` }
  }

  return Object.assign({ list, stat, readBytes, run }, { owns })
}

/**
 * Answers the engine's `fs.*` and `process.run` beneath the plugin from
 * `files` under `root`; a path outside `root` goes on to the next answer.
 */
export function serveFixture(on: On, root: string, files: FixtureFiles): void {
  const host = memoryHost(root, files) as Host & { owns: (path: string) => boolean }
  const toBase64 = (bytes: Uint8Array): string => {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }

  on('fs.stat', async ($, e, next) =>
    host.owns(trimSlash(e.path))
      ? { value: { ...(await host.stat(e.path, { resolve: e.resolve })), mtimeMs: 0 } }
      : next(e),
  )
  on('fs.list', async ($, e, next) =>
    host.owns(trimSlash(e.path))
      ? { value: (await host.list(e.path)).map(entry => ({ ...entry, mtimeMs: 0 })) }
      : next(e),
  )
  on('fs.read', async ($, e, next) => {
    if (!host.owns(trimSlash(e.path))) {
      return next(e)
    }
    const bytes = await host.readBytes(e.path)
    return { value: e.as === 'bytes' ? { base64: toBase64(bytes) } : new TextDecoder().decode(bytes) }
  })
  on('process.run', async ($, e, next) => {
    if (e.argv[0] !== 'printenv') {
      return next(e)
    }
    const result = await host.run(e.argv)
    return { value: { ...result, isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

function resolveLink(linkPath: string, target: string): string {
  const base = target.startsWith('/') ? [] : linkPath.split('/').slice(0, -1)
  for (const part of target.split('/')) {
    if (part === '..') base.pop()
    else if (part !== '.' && part !== '') base.push(part)
  }
  return `/${base.filter(part => part !== '').join('/')}`
}

/** A slash command as the person types it at the prompt. */
export function typed(command: string, args: string) {
  return {
    command,
    args,
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: false, columns: 100 },
  }
}

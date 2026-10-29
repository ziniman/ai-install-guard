import type { On } from 'claude-code'

import { fromBase64, type Host, type HostEntry, type HostStat, type RunResult } from '../scan/host'

/** A file's bytes, a symbolic link's stored target, or an empty folder. */
export type FixtureFile = { base64: string } | { link: string } | { dir: true }
export type FixtureFiles = Record<string, FixtureFile>

/** The home folder the memory host reports for `printenv HOME`. */
export const HOME = '/home/tester'

/**
 * A host that answers from `files`, laid out under `root`. Reading through a
 * symbolic link throws, so a test fails if the scanner ever follows one. A
 * link that lands outside `root` is treated as leading somewhere real; one
 * that lands on a missing path inside `root` leads nowhere.
 */
export function memoryHost(root: string, files: FixtureFiles): Host {
  const dirs = new Set<string>([root])
  for (const [rel, file] of Object.entries(files)) {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      dirs.add(`${root}/${parts.slice(0, i).join('/')}`)
    }
    if ('dir' in file) dirs.add(`${root}/${rel}`)
  }
  const fileAt = (path: string): FixtureFile | undefined => {
    const file = path.startsWith(`${root}/`) ? files[path.slice(root.length + 1)] : undefined
    return file !== undefined && 'dir' in file ? undefined : file
  }
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
      const isOutside = real !== root && !real.startsWith(`${root}/`)
      const leadsSomewhere = isOutside || dirs.has(real) || target !== undefined
      const kind = dirs.has(real) ? 'dir' : target !== undefined && 'base64' in target ? 'file' : 'other'
      return { kind, size: 0, isLink: true, ...(resolve && leadsSomewhere ? { realPath: real } : {}) }
    }
    if (!('base64' in file)) {
      throw new Error(`test: unexpected entry at ${path}`)
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
      return 'base64' in file
        ? { name, kind: 'file', size: fromBase64(file.base64).length, isLink: false }
        : { name, kind: 'other', size: 0, isLink: true }
    })
  }

  const readBytes = async (raw: string): Promise<Uint8Array> => {
    const path = trimSlash(raw)
    const file = fileAt(path)
    if (file === undefined) {
      throw new Error(`ENOENT: no such file, open '${path}'`)
    }
    if (!('base64' in file)) {
      throw new Error(`test: the scanner read through the symbolic link ${path}`)
    }
    return fromBase64(file.base64)
  }

  const readLink = async (raw: string): Promise<string> => {
    const file = fileAt(trimSlash(raw))
    if (file === undefined || !('link' in file)) {
      throw new Error(`EINVAL: not a symbolic link, readlink '${raw}'`)
    }
    return file.link
  }

  const run: Host['run'] = async argv => {
    if (argv[0] === 'printenv' && argv[1] === 'HOME') {
      return { exitCode: 0, stdout: `${HOME}\n`, stderr: '' }
    }
    if (argv[0] === 'readlink' && argv[1] !== undefined) {
      return readLink(argv[1]).then(
        target => ({ exitCode: 0, stdout: `${target}\n`, stderr: '' }),
        (error: Error) => ({ exitCode: 1, stdout: '', stderr: error.message }),
      )
    }
    return { exitCode: 127, stdout: '', stderr: `test: no answer for ${argv.join(' ')}` }
  }

  return Object.assign({ list, stat, readBytes, readLink, run }, { owns })
}

/**
 * Answers the engine's `fs.*` and `process.run` beneath the plugin from
 * `files` under `root`; a path outside `root` goes on to the next answer.
 * With `platform: 'windows'` there is no `readlink`, only PowerShell.
 */
export function serveFixture(
  on: On,
  root: string,
  files: FixtureFiles,
  options: {
    platform?: 'posix' | 'windows'
    homeFails?: () => boolean
    /** Answers other commands (git, mktemp); undefined passes them on. */
    run?: (argv: readonly string[]) => RunResult | undefined
    /** Where a path asked for is served from: a folder the engine names (an inline test plugin's) laid at `root`. */
    moved?: (path: string) => string
    /** Paths whose reading fails, as a file the guard may not read. */
    unreadable?: (path: string) => boolean
  } = {},
): void {
  const isWindows = options.platform === 'windows'
  const at = options.moved ?? ((path: string) => path)
  const host = memoryHost(root, files) as Host & { owns: (path: string) => boolean }
  const toBase64 = (bytes: Uint8Array): string => {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }

  on('fs.stat', async ($, e, next) =>
    host.owns(trimSlash(at(e.path)))
      ? { value: { ...(await host.stat(at(e.path), { resolve: e.resolve })), mtimeMs: 0 } }
      : next(e),
  )
  on('fs.list', async ($, e, next) =>
    host.owns(trimSlash(at(e.path)))
      ? { value: (await host.list(at(e.path))).map(entry => ({ ...entry, mtimeMs: 0 })) }
      : next(e),
  )
  on('fs.read', async ($, e, next) => {
    if (!host.owns(trimSlash(at(e.path)))) {
      return next(e)
    }
    if (options.unreadable?.(at(e.path)) === true) return { deny: 'the file cannot be read' }
    const bytes = await host.readBytes(at(e.path))
    return { value: e.as === 'bytes' ? { base64: toBase64(bytes) } : new TextDecoder().decode(bytes) }
  })
  on('process.run', async ($, e, next) => {
    const done = (result: RunResult) => ({ value: { ...result, isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'printenv' && options.homeFails?.() === true) {
      return done({ exitCode: 1, stdout: '', stderr: '' })
    }
    if (e.argv[0] === 'readlink' && isWindows) {
      return done({ exitCode: 127, stdout: '', stderr: 'readlink: command not found' })
    }
    if (e.argv[0] === 'powershell' && isWindows) {
      const path = e.init?.env?.GUARD_LINK ?? ''
      if (!host.owns(trimSlash(path))) return next(e)
      return done(
        await host.readLink(path).then(
          target => ({ exitCode: 0, stdout: `${target}\r\n`, stderr: '' }),
          (error: Error) => ({ exitCode: 1, stdout: '', stderr: error.message }),
        ),
      )
    }
    const scripted = options.run?.(e.argv)
    if (scripted !== undefined) return done(scripted)
    const isOurs = e.argv[0] === 'printenv' || (e.argv[0] === 'readlink' && host.owns(trimSlash(e.argv[1] ?? '')))
    if (!isOurs) {
      return next(e)
    }
    return done(await host.run(e.argv))
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

/** What the plugin asked of the interface during a test. */
export type UiRecord = {
  opened: string[]
  closed: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  copied: string[]
}

/**
 * Answers the engine's `ui.open`, `ui.close`, `ui.toast`, `ui.status` and
 * `ui.copy` beneath the plugin, recording each. With `placed: false` no
 * surface takes the pane, as in a headless run.
 */
export function serveUi(on: On, options: { placed?: boolean } = {}): UiRecord {
  const record: UiRecord = { opened: [], closed: [], toasts: [], statuses: [], copied: [] }
  on('ui.open', ($, e) => {
    record.opened.push(e.id)
    return { value: options.placed === false ? { isPlaced: false, reason: 'no-surface' } : { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    record.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    record.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    record.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    record.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  return record
}

/** The props a surface hands a pane's draw. */
export function paneProps(bodyColumns = 100, scroll: { offset: number; bodyRows: number } = { offset: 0, bodyRows: 40 }) {
  return {
    title: 'AI Install Guard',
    isFocused: true,
    bodyColumns,
    placement: 'dock' as const,
    scroll,
    view: {},
  }
}

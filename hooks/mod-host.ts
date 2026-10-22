import type { EngineInterface } from 'claude-code'

import { fromBase64, type Host } from './scan/host'

// Windows PowerShell 5.1 answers a link's Target as an array; -join makes it one string.
const WINDOWS_READLINK = "[Console]::Out.Write(((Get-Item -LiteralPath $env:GUARD_LINK -Force).Target -join ''))"

/** The scanner's host inside Claude Code: `$.fs` reads, `$.process` runs. */
export function modHost($: EngineInterface): Host {
  return {
    list: path => $.fs.list(path),
    stat: (path, options) => $.fs.stat(path, options ?? { resolve: false }),
    readBytes: async path => fromBase64((await $.fs.read(path, { as: 'bytes' })).base64),
    readLink: async path => {
      const posix = await $.process.run(['readlink', path]).catch(() => undefined)
      if (posix !== undefined && posix.exitCode === 0) {
        return posix.stdout.endsWith('\n') ? posix.stdout.slice(0, -1) : posix.stdout
      }
      // Windows has no readlink. The path travels in the environment, never
      // in the command text, so no name can change what PowerShell runs.
      const windows = await $.process
        .run(['powershell', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_READLINK], { env: { GUARD_LINK: path } })
        .catch(() => undefined)
      if (windows !== undefined && windows.exitCode === 0 && windows.stdout.trim() !== '') {
        return windows.stdout.replace(/\r?\n$/, '')
      }
      throw new Error(`could not read the link ${path}`)
    },
    run: (argv, options) => $.process.run(argv, options),
  }
}

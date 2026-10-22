import type { EngineInterface } from 'claude-code'

import { fromBase64, type Host } from './scan/host'

/** The scanner's host inside Claude Code: `$.fs` reads, `$.process` runs. */
export function modHost($: EngineInterface): Host {
  return {
    list: path => $.fs.list(path),
    stat: (path, options) => $.fs.stat(path, options ?? { resolve: false }),
    readBytes: async path => fromBase64((await $.fs.read(path, { as: 'bytes' })).base64),
    run: (argv, options) => $.process.run(argv, options),
  }
}

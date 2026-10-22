import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const { stdout } = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    $.ui.toast(`On branch ${stdout.trim()}`)
    return next(e)
  })
}

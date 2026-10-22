import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.process.run(['sh', '-c', 'echo hi'])
    return next(e)
  })
}

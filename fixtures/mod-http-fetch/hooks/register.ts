import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const { text } = await $.http.fetch('https://weather.example.net/today')
    $.ui.toast(text.slice(0, 80))
    return next(e)
  })
}

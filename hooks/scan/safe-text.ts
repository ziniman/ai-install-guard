// Text taken from a candidate (file names, excerpts) is untrusted: it may
// carry terminal escapes or invisible characters meant to hide what it says.
// Everything a report shows from a candidate goes through `safeText` first.

const HIDDEN = new RegExp(
  [
    '[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]', // control characters (escapes, NUL, C1)
    '[\\u00ad\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]', // invisible and bidi controls
    '[\\ufe00-\\ufe0f]', // variation selectors
    '[\\u{e0000}-\\u{e007f}]', // tag characters
    '[\\u{e0100}-\\u{e01ef}]', // variation selectors supplement
  ].join('|'),
  'gu',
)

/** Shows each hidden or control character as `<U+XXXX>` so it can be seen. */
export function safeText(text: string): string {
  return text.replace(HIDDEN, char => {
    const code = char.codePointAt(0) as number
    return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`
  })
}

/** `safeText` for text that must stay on one line, such as a file name. */
export function safeLine(text: string): string {
  return safeText(text).replace(/\t/g, '<U+0009>').replace(/\n/g, '<U+000A>')
}

const EXCERPT_WIDTH = 100

export type Match = {
  /** Where the match starts in the text. */
  index: number
  line: number
  /** The matched text. */
  text: string
  /** A short window of the line around the match, for evidence. */
  excerpt: string
}

/**
 * Every match of `pattern` in `text`, with 1-based line numbers, up to
 * `limit` of those `keep` accepts. Rejected matches are skipped before they
 * count, so no number of decoys can use up the limit.
 */
export function findAll(text: string, pattern: RegExp, limit = 20, keep?: (index: number) => boolean): Match[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const global = new RegExp(pattern.source, flags)
  const starts = lineStarts(text)
  const matches: Match[] = []
  for (const found of text.matchAll(global)) {
    const index = found.index ?? 0
    if (keep !== undefined && !keep(index)) {
      if (found[0].length === 0) global.lastIndex += 1
      continue
    }
    const line = lineAt(starts, index)
    const lineStart = starts[line - 1] as number
    const lineEnd = line < starts.length ? (starts[line] as number) - 1 : text.length
    // Only a window around the match is copied, so a match on a huge line stays cheap.
    const from = Math.max(lineStart, index - EXCERPT_WIDTH)
    const to = Math.min(lineEnd, index + found[0].length + EXCERPT_WIDTH)
    const window = text.slice(from, to)
    const cut = excerpt(window, index - from, found[0].length)
    matches.push({ index, line, text: found[0], excerpt: `${from > lineStart && !cut.startsWith('…') ? '…' : ''}${cut}${to < lineEnd && !cut.endsWith('…') ? '…' : ''}` })
    if (matches.length >= limit) break
    if (found[0].length === 0) global.lastIndex += 1
  }
  return matches
}

/** The first match, or undefined. */
export function findFirst(text: string, pattern: RegExp): Match | undefined {
  return findAll(text, pattern, 1)[0]
}

/** The 1-based line holding `needle`, or undefined. */
export function lineOf(text: string, needle: string): number | undefined {
  const index = text.indexOf(needle)
  return index === -1 ? undefined : lineAt(lineStarts(text), index)
}

/** A window of `line` around [start, start + length), trimmed and marked with … where cut. */
export function excerpt(line: string, start = 0, length = 0): string {
  const trimmed = line.replace(/\r$/, '')
  if (trimmed.length <= EXCERPT_WIDTH) {
    return trimmed.trim()
  }
  const center = start + Math.floor(length / 2)
  const from = Math.max(0, Math.min(center - EXCERPT_WIDTH / 2, trimmed.length - EXCERPT_WIDTH))
  const to = from + EXCERPT_WIDTH
  return `${from > 0 ? '…' : ''}${trimmed.slice(from, to).trim()}${to < trimmed.length ? '…' : ''}`
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

function lineAt(starts: readonly number[], index: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if ((starts[mid] as number) <= index) low = mid
    else high = mid - 1
  }
  return low + 1
}

/** `a/b` + `../c` → `c`; undefined when the path climbs out of the root. */
export function joinPath(dir: string, rel: string): string | undefined {
  const parts = rel.startsWith('/') ? [] : dir.split('/').filter(part => part !== '')
  for (const part of rel.split('/')) {
    if (part === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
    } else if (part !== '.' && part !== '') {
      parts.push(part)
    }
  }
  return parts.join('/')
}

export function dirname(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function extension(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * `comment` is a comment that fills its line from the start; `trailing-comment`
 * starts after code on its line. The tokenizer can be fooled, and a comment
 * hiding a command is a classic trick, so only a whole-line comment is fully
 * trusted to be inert.
 */
export type SpanKind = 'code' | 'string' | 'comment' | 'trailing-comment' | 'regex'

/**
 * What each character of a source file is: code, inside a string, a
 * comment or (in JavaScript) a regular expression literal. A lightweight
 * tokenizer, good enough to tell a pattern or a remark about `.ssh` from code
 * that opens it.
 */
export function spanKinds(text: string, language: 'js' | 'python' | 'shell' | 'other'): (index: number) => SpanKind {
  const kinds = new Uint8Array(text.length)
  const CODE = 0
  const STRING = 1
  const COMMENT = 2
  const REGEX = 3
  const TRAILING = 4
  const mark = (from: number, to: number, kind: number): void => {
    kinds.fill(kind, from, Math.min(to, text.length))
  }
  /** A comment starting at `at` fills its line when only blanks precede it. */
  const commentKind = (at: number): number => {
    const lineStart = text.lastIndexOf('\n', at - 1) + 1
    return /^[ \t]*$/.test(text.slice(lineStart, at)) ? COMMENT : TRAILING
  }
  let i = 0
  let lastSignificant = ''
  let lastWord = ''
  // After a `/` that opened no literal on its line, the rest of that line is
  // not tried again: one pass per line, so `[/[/[/...` cannot stall the scan.
  let noRegexBefore = 0
  while (i < text.length) {
    const char = text[i] as string
    const next = text[i + 1]
    if (language === 'js' && char === '/' && next === '/') {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? text.length : end
      mark(i, stop, commentKind(i))
      i = stop
      continue
    }
    if (language === 'js' && char === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      mark(i, stop, commentKind(i))
      i = stop
      continue
    }
    // In shell, `#` starts a comment only at the start of a word: after an
    // unescaped blank (`echo \ #` keeps the `#` in the word) or a line start.
    const isShellComment = language === 'shell' && (i === 0 || (/\s/.test(text[i - 1] as string) && text[i - 2] !== '\\'))
    if (char === '#' && (language === 'python' || isShellComment)) {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? text.length : end
      mark(i, stop, commentKind(i))
      i = stop
      continue
    }
    if (char === '`' && language === 'js') {
      // A template literal: its text is a string, each `${...}` inside it is
      // code (and may hold strings and templates of its own).
      const end = templateEnd(text, i, mark, STRING, CODE)
      i = end
      lastSignificant = '`'
      continue
    }
    if (char === '"' || char === "'") {
      const triple = language === 'python' && text.startsWith(char.repeat(3), i)
      const quote = triple ? char.repeat(3) : char
      let j = i + quote.length
      while (j < text.length) {
        // A backslash escapes in every string but a shell's plain single-quoted
        // one; in a shell `$'...'` string it escapes again.
        if (text[j] === '\\' && !(language === 'shell' && char === "'" && text[i - 1] !== '$')) {
          j += 2
          continue
        }
        if (text.startsWith(quote, j)) {
          j += quote.length
          break
        }
        if (!triple && text[j] === '\n' && language !== 'shell') break
        j += 1
      }
      mark(i, j, STRING)
      i = j
      lastSignificant = char
      continue
    }
    if (language === 'js' && char === '/' && i >= noRegexBefore && regexCanStart(lastSignificant, lastWord)) {
      let j = i + 1
      let inClass = false
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === '[') inClass = true
        else if (text[j] === ']') inClass = false
        else if (text[j] === '/' && !inClass) break
        j += 1
      }
      // Only a literal with an escape inside counts as a pattern: real
      // patterns nearly always have one, and code dressed up as a regex by
      // stray slashes rarely does, so it stays code.
      if (text[j] === '/') {
        // The literal is skipped as one unit either way, so a `/*` inside it
        // never opens a comment. Only one with an escape counts as a pattern;
        // without one, what it holds is judged as code.
        const isPattern = text.slice(i + 1, j).includes('\\')
        j += 1
        while (j < text.length && /[a-z]/i.test(text[j] as string)) j += 1
        mark(i, j, isPattern ? REGEX : CODE)
        i = j
        lastSignificant = '/'
        continue
      }
      noRegexBefore = j
    }
    if (!/\s/.test(char)) {
      const before = lastSignificant
      // `x++ / y` and `x-- / y` divide: a postfix operator ends an operand.
      lastSignificant = (char === '+' || char === '-') && text[i - 1] === char ? 'a' : char
      if (/[A-Za-z_$]/.test(char)) {
        let j = i
        while (j < text.length && /[\w$]/.test(text[j] as string)) j += 1
        // `obj.in` or `x.return` is a property, an operand, never a keyword.
        lastWord = before === '.' ? '' : text.slice(i, j)
        lastSignificant = 'a'
        i = j
        continue
      }
      lastWord = ''
    }
    i += 1
  }
  return index => (['code', 'string', 'comment', 'regex', 'trailing-comment'] as const)[kinds[index] ?? CODE] as SpanKind
}

/**
 * Marks a template literal starting at `start` (its backtick) and returns the
 * index after its closing backtick: text as `string`, each `${...}` as `code`,
 * with nested quotes and templates inside an interpolation skipped whole.
 */
const MAX_TEMPLATE_DEPTH = 32

function templateEnd(text: string, start: number, mark: (from: number, to: number, kind: number) => void, STRING: number, CODE: number, depth = 0): number {
  // Nested deeper than any real code: the rest is judged as code, never hidden.
  if (depth > MAX_TEMPLATE_DEPTH) {
    mark(start, text.length, CODE)
    return text.length
  }
  let j = start + 1
  let segment = start
  while (j < text.length) {
    if (text[j] === '\\') {
      j += 2
      continue
    }
    if (text[j] === '`') {
      mark(segment, j + 1, STRING)
      return j + 1
    }
    if (text[j] === '$' && text[j + 1] === '{') {
      mark(segment, j + 2, STRING)
      const close = interpolationEnd(text, j + 2, mark, STRING, CODE, depth + 1)
      j = close + 1
      segment = j
      continue
    }
    j += 1
  }
  mark(segment, text.length, STRING)
  return text.length
}

/** The index of the `}` closing an interpolation opened just before `start`. */
function interpolationEnd(text: string, start: number, mark: (from: number, to: number, kind: number) => void, STRING: number, CODE: number, nesting: number): number {
  let depth = 1
  let j = start
  let codeFrom = start
  while (j < text.length) {
    const char = text[j]
    if (char === '`') {
      mark(codeFrom, j, CODE)
      j = templateEnd(text, j, mark, STRING, CODE, nesting + 1)
      codeFrom = j
      continue
    }
    if (char === '"' || char === "'") {
      let k = j + 1
      while (k < text.length && text[k] !== char && text[k] !== '\n') k += text[k] === '\\' ? 2 : 1
      j = k + 1
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        mark(codeFrom, j, CODE)
        return j
      }
    }
    j += 1
  }
  mark(codeFrom, text.length, CODE)
  return text.length
}

function regexCanStart(lastSignificant: string, lastWord: string): boolean {
  if (lastSignificant === '') return true
  if (lastSignificant === 'a') return /^(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof)$/.test(lastWord)
  // Not after `)`, `]` or `}`: there a slash divides, and reading code as a
  // pattern would hide it.
  return /[(,=:[!&|?{;+\-*%<>~^]/.test(lastSignificant)
}

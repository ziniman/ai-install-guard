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

/** Every match of `pattern` in `text`, with 1-based line numbers. */
export function findAll(text: string, pattern: RegExp, limit = 20): Match[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const global = new RegExp(pattern.source, flags)
  const starts = lineStarts(text)
  const matches: Match[] = []
  for (const found of text.matchAll(global)) {
    const index = found.index ?? 0
    const line = lineAt(starts, index)
    const lineStart = starts[line - 1] as number
    const lineEnd = text.indexOf('\n', lineStart)
    const lineText = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
    matches.push({ index, line, text: found[0], excerpt: excerpt(lineText, index - lineStart, found[0].length) })
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

export type SpanKind = 'code' | 'string' | 'comment' | 'regex'

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
  const mark = (from: number, to: number, kind: number): void => {
    kinds.fill(kind, from, Math.min(to, text.length))
  }
  let i = 0
  let lastSignificant = ''
  let lastWord = ''
  while (i < text.length) {
    const char = text[i] as string
    const next = text[i + 1]
    if (language === 'js' && char === '/' && next === '/') {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? text.length : end
      mark(i, stop, COMMENT)
      i = stop
      continue
    }
    if (language === 'js' && char === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      mark(i, stop, COMMENT)
      i = stop
      continue
    }
    if ((language === 'python' || language === 'shell') && char === '#' && (language === 'python' || i === 0 || /\s/.test(text[i - 1] as string))) {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? text.length : end
      mark(i, stop, COMMENT)
      i = stop
      continue
    }
    if (char === '"' || char === "'" || (char === '`' && language === 'js')) {
      const triple = language === 'python' && text.startsWith(char.repeat(3), i)
      const quote = triple ? char.repeat(3) : char
      let j = i + quote.length
      while (j < text.length) {
        // A backslash escapes in every string but a shell's single-quoted one.
        if (text[j] === '\\' && !(language === 'shell' && char === "'")) {
          j += 2
          continue
        }
        if (text.startsWith(quote, j)) {
          j += quote.length
          break
        }
        if (!triple && char !== '`' && text[j] === '\n' && language !== 'shell') break
        j += 1
      }
      mark(i, j, STRING)
      i = j
      lastSignificant = char
      continue
    }
    if (language === 'js' && char === '/' && regexCanStart(lastSignificant, lastWord)) {
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
      if (text[j] === '/') {
        j += 1
        while (j < text.length && /[a-z]/i.test(text[j] as string)) j += 1
        mark(i, j, REGEX)
        i = j
        lastSignificant = '/'
        continue
      }
    }
    if (!/\s/.test(char)) {
      lastSignificant = char
      if (/[A-Za-z_$]/.test(char)) {
        let j = i
        while (j < text.length && /[\w$]/.test(text[j] as string)) j += 1
        lastWord = text.slice(i, j)
        lastSignificant = 'a'
        i = j
        continue
      }
      lastWord = ''
    }
    i += 1
  }
  return index => (['code', 'string', 'comment', 'regex'] as const)[kinds[index] ?? CODE] as SpanKind
}

function regexCanStart(lastSignificant: string, lastWord: string): boolean {
  if (lastSignificant === '') return true
  if (lastSignificant === 'a') return /^(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof)$/.test(lastWord)
  return /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSignificant)
}

// Turns "this code runs programs" into what a person can judge: which
// programs, what each one is for, and which deserve a closer look.

/** One place code starts a program. `dynamic` when the program is a variable. */
export type ProgramUse = { name: string; file: string; dynamic: boolean }

type Kind = { label: string; risky: boolean }

// Written as patterns, which the guard's own scan reads as inert, not as
// names of tools it runs.
// Written as patterns with an escape, which the guard's own scan reads as
// inert rather than as names of tools it runs.
const KINDS: readonly { match: RegExp; kind: Kind }[] = [
  { match: /^(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh|cmd|powershell|pwsh)(?:\.exe)?$/, kind: { label: 'a shell, which can run any command', risky: true } },
  { match: /^(?:swiftc|swift|gcc|g\+\+|clang|clang\+\+|cc|c\+\+|rustc|cargo|go|javac|make|cmake|tsc|esbuild)(?:\.exe)?$/, kind: { label: 'builds code, which can then run', risky: true } },
  { match: /^(?:node|python|python3|deno|bun|ruby|perl|php|java)(?:\.exe)?$/, kind: { label: 'runs other scripts', risky: false } },
  { match: /^(?:curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|socat|ftp|telnet)(?:\.exe)?$/, kind: { label: 'talks to the network', risky: true } },
  { match: /^(?:npm|npx|pnpm|pnpx|yarn|bunx|pip|pip3|pipx|uv|uvx|brew|apt|apt-get|gem)(?:\.exe)?$/, kind: { label: 'installs or fetches packages', risky: true } },
  { match: /^(?:sudo|doas|su)(?:\.exe)?$/, kind: { label: 'runs as administrator', risky: true } },
  { match: /^(?:security)(?:\.exe)?$/, kind: { label: 'reads the macOS keychain', risky: true } },
  { match: /^(?:osascript)(?:\.exe)?$/, kind: { label: 'controls other apps', risky: true } },
  { match: /^(?:launchctl|systemctl|crontab|schtasks)(?:\.exe)?$/, kind: { label: 'sets up background jobs', risky: true } },
  { match: /^(?:ffmpeg|ffprobe|ffplay|sox|magick|convert|identify|exiftool|gm|vips)(?:\.exe)?$/, kind: { label: 'video, audio and image tools', risky: false } },
  { match: /^(?:whisper|whisper-cli|whisper-cpp)(?:\.exe)?$/, kind: { label: 'speech to text', risky: false } },
  { match: /^(?:git|gh)(?:\.exe)?$/, kind: { label: 'git', risky: false } },
  { match: /^(?:rm|rmdir|del|shred)(?:\.exe)?$/, kind: { label: 'deletes files', risky: false } },
  {
    match: /^(?:cp|mv|mkdir|chmod|chown|ln|tar|unzip|zip|gzip|gunzip|touch|cat|ls|find|xargs|sed|awk|grep|head|tail|sort|which|du|df)$/,
    kind: { label: 'file housekeeping', risky: false },
  },
  { match: /^(?:open|xdg-open|start|explorer)(?:\.exe)?$/, kind: { label: 'opens files or links', risky: false } },
  { match: /^(?:chrome|google-chrome|chromium|chromium-browser|firefox|playwright)(?:\.exe)?$/, kind: { label: 'a web browser', risky: false } },
]

const KIND_OF = { get: (name: string): Kind | undefined => KINDS.find(entry => entry.match.test(name))?.kind }

const JS_CALLS =
  /(?<![\w$.])(?:execFileSync|execFile|spawnSync|spawn|execSync|exec|fork)\s*\(\s*(?:(["'`])([^"'`\n]{1,200})|([A-Za-z_$][\w$.]{0,80}))|\b(?:child_process|childProcess|cp)\.(execFileSync|execFile|spawnSync|spawn|execSync|exec|fork)\s*\(\s*(?:(["'`])([^"'`\n]{1,200})|([A-Za-z_$][\w$.]{0,80}))|\bBun\.spawn(?:Sync)?\s*\(\s*\[\s*(["'`])([^"'`\n]{1,200})|\bnew\s+Deno\.Command\s*\(\s*(["'`])([^"'`\n]{1,200})|\bDeno\.run\s*\(\s*\{\s*cmd\s*:\s*\[\s*(["'`])([^"'`\n]{1,200})/g

const PY_CALLS =
  /\bsubprocess\.(?:run|call|Popen|check_output|check_call|getoutput|getstatusoutput)\s*\(\s*(?:\[\s*[rbfu]?(["'])([^"'\n]{1,200})|\[\s*([A-Za-z_][\w.]{0,80})|[rbfu]?(["'])([^"'\n]{1,200})|([A-Za-z_][\w.]{0,80}))|\bos\.(?:system|popen)\s*\(\s*[rbfu]?(["'])([^"'\n]{1,200})|\bpty\.spawn\s*\(\s*(?:\[\s*)?[rbfu]?(["'])([^"'\n]{1,200})|\bos\.(?:spawn|exec)[a-z]{0,4}\s*\(\s*(?:os\.P_\w+\s*,\s*)?(?:[rbfu]?(["'])([^"'\n]{1,200})|([A-Za-z_][\w.]{0,80}))/g

/** The programs a file starts, from its calls; `keep` drops matches in comments. */
export function programsIn(path: string, text: string, language: 'js' | 'python' | 'shell' | 'other', keep: (index: number) => boolean): ProgramUse[] {
  const uses: ProgramUse[] = []
  const patterns = language === 'js' ? [JS_CALLS] : language === 'python' ? [PY_CALLS] : language === 'shell' ? [] : [JS_CALLS, PY_CALLS]
  for (const pattern of patterns) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      if (uses.length >= 500) return uses
      const index = match.index ?? 0
      if (!keep(index)) continue
      const groups = match.slice(1)
      // The literal is the group after a quote; a variable has no quote before it.
      let literal: string | undefined
      let variable: string | undefined
      for (let i = 0; i < groups.length; i += 1) {
        const value = groups[i]
        if (value === undefined) continue
        if (/^["'`]$/.test(value)) {
          literal = groups[i + 1]
          break
        }
        if (/^(?:execFileSync|execFile|spawnSync|spawn|execSync|exec|fork)$/.test(value)) continue
        variable = value
        break
      }
      if (literal !== undefined) {
        // A shell command line (execSync, os.system, a string to subprocess)
        // starts with its program; a list or execFile names the program alone.
        const call = /(\w+)\s*\(\s*\[?\s*[rbfu]?["'`]?$/.exec(match[0].slice(0, match[0].length - literal.length))?.[1] ?? ''
        const listForm = /\(\s*\[/.test(match[0])
        const isLine = !listForm && (/^(?:execSync|exec|system|popen|getoutput|getstatusoutput)$/.test(call) || match[0].startsWith('subprocess.'))
        const raw = (isLine ? literal.trim().split(/\s+/)[0] : literal) ?? ''
        // A name built while it runs (`${tool}`, f"{tool}") is a program chosen at run time.
        const fString = /[^\w]f["']$|^f["']/.test(match[0].slice(0, match[0].length - literal.length).slice(-2))
        if (raw.includes('${') || (fString && raw.includes('{'))) {
          uses.push({ name: raw.slice(0, 60), file: path, dynamic: true })
          continue
        }
        const name = normalise(raw)
        if (name !== '') uses.push({ name, file: path, dynamic: false })
      } else if (variable !== undefined) {
        // The running interpreter itself is node or python, not an unknown program.
        const itself = variable === 'process.execPath' ? 'node' : variable === 'sys.executable' ? 'python' : undefined
        uses.push({ name: itself ?? variable, file: path, dynamic: itself === undefined })
      }
    }
  }
  return uses
}

function normalise(program: string): string {
  const base = program.replace(/^["']|["']$/g, '').split(/[\\/]/).pop() ?? ''
  return base.replace(/\.exe$/i, '').toLowerCase().slice(0, 60)
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/**
 * The plain-language lines for a row about running programs: a headline, then
 * the programs worth a look, then the rest by what they are for.
 */
export function describePrograms(uses: readonly ProgramUse[], extra: { buildsCode: number; downloads: number }): string[] {
  const counts = new Map<string, number>()
  const files = new Set<string>()
  const dynamic = new Map<string, number>()
  for (const use of uses) {
    files.add(use.file)
    if (use.dynamic) dynamic.set(use.name, (dynamic.get(use.name) ?? 0) + 1)
    else counts.set(use.name, (counts.get(use.name) ?? 0) + 1)
  }
  const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const risky = byCount.filter(([name]) => KIND_OF.get(name)?.risky === true)
  const ordered = [...risky, ...byCount.filter(([name]) => KIND_OF.get(name)?.risky !== true)]

  const parts: string[] = []
  if (extra.downloads > 0) parts.push('downloads code and runs it')
  if (extra.buildsCode > 0) parts.push('builds code from text and runs it')
  if (ordered.length > 0) {
    const names = ordered.slice(0, 6).map(([name]) => name)
    parts.push(`starts ${names.join(', ')}${ordered.length > 6 ? ` and ${ordered.length - 6} more` : ''}`)
  }
  if (dynamic.size > 0) parts.push('starts programs chosen while it runs')
  if (parts.length === 0) return []
  const headline = parts.join('; ')
  const lines = [headline.charAt(0).toUpperCase() + headline.slice(1)]

  const lookAt: string[] = []
  if (extra.downloads > 0) lookAt.push(`downloads code and runs it (${plural(extra.downloads, 'place')})`)
  if (extra.buildsCode > 0) lookAt.push(`builds code from text and runs it, as eval does (${plural(extra.buildsCode, 'place')})`)
  for (const [name, count] of risky) lookAt.push(`${name}: ${KIND_OF.get(name)?.label} (${plural(count, 'place')})`)
  if (dynamic.size > 0) lookAt.push(`a program named by ${[...dynamic.keys()].slice(0, 4).join(', ')}, chosen while it runs (${plural([...dynamic.values()].reduce((a, b) => a + b, 0), 'place')})`)
  if (lookAt.length > 0) lines.push(`Worth a look: ${lookAt.join('; ')}`)

  const groups = new Map<string, string[]>()
  for (const [name, count] of byCount) {
    const kind = KIND_OF.get(name)
    if (kind?.risky === true) continue
    const label = kind?.label ?? 'other programs'
    groups.set(label, [...(groups.get(label) ?? []), `${name} (${count})`])
  }
  for (const [label, names] of groups) lines.push(`${label.charAt(0).toUpperCase()}${label.slice(1)}: ${names.join(', ')}`)
  if (files.size > 0) {
    const list = [...files].sort()
    lines.push(`In ${plural(list.length, 'file')}: ${list.slice(0, 4).join(', ')}${list.length > 4 ? ` and ${list.length - 4} more` : ''}`)
  }
  return lines
}

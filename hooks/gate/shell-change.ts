// What a shell command Claude is about to run changes where Claude Code
// loads from: its writes (read by shell-writes.ts) found on disk, through the
// current folder, `~` and links, and the one that lands in such a place,
// turned into what the gate judges. Nothing here runs anything; it reads only
// to find where a path lands and what a copied file holds.

import type { Host } from '../scan/host'
import { parseRemote, type RemoteSpec } from '../scan/remote'
import { safeLine } from '../scan/safe-text'
import { expandHome } from './resolve'
import { lastPart, readShellWrites, type Named, type ShellWrite, type Unseen } from './shell-writes'
import { landsAt, normalizePath, writePlace } from './writes'

export type ShellChange =
  | { kind: 'pass' }
  /** A change the guard cannot check: held as Could not verify. `claim` is the place it would change, when known. */
  | { kind: 'unreadable'; label: string; reason: string; claim?: string }
  /** Text that lands in one file, judged as Claude's Write of it would be. `copied` when it comes from another file, so it is shown even with no red flags. */
  | { kind: 'write'; label: string; input: { tool: 'Write'; file_path: string; content: string }; copied: boolean; claim: string; configDir?: string }
  /** A folder copied in as a skill, or into one: scanned where it is now. */
  | { kind: 'folder'; label: string; path: string; claim: string }
  /** A repository cloned in: scanned at the commit it would clone. */
  | { kind: 'clone'; label: string; spec: RemoteSpec; claim: string }
  /**
   * Ordinary work on a skill or command the guard cannot read before it runs
   * (`sed -i`, a script): it goes on with a note, since the skill gate checks
   * the skill or command before Claude Code next uses it.
   */
  | { kind: 'note'; label: string; note: string; claim?: string }

const PASS: ShellChange = { kind: 'pass' }

type Place = ReturnType<typeof writePlace>

/** A skill or a command, which the skill gate checks before Claude Code uses it. */
function checkedAtUse(place: Place): place is Extract<Place, { kind: 'skill' | 'command' }> {
  return place?.kind === 'skill' || place?.kind === 'command'
}

function noted(label: string, what: string, claim?: string): ShellChange {
  return { kind: 'note', label, note: `AI Install Guard: writing ${label}; the guard checks ${what} before Claude Code next uses it`, ...(claim === undefined ? {} : { claim }) }
}

/** What the note calls the skill or command a change is to. */
function noun(place: Place): string {
  return place?.kind === 'skill' ? 'the skill' : 'the command'
}

/** A note for changes, named by path, to skill and command files only. */
function noteFiles(files: readonly string[]): ShellChange {
  const [one] = files
  if (files.length === 1 && one !== undefined) return noted(`a change to ${safeLine(one)}`, noun(writePlace(one)))
  return noted(`changes to ${files.length} skill and command files`, 'each one')
}

/** A path to a file in a `.claude` folder's skills or commands. */
const SKILL_FILE = /[^\s"'`;|&<>()$=]*\.claude[\\/](?:skills|commands)[\\/][^\s"'`;|&<>()$]+/gi

/**
 * The skill or command files text names, when those are all it names of the
 * places Claude Code loads from; undefined when it names any other, or one
 * through `..`.
 */
function onlySkillFiles(text: string): string[] | undefined {
  const files: string[] = []
  const rest = text.replace(SKILL_FILE, path => {
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path)) return path
    files.push(path)
    return ' '
  })
  return files.length > 0 && !NAMES_CLAUDE.test(rest) ? files : undefined
}

/**
 * Whether text names a place Claude Code loads from: a `.claude` folder, an
 * MCP or user configuration, an organization's settings, or the variable
 * that moves Claude's folder. `.claude-plugin` and `.claudeignore` are not.
 */
export const NAMES_CLAUDE = /(?:^|[\s"'=:/\\~$({])\.claude(?![\w.-])|\.mcp\.json|\.claude\.json|managed-settings\.json|CLAUDE_CONFIG_DIR/i

/** The most of a file the guard reads to know what a copy or an append makes, as it reads a configuration. */
const MAX_TEXT_BYTES = 16 * 1024 * 1024

/** One write found to land where Claude Code loads from. */
type Found = { write: ShellWrite; path: string; landed: string; place: Place; covers: boolean; source?: string | string[] }

/**
 * What `command` changes where Claude Code loads from, run in `cwd` (the
 * session's current folder, when known). A command that changes nothing
 * there passes; one that changes one thing is turned into what the gate
 * judges; changes to skills and commands alone that the guard cannot read
 * go on with a note; anything else there is held as one the guard cannot read.
 */
export async function readShellChange(host: Host, command: string, cwd: string | undefined, claudeFolder: () => Promise<string | undefined> = async () => undefined): Promise<ShellChange> {
  const read = readShellWrites(command, cwd)
  // A part only known as it runs counts when it names Claude's own folder; when all it
  // names there is skill and command files already there, it edits them: ordinary work.
  let hidden: Unseen | undefined
  let skills: { part: Unseen; files: string[] } | undefined
  const weigh = (text: string, part: Unseen): void => {
    if (!NAMES_CLAUDE.test(text)) return
    const files = onlySkillFiles(text)
    if (files === undefined) hidden ??= part
    else skills ??= { part, files }
  }
  for (const part of read.unseen) weigh(part.text ?? command, part)

  let home: string | undefined | null = null
  const homeFolder = async (): Promise<string | undefined> => {
    if (home === null) home = await expandHome(host, '~').catch(() => undefined)
    return home
  }
  const absolute = async (named: Named): Promise<string | undefined> => {
    const path = named.path.replace(/\\/g, '/')
    if (path === '~' || path.startsWith('~/')) {
      const found = await homeFolder()
      return found === undefined ? undefined : `${found}${path.slice(1)}`
    }
    // Another user's home (`~root`) is not looked up: where it is stays unknown.
    if (path.startsWith('~')) return undefined
    if (/^(?:\/|[A-Za-z]:\/)/.test(path)) return path
    if (named.cwd === undefined) return undefined
    const base = await absolute({ path: named.cwd, cwd: undefined })
    return base === undefined ? undefined : `${base.replace(/\/+$/, '')}/${path}`
  }
  /** Each file's full path, when every one is there now as a plain file: what an edit changes, rather than something brought in. */
  const there = async (files: readonly string[]): Promise<string[] | undefined> => {
    const paths: string[] = []
    for (const file of files) {
      const path = await absolute({ path: file, cwd })
      const stat = path === undefined ? undefined : await host.stat(path).catch(() => undefined)
      if (path === undefined || stat?.kind !== 'file' || stat.isLink === true) return undefined
      paths.push(path)
    }
    return paths
  }
  const settle = async (): Promise<void> => {
    if (skills === undefined) return
    const paths = await there(skills.files)
    if (paths !== undefined) skills.files = paths
    else {
      hidden ??= skills.part
      skills = undefined
    }
  }

  if (read.writes.length === 0) {
    await settle()
    return hidden !== undefined ? unseen(hidden) : skills !== undefined ? noteFiles(skills.files) : PASS
  }
  // Only a command that writes looks up where CLAUDE_CONFIG_DIR keeps Claude's folder.
  const configDir = await claudeFolder()

  const found: Found[] = []
  const unreadable: { label: string; reason: string; place: Place; covers: boolean; edit: boolean }[] = []
  for (const write of read.writes) {
    const to = await absolute(write.to)
    if (to === undefined) {
      // Relative to a folder only known as it runs: a place only when its own words name one.
      const place = writePlace(write.to.path, configDir)
      const covers = coversPlace(write.to.path, configDir)
      const edit = write.kind === 'unknown' && write.edit === true
      if (place !== undefined || covers) unreadable.push({ label: `a change to ${safeLine(write.to.path)}`, reason: 'it writes to a path relative to a folder only known as it runs', place, covers, edit })
      else weigh(command, { reason: 'it writes to a path relative to a folder only known as it runs' })
      continue
    }
    for (const { path, source } of await landings(host, write, to, absolute)) {
      const landed = normalizePath(await landsAt(host, path))
      const place = writePlace(landed, configDir) ?? writePlace(normalizePath(path), configDir)
      // Anything unpacked or checked out below a folder that holds the home folder can reach ~/.claude.
      const holder = write.kind === 'unknown' && write.deep === true ? await homeFolder() : undefined
      const covers = coversPlace(landed, configDir) || coversPlace(normalizePath(path), configDir) || (holder !== undefined && (holder === landed || holder.startsWith(`${landed.replace(/\/+$/, '')}/`)))
      // Taking a file away adds nothing, except a settings file's rules.
      if (write.kind === 'remove' ? place?.kind !== 'settings' : place === undefined && !covers) continue
      found.push({ write, path, landed, place, covers, ...(source === undefined ? {} : { source }) })
    }
  }
  await settle()
  if (hidden !== undefined) return unseen(hidden)
  const total = found.length + unreadable.length
  if (total === 0) return skills !== undefined ? noteFiles(skills.files) : PASS
  const edits = (item: (typeof unreadable)[number]): boolean => item.edit && checkedAtUse(item.place) && !item.covers
  if (total > 1 || skills !== undefined) {
    // Edits to several skills and commands already there go on, each checked before it is used;
    // a new one among them is judged in a command of its own.
    const judged = await Promise.all(found.map(async one => ({ one, change: await judgeable(host, one, configDir) })))
    let atUse = unreadable.every(edits)
    for (const { one, change } of judged) atUse &&= change.kind === 'note' || (change.kind === 'write' && checkedAtUse(one.place) && !one.covers && (await there([one.path])) !== undefined)
    if (atUse) return noted('changes to skills and commands', 'each one')
    if (skills !== undefined) return unseen(skills.part)
    const places = [...found.map(item => item.landed), ...unreadable.map(item => item.label.replace(/^a change to /, ''))].slice(0, 3).map(item => safeLine(item))
    return { kind: 'unreadable', label: `${total} changes by one command`, reason: `it makes more than one change where Claude Code loads from (${places.join(', ')}${total > 3 ? ', …' : ''}); make each change in a command of its own, or write each file with Write` }
  }
  const [failed] = unreadable
  if (failed !== undefined) return edits(failed) ? noted(failed.label, noun(failed.place)) : { kind: 'unreadable', label: failed.label, reason: failed.reason }
  return judgeable(host, found[0] as Found, configDir)
}

/**
 * Where a write lands: one path, or for a copy into a folder, one per
 * source, each named as the source is. `source` is the absolute path of
 * what is copied there, or of each file joined into it; unset when one is
 * relative to a folder only known as it runs.
 */
async function landings(host: Host, write: ShellWrite, to: string, absolute: (named: Named) => Promise<string | undefined>): Promise<{ path: string; source?: string | string[] }[]> {
  if (write.kind !== 'copy') return [{ path: to }]
  const sources = await Promise.all(write.from.map(absolute))
  if (write.join === true) return [{ path: to, ...(sources.every(item => item !== undefined) ? { source: sources as string[] } : {}) }]
  const folder = write.into ?? (await host.stat(to).catch(() => undefined))?.kind === 'dir'
  if (!folder || write.contents === true) return [{ path: to, ...(sources[0] === undefined ? {} : { source: sources[0] }) }]
  return write.from.map((from, at) => ({ path: `${to.replace(/\/+$/, '')}/${lastPart(from.path)}`, ...(sources[at] === undefined ? {} : { source: sources[at] }) }))
}

/**
 * A path that is Claude's own folder (~/.claude, a project's .claude, or the
 * one CLAUDE_CONFIG_DIR names), or one of the folders it loads skills,
 * commands, agents, output styles or plugins from, as a whole.
 */
export function coversPlace(path: string, configDir?: string): boolean {
  const lower = path.toLowerCase().replace(/\/+$/, '')
  const areas = '(?:\\/(?:skills|commands|agents|output-styles|plugins))?$'
  if (new RegExp(`(?:^|\\/)\\.claude${areas}`).test(lower)) return true
  if (configDir === undefined) return false
  const dir = normalizePath(configDir).toLowerCase().replace(/\/+$/, '')
  return lower === dir || (lower.startsWith(`${dir}/`) && new RegExp(`^${areas}`).test(lower.slice(dir.length)))
}

/** The one change found, as the gate judges it. */
async function judgeable(host: Host, one: Found, configDir: string | undefined): Promise<ShellChange> {
  const { write, place } = one
  const shown = safeLine(one.landed)
  const label = `a change to ${shown}`
  // A skill is claimed as its folder, so a change to it here waits for one to it by Write.
  const folder = place?.kind === 'skill' ? place.folder : undefined
  const claim = (folder === undefined ? one.landed : normalizePath(await landsAt(host, folder))).toLowerCase()
  const held = (reason: string): ShellChange => ({ kind: 'unreadable', label, reason, claim })
  // A skill or command is checked before it is used, so an edit to it already there goes on;
  // anything brought in that the guard cannot read is still held.
  const atUse = !one.covers && checkedAtUse(place)
  const edited = (reason: string): ShellChange => (atUse ? noted(label, noun(place), claim) : held(reason))
  if (one.covers) {
    const what = write.kind === 'unknown' ? `${write.what} would land in` : 'it writes over'
    return held(`${what} ${shown} as a whole, where Claude Code keeps what it loads, so the guard cannot tell what it adds; change one skill, command or file at a time`)
  }
  if (place?.kind === 'plugins') return held('it changes the files of a plugin Claude Code installed, outside any install, so what runs would no longer be what was approved')
  // Text copied into a skill or command is judged as a Write of it; copied anywhere else, it is always shown.
  const write1 = (content: string, copied: boolean): ShellChange => ({ kind: 'write', label, input: { tool: 'Write', file_path: one.path, content }, copied: copied && !atUse, claim, ...(configDir === undefined ? {} : { configDir }) })
  switch (write.kind) {
    case 'content': {
      if (!write.append) return write1(write.content, false)
      const current = await readText(host, one.path)
      return 'text' in current ? write1(`${current.text ?? ''}${write.content}`, false) : edited(current.reason)
    }
    // A settings file taken away is one with no rules in it.
    case 'remove':
      return write1('{}', false)
    case 'unknown': {
      const reason = `${write.what} would land there, and what it is is only known as it runs; write the file's text with Write, or copy a file that is already there`
      return write.edit === true ? edited(reason) : held(reason)
    }
    case 'clone': {
      if (write.submodules) return held("it also clones the repository's submodules, which the guard does not read; clone without --recurse-submodules")
      try {
        const spec = parseRemote(write.url, write.ref === undefined ? {} : { ref: write.ref })
        return { kind: 'clone', label: `the repository ${safeLine(write.url)}`, spec, claim }
      } catch {
        return held(`it clones ${safeLine(write.url)}, and the guard reads a repository only from an https:// address or as owner/repo on GitHub`)
      }
    }
    case 'copy': {
      if (write.link === true) {
        const target = safeLine(write.from[0]?.path ?? 'another path')
        return held(`it makes a link to ${target} there, so Claude Code would load whatever ${target} holds, now and after any later change, which no scan can pin; copy the files instead`)
      }
      if (one.source === undefined) return held('it copies from a path relative to a folder only known as it runs')
      if (Array.isArray(one.source)) {
        let text = ''
        for (const path of one.source) {
          const part = await readText(host, path, true)
          if (!('text' in part)) return held(part.reason)
          text += part.text ?? ''
        }
        return write1(text, true)
      }
      const source = safeLine(one.source)
      const stat = await host.stat(one.source).catch(() => undefined)
      const kind = stat?.kind
      // A link copied as a link loads whatever it points to, now and later; copied as a file, it is still not the file the guard would read.
      if (stat?.isLink === true) return held(`it copies ${source}, which is a link, so what lands is whatever it points to, now and after any later change, which no scan can pin; copy the file it points to instead`)
      if (kind === undefined) return held(`it copies ${source}, which is not there yet: what a command makes before it copies cannot be checked before it runs; make it first, then copy it in a command of its own`)
      if (kind === 'dir') {
        if (place?.kind !== 'skill' && place?.kind !== 'command' && place?.kind !== 'agent' && place?.kind !== 'output style') return held(`it copies the folder ${source} over a configuration file`)
        const label = place.kind !== 'skill' ? `${source}, copied into ${shown}` : place.folder === undefined ? `the skill ${safeLine(place.name)}, copied from ${source}` : `${source}, copied into the skill ${safeLine(place.name)}`
        return { kind: 'folder', label, path: normalizePath(await landsAt(host, one.source)), claim }
      }
      const text = await readText(host, one.source, true)
      return 'text' in text ? write1(text.text ?? '', true) : held(text.reason)
    }
  }
}

/**
 * A file's text as it is now: undefined when it is not there, unless
 * `needed` (a file being copied must be). Too large, binary or unreadable,
 * it is a reason instead.
 */
async function readText(host: Host, path: string, needed = false): Promise<{ text: string | undefined } | { reason: string }> {
  const stat = await host.stat(path).catch(() => undefined)
  if (stat === undefined) return needed ? { reason: `it copies ${safeLine(path)}, which is not there yet: make it first, then copy it in a command of its own` } : { text: undefined }
  if (stat.size > MAX_TEXT_BYTES) return { reason: `${safeLine(lastPart(path))} is ${stat.size} bytes, more than the guard reads` }
  try {
    const bytes = await host.readBytes(path)
    if (bytes.includes(0)) return { reason: `${safeLine(lastPart(path))} is a binary file, which the guard does not read as text` }
    return { text: new TextDecoder().decode(bytes) }
  } catch {
    return { reason: `the guard could not read ${safeLine(path)}` }
  }
}

/** A command with a part only known as it runs, where it names Claude's own folder. */
function unseen(part: Unseen): ShellChange {
  return {
    kind: 'unreadable',
    label: 'a shell command that names Claude Code\'s own folder',
    reason: `${part.reason}, and the command names a place Claude Code loads from, so the guard cannot tell what it adds there; to read a file, use the Read tool; to write one, use Write`,
  }
}

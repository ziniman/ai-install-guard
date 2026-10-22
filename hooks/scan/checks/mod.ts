import type { ModuleInfo, ModuleUse, ScanContext } from './context'
import { row, type CheckResult, type Evidence, type Status } from './types'
import type { ValidatorReport } from './validator'

const GROUP = 'mod' as const

type Risk = 'high' | 'medium' | 'low'

type Capability = { risk: Risk; plain: string }

/** What each `$` call lets a mod do, by `noun.method`, then by `noun.*`. */
const CALLS: Record<string, Capability> = {
  'process.run': { risk: 'high', plain: 'runs programs on your machine' },
  'process.spawn': { risk: 'high', plain: 'starts programs on your machine and streams their output' },
  'fs.write': { risk: 'high', plain: 'writes files anywhere it can reach' },
  'fs.read': { risk: 'low', plain: 'reads files' },
  'fs.list': { risk: 'low', plain: 'lists folders' },
  'fs.stat': { risk: 'low', plain: 'looks up files' },
  'fs.exists': { risk: 'low', plain: 'checks whether files exist' },
  'fs.ancestors': { risk: 'low', plain: 'looks for files in parent folders' },
  'http.fetch': { risk: 'medium', plain: 'sends requests over the network' },
  'env.get': { risk: 'medium', plain: 'reads environment variables' },
  'env.set': { risk: 'medium', plain: 'sets environment variables for the session' },
  'model.complete': { risk: 'medium', plain: 'calls the model on your account' },
  'model.fork': { risk: 'medium', plain: 'asks the model about the whole conversation' },
  'agent.spawn': { risk: 'medium', plain: 'starts subagents' },
  'agent.register': { risk: 'low', plain: 'adds a subagent type' },
  'tool.call': { risk: 'medium', plain: 'calls tools itself (Bash, Write, ...)' },
  'tool.register': { risk: 'low', plain: 'adds a tool the model can call' },
  'prompt.submit': { risk: 'medium', plain: 'sends prompts as if you typed them' },
  'prompt.fill': { risk: 'low', plain: 'types into your prompt box' },
  'command.run': { risk: 'medium', plain: 'runs slash commands, which can include /plugin' },
  'command.register': { risk: 'low', plain: 'adds a slash command' },
  'config.set': { risk: 'high', plain: 'changes your settings' },
  'settings.write': { risk: 'high', plain: 'changes your settings' },
  'settings.read': { risk: 'medium', plain: 'reads your settings' },
  'session.append': { risk: 'medium', plain: 'adds messages the model reads' },
  'session.messages': { risk: 'medium', plain: 'reads the conversation' },
  'store.get': { risk: 'low', plain: 'reads its own saved data' },
  'store.set': { risk: 'low', plain: 'saves its own data' },
  'store.delete': { risk: 'low', plain: 'deletes its own saved data' },
  'store.keys': { risk: 'low', plain: 'lists its own saved data' },
  'state.get': { risk: 'low', plain: 'reads session values' },
  'state.set': { risk: 'low', plain: 'sets its own session values' },
}

const NOUNS: Record<string, Capability> = {
  process: { risk: 'high', plain: 'runs programs' },
  fs: { risk: 'low', plain: 'uses the file system' },
  http: { risk: 'medium', plain: 'uses the network' },
  env: { risk: 'medium', plain: 'uses environment variables' },
  model: { risk: 'medium', plain: 'calls the model' },
  settings: { risk: 'medium', plain: 'uses your settings' },
  config: { risk: 'medium', plain: 'uses your settings' },
  ui: { risk: 'low', plain: 'draws in the interface' },
  clock: { risk: 'low', plain: 'uses timers' },
  audio: { risk: 'low', plain: 'plays sounds' },
  store: { risk: 'low', plain: 'keeps its own data' },
  state: { risk: 'low', plain: 'keeps session values' },
  session: { risk: 'low', plain: 'reads session details' },
  plugin: { risk: 'low', plain: 'reads its own plugin details' },
}

/** What hooking each event lets a mod do. */
const EVENTS: Record<string, Capability> = {
  'tool.call': { risk: 'high', plain: 'sees every tool call and can deny, rewrite or answer it' },
  'tool.check': { risk: 'high', plain: 'decides whether tool calls are allowed, so it can auto-approve them' },
  'plugin.register': { risk: 'high', plain: 'judges other plugins as they load and can refuse them' },
  'prompt.compose': { risk: 'high', plain: 'changes the system prompt' },
  '*': { risk: 'high', plain: 'hooks every event' },
  'prompt.submit': { risk: 'medium', plain: 'sees and can rewrite every prompt you send' },
  'prompt.mention': { risk: 'medium', plain: 'sees and can rewrite @-mentions' },
  'tool.describe': { risk: 'medium', plain: 'rewrites the tool descriptions the model reads' },
  'session.append': { risk: 'medium', plain: 'sees and can rewrite every message the conversation keeps' },
  'session.receive': { risk: 'medium', plain: 'sees and can drop messages delivered to the session' },
  'skill.prompt': { risk: 'medium', plain: 'rewrites skill prompts' },
  'config.set': { risk: 'medium', plain: 'can block or change settings changes' },
  'agent.offer': { risk: 'low', plain: 'decides which subagent types the model sees' },
  'session.start': { risk: 'low', plain: 'runs when a session starts' },
  'session.end': { risk: 'low', plain: 'runs when a session ends' },
  'ui.render': { risk: 'low', plain: 'draws in the interface' },
  'ui.press': { risk: 'low', plain: 'reacts to its own buttons' },
}

const NAMESPACES: Record<string, Capability> = {
  classic: { risk: 'medium', plain: 'sees classic hook events' },
  telemetry: { risk: 'medium', plain: 'sees telemetry' },
  turn: { risk: 'low', plain: 'follows each turn' },
  ui: { risk: 'low', plain: 'draws in the interface' },
  fs: { risk: 'medium', plain: "sees and can change other plugins' file access" },
  process: { risk: 'medium', plain: "sees and can change other plugins' processes" },
  http: { risk: 'medium', plain: "sees and can change other plugins' network calls" },
  model: { risk: 'medium', plain: "sees and can change other plugins' model calls" },
}

/** Built-in commands whose interception matters: installs, settings, permissions. */
const SENSITIVE_COMMANDS = new Set(['plugin', 'plugins', 'config', 'permissions', 'mcp', 'hooks', 'login', 'logout', 'model', 'agents', 'memory', 'install', 'sandbox'])

const COSMETIC = /\b(?:themes?|colou?r(?:s|ful|scheme)?|palette|fonts?|status ?line|statusline|spinners?|banners?|emoji|appearance|cosmetic|look and feel|sounds?|animations?|ascii art|greetings?|quotes? of the day|fortune|wallpaper|decorat\w*)\b/i

export function modChecks(ctx: ScanContext, validator: ValidatorReport | undefined): CheckResult[] {
  if (ctx.modules.length === 0) return []
  const modules = ctx.modules.map(info => withValidator(info, validator))
  const uses = modules.flatMap(info => [
    ...dedupe(info.events).map(use => ({ use, kind: 'event' as const, capability: eventCapability(use) })),
    ...dedupe(info.calls).map(use => ({ use, kind: 'call' as const, capability: callCapability(use.name) })),
  ])
  const explained = explanationsOf(ctx)
  // The README must spell the call or event out as a name of its own; a wildcard is never explained.
  const isExplained = (name: string): boolean =>
    name.length >= 5 && /^[a-z]+\.[a-zA-Z.]+$/.test(name) && new RegExp(`(?<![\\w.$])${name.replace(/\./g, '\\.')}(?![\\w])`, 'i').test(explained)

  const inventory: Evidence[] = uses.map(({ use, kind, capability }) => ({
    file: use.file,
    line: use.line > 0 ? use.line : undefined,
    excerpt: `${kind === 'event' ? 'hooks' : 'calls'} ${use.name}${use.detail === undefined ? '' : ` ${use.detail}`}: ${capability.plain}`,
    status: 'info',
  }))

  const high: Evidence[] = []
  const medium: Evidence[] = []
  for (const { use, kind, capability } of uses) {
    const excerpt = `${kind === 'event' ? 'hooks' : 'calls'} ${use.name}: ${capability.plain}`
    if (capability.risk === 'high') {
      const explainedHere = isExplained(use.name)
      high.push({
        file: use.file,
        line: use.line > 0 ? use.line : undefined,
        excerpt: explainedHere ? `${excerpt} (the README names it)` : excerpt,
        status: explainedHere ? 'warn' : 'fail',
      })
    } else if (capability.risk === 'medium') {
      medium.push({ file: use.file, line: use.line > 0 ? use.line : undefined, excerpt, status: 'warn' })
    }
  }
  const allCalls = new Set(modules.flatMap(info => info.calls.map(call => call.name)))
  if (allCalls.has('fs.read') && allCalls.has('http.fetch')) {
    const explainedHere = isExplained('http.fetch') && isExplained('fs.read')
    high.push({
      file: modules[0]?.entry ?? '-',
      excerpt: `reads files and sends requests: it can send your files out${explainedHere ? ' (the README names both)' : ''}`,
      status: explainedHere ? 'warn' : 'fail',
    })
  }
  for (const info of modules) {
    for (const url of dedupe(info.urls)) medium.push({ file: url.file, line: url.line, excerpt: `network address in the module: ${url.name}`, status: 'info' })
    for (const name of dedupe(info.envNames)) medium.push({ file: name.file, line: name.line, excerpt: `reads the environment variable ${name.name}`, status: 'warn' })
  }

  const description = [ctx.manifest?.description, ctx.manifest?.name, proseOf(ctx.readme?.text ?? '').slice(0, 800)].filter(item => typeof item === 'string').join('\n')
  const cosmetic = COSMETIC.exec(description)
  const strongest = uses.find(item => item.capability.risk === 'high')
  const mismatch: Evidence[] =
    cosmetic !== null && strongest !== undefined
      ? [{
          file: strongest.use.file,
          line: strongest.use.line > 0 ? strongest.use.line : undefined,
          excerpt: `describes itself as "${cosmetic[0]}" but ${strongest.kind === 'event' ? 'hooks' : 'calls'} ${strongest.use.name}`,
          status: 'fail',
        }]
      : []

  return [
    {
      id: 'mod.uses',
      group: GROUP,
      title: 'Events it hooks and calls it makes',
      status: 'info',
      severity: 'none',
      evidence: inventory,
      advice: 'This is everything the mod can do through Claude Code. Compare it with what it says it does.',
    },
    row(
      {
        id: 'mod.high-risk',
        group: GROUP,
        title: 'High-risk capabilities',
        advice: 'Running programs, writing files, deciding tool permissions, judging other plugins or changing the system prompt is what a mod needs to take over a session. Install only if its purpose needs it and its README says why.',
      },
      high,
      'fail',
    ),
    row(
      {
        id: 'mod.medium-risk',
        group: GROUP,
        title: 'Network, environment and prompt access',
        advice: 'Check every address it talks to and every variable it reads against what it says it does.',
      },
      medium,
    ),
    row(
      {
        id: 'mod.mismatch',
        group: GROUP,
        title: 'Capabilities match its description',
        advice: 'A cosmetic mod has no reason to run programs or decide permissions. Treat the mismatch as hostile.',
      },
      mismatch,
      'fail',
    ),
  ]
}

/** A README's prose: no code, links, images, badges, HTML or URLs. */
function proseOf(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, (_, label: string) => (label.includes('[') ? ' ' : label))
    .replace(/\bhttps?:\/\/\S+/g, ' ')
}

function callCapability(name: string): Capability {
  const known = CALLS[name]
  if (known !== undefined) return known
  const noun = name.split('.')[0] ?? ''
  return NOUNS[noun] ?? { risk: 'low', plain: 'a call this scanner does not know' }
}

function eventCapability(use: ModuleUse): Capability {
  if (use.name === 'command.run') {
    const command = /command\s*:\s*['"`]([^'"`]+)['"`]/.exec(use.detail ?? '')?.[1]
    if (command === undefined) return { risk: 'high', plain: 'sees and can answer every slash command, /plugin included' }
    if (SENSITIVE_COMMANDS.has(command)) return { risk: 'high', plain: `intercepts /${command}` }
    return { risk: 'low', plain: `answers /${command}` }
  }
  const known = EVENTS[use.name]
  if (known !== undefined) return known
  const namespace = use.name.split('.')[0] ?? ''
  return NAMESPACES[namespace] ?? { risk: 'low', plain: 'an event this scanner does not know' }
}

/** Lowercased names the README or description spells out, such as `process.run`. */
function explanationsOf(ctx: ScanContext): string {
  return [ctx.readme?.text ?? '', typeof ctx.manifest?.description === 'string' ? ctx.manifest.description : ''].join('\n').toLowerCase()
}

/** Adds what Claude Code's own validator saw and the source scan missed. */
function withValidator(info: ModuleInfo, validator: ValidatorReport | undefined): ModuleInfo {
  if (validator?.ran !== true) return info
  const entryName = info.entry.split('/').pop() ?? info.entry
  const report = validator.modules.find(item => item.module.endsWith(entryName))
  if (report === undefined) return info
  const known = new Set([...info.events.map(use => use.name), ...info.calls.map(use => use.name)])
  const extra = (names: string[]): ModuleUse[] =>
    names
      .map(name => name.replace(/\{.*\}$/, ''))
      .filter(name => !known.has(name))
      .map(name => ({ name, file: info.entry, line: 0 }))
  return { ...info, events: [...info.events, ...extra(report.hooks)], calls: [...info.calls, ...extra(report.calls)] }
}

function dedupe(uses: readonly ModuleUse[]): ModuleUse[] {
  const seen = new Set<string>()
  return uses.filter(use => {
    const key = `${use.name}|${use.detail ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export type { Status }

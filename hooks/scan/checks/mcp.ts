import type { McpServer, ScanContext } from './context'
import { COLLECTION_HOST, CREDENTIAL_PATH, DOWNLOAD_AND_RUN, NETWORK_COMMAND, SECRET_ENV, UNPINNED_RUNNER } from './patterns'
import { capEvidence, row, type CheckResult, type Evidence, type Status } from './types'

const GROUP = 'mcp' as const

/** Words in a variable's name that say nothing about whose credential it is. */
const GENERIC_WORDS = new Set(['api', 'key', 'keys', 'token', 'tokens', 'auth', 'oauth', 'secret', 'access', 'session', 'client', 'bot', 'app', 'personal', 'private', 'password', 'credentials', 'application', 'hub', 'code'])

/** Short or product names in a variable, and the service they belong to. */
const SERVICE_WORDS: Record<string, string> = { gh: 'github', hf: 'huggingface', hugging: 'huggingface', face: 'huggingface', claude: 'anthropic', node: 'npm' }

/** The domains each service's keys belong on. A host must be one of them or below one. */
const SERVICE_DOMAINS: Record<string, readonly string[]> = {
  github: ['github.com', 'githubcopilot.com', 'githubusercontent.com', 'ghe.com'],
  gitlab: ['gitlab.com'],
  anthropic: ['anthropic.com', 'claude.ai', 'claude.com'],
  openai: ['openai.com'],
  aws: ['amazonaws.com', 'aws.amazon.com', 'aws.dev'],
  google: ['googleapis.com', 'google.com'],
  azure: ['azure.com', 'microsoft.com', 'windows.net', 'azure.net'],
  slack: ['slack.com'],
  stripe: ['stripe.com'],
  huggingface: ['huggingface.co'],
  npm: ['npmjs.org', 'npmjs.com'],
}

/** A `${NAME}` or `$NAME` reference to an environment variable. */
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]{0,100})(?::-[^}]{0,200})?\}|\$([A-Za-z_][A-Za-z0-9_]{0,100})/g

/** An address anywhere in a command line, a shell script's included. */
const ADDRESS = /\b(?:https?|wss?):\/\/[^\s'"`<>)]{1,500}/gi

/** Container options that take the next argument as their value. */
const VALUE_FLAGS = new Set([
  '-a', '--attach', '-e', '--env', '--env-file', '-v', '--volume', '--mount', '-l', '--label', '--label-file', '--name', '-p', '--publish', '--network', '--net',
  '-w', '--workdir', '--entrypoint', '-u', '--user', '--platform', '--pull', '-h', '--hostname', '--cpus', '-m', '--memory', '--add-host', '--device', '--cap-add',
  '--cap-drop', '--restart', '--log-driver', '--log-opt', '--security-opt', '--tmpfs', '--ulimit', '--gpus', '--shm-size', '--runtime', '--ipc', '--pid', '--uts',
  '--userns', '--cgroupns', '--dns', '--expose', '--group-add', '--cidfile', '--stop-signal', '--stop-timeout', '--health-cmd', '--memory-swap', '--cpuset-cpus',
])

/** Group 5: what each MCP server runs or talks to, and what it is handed. */
export function mcpChecks(ctx: ScanContext): CheckResult[] {
  if (ctx.mcpServers.length === 0) return []
  return [inventoryCheck(ctx.mcpServers), launchCheck(ctx.mcpServers), remoteCheck(ctx.mcpServers), credentialsCheck(ctx.mcpServers)]
}

function place(server: McpServer, excerpt: string, status: Status): Evidence {
  return { file: server.file, line: server.line, excerpt: `${server.name}: ${excerpt}`, status }
}

function commandLine(server: McpServer): string {
  return [server.command ?? '', ...server.args].join(' ').trim()
}

/**
 * Every remote address a server talks to or is given: its own URL, and any
 * address in its arguments (inside a shell script too), environment and
 * headers. Local ones are left out. All are judged; the rows cap what they list.
 */
function remoteUrls(server: McpServer): { url: URL; given: boolean }[] {
  const found: { url: URL; given: boolean }[] = []
  const texts = [
    ...(server.url === undefined ? [] : [{ text: server.url, given: false }]),
    ...[...server.args, ...Object.values(server.env), ...Object.values(server.headers)].map(text => ({ text, given: true })),
  ]
  for (const { text, given } of texts) {
    for (const match of text.matchAll(ADDRESS)) {
      // Bounded work for a config written to exhaust it.
      if (found.length >= 500) return found
      try {
        const url = new URL(match[0])
        if (!isLocal(url.hostname)) found.push({ url, given })
      } catch {
        continue
      }
    }
  }
  return found
}

function isLocal(host: string): boolean {
  return /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i.test(host)
}

function inventoryCheck(servers: readonly McpServer[]): CheckResult {
  const evidence = servers.map(server => {
    const what = server.url !== undefined ? `${server.type ?? 'http'} server at ${server.url}` : `runs ${commandLine(server) || '(no command)'}`
    const env = Object.keys(server.env)
    return place(server, `${what}${env.length > 0 ? `; environment: ${env.slice(0, 10).join(', ')}` : ''}`, 'info')
  })
  return row(
    {
      id: 'mcp.servers',
      group: GROUP,
      title: 'MCP servers it adds',
      advice: 'Each MCP server runs as a program on your machine or talks to a server elsewhere, and Claude can call every tool it offers.',
      access: serverAccess(servers),
    },
    capEvidence(evidence, 30, 'info'),
    'info',
  )
}

function launchCheck(servers: readonly McpServer[]): CheckResult {
  const evidence: Evidence[] = []
  for (const server of servers) {
    if (server.command === undefined) continue
    const line = commandLine(server)
    const program = baseName(server.command)
    if (DOWNLOAD_AND_RUN.test(line)) {
      evidence.push(place(server, `downloads code and runs it: ${line}`, 'fail'))
      continue
    }
    if (UNPINNED_RUNNER.test(line)) {
      evidence.push(place(server, `fetches a package that is not pinned to an exact version each time it starts: ${line}`, 'warn'))
    } else if (/^(?:npx|bunx|pnpx|uvx|pipx|npm|pnpm|yarn|bun|deno)$/.test(program)) {
      evidence.push(place(server, `fetches or runs a package when it starts; the package is not part of this scan: ${line}`, 'info'))
    }
    if (runsInlineScript(program, server.args)) evidence.push(place(server, `runs an inline shell script: ${line}`, 'warn'))
    if (/^(?:docker|podman|nerdctl)$/.test(program) && server.args.includes('run')) {
      const image = containerImage(server.args)
      if (image === undefined) evidence.push(place(server, `runs a container whose image could not be told apart: ${line}`, 'warn'))
      // An image named by tag is how containers are usually run: noted, not held against it.
      else if (!/@sha256:[0-9a-f]{64}$/.test(image)) evidence.push(place(server, `runs the container image ${image}, not pinned by digest`, 'info'))
    }
  }
  return row(
    {
      id: 'mcp.launch',
      group: GROUP,
      title: 'How each server starts',
      advice: 'A server that downloads code when it starts runs whatever is published then, not what was scanned. Prefer an exact version or a digest.',
    },
    capEvidence(evidence, 30),
  )
}

/** A shell given a script as text: -c (alone or with other letters, -ec), /c, -Command. */
function runsInlineScript(program: string, args: readonly string[]): boolean {
  if (/^(?:ba|z|da|k|fi)?sh$/.test(program)) return args.some(arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))
  if (/^cmd(?:\.exe)?$/.test(program)) return args.some(arg => /^\/[ck]$/i.test(arg))
  if (/^(?:powershell|pwsh)(?:\.exe)?$/.test(program)) return args.some(arg => /^-(?:c|command|e|ec|enc|encodedcommand)$/i.test(arg))
  return false
}

/** The image a `docker run` starts: the first argument after `run` that is not an option or its value. */
function containerImage(args: readonly string[]): string | undefined {
  let index = args.indexOf('run') + 1
  while (index < args.length) {
    const arg = args[index] as string
    if (arg === '--') return args[index + 1]
    if (!arg.startsWith('-')) return arg
    index += !arg.includes('=') && VALUE_FLAGS.has(arg) ? 2 : 1
  }
  return undefined
}

function remoteCheck(servers: readonly McpServer[]): CheckResult {
  const evidence: Evidence[] = []
  for (const server of servers) {
    for (const { url, given } of remoteUrls(server)) {
      const host = url.hostname.toLowerCase()
      const via = given ? ' (an address in its configuration)' : ''
      if (url.protocol === 'http:' || url.protocol === 'ws:') {
        evidence.push(place(server, `talks to ${host}${via} without encryption`, 'fail'))
      } else if (COLLECTION_HOST.test(`${host}${url.pathname}`)) {
        evidence.push(place(server, `talks to ${host}${via}, a host often used to collect data`, 'fail'))
      } else if (/^\d{1,3}(?:\.\d{1,3}){3}$|^\[/.test(host)) {
        evidence.push(place(server, `talks to a raw IP address${via}: ${host}`, 'warn'))
      } else {
        evidence.push(place(server, `talks to a remote server${via}: ${host}`, 'info'))
      }
    }
  }
  return row(
    {
      id: 'mcp.remote',
      group: GROUP,
      title: 'Remote servers',
      advice: 'A remote server sees what Claude sends its tools and can change its tools at any time. Check that each host belongs to the publisher.',
    },
    capEvidence(evidence, 30),
  )
}

function credentialsCheck(servers: readonly McpServer[]): CheckResult {
  const evidence: Evidence[] = []
  for (const server of servers) {
    const urls = remoteUrls(server)
    const line = commandLine(server)
    const runner = server.command !== undefined && UNPINNED_RUNNER.test(line)
    // A command that reads a credential file, and can send it somewhere.
    if (server.command !== undefined && CREDENTIAL_PATH.test(line)) {
      const sends = urls.length > 0 || NETWORK_COMMAND.test(line)
      evidence.push(place(server, `${sends ? 'reads a credential file and talks to the network' : 'reads a credential file'}: ${line}`, sends ? 'fail' : 'warn'))
    }
    const handed = new Map<string, string>()
    for (const [key, value] of [...Object.entries(server.env), ...Object.entries(server.headers)]) {
      for (const name of referencedVariables(value)) handed.set(name, key)
      if (SECRET_ENV.test(key)) handed.set(key, key)
    }
    for (const arg of server.args) for (const name of referencedVariables(arg)) if (!handed.has(name)) handed.set(name, 'its arguments')
    for (const name of referencedVariables(server.url ?? '')) handed.set(name, 'url')
    for (const [name, via] of handed) {
      if (!SECRET_ENV.test(name)) continue
      if (urls.length > 0) {
        for (const { url } of urls) {
          const host = url.hostname.toLowerCase()
          evidence.push(
            belongsTo(name, host)
              ? place(server, `sends ${name} (in ${via}) to ${host}, the service it belongs to`, 'info')
              : place(server, `sends ${name} (in ${via}) to ${host}, which is not the service it belongs to`, 'fail'),
          )
        }
      } else if (runner) {
        evidence.push(place(server, `hands ${name} (in ${via}) to a package fetched when it starts, which this scan cannot read`, 'warn'))
      } else {
        evidence.push(place(server, `is given ${name} (in ${via})`, 'info'))
      }
    }
  }
  return row(
    {
      id: 'mcp.credentials',
      group: GROUP,
      title: 'Secrets given to servers',
      advice: 'A server given a key can use it as you. A key sent to a host that is not its own service is a common way to steal it.',
    },
    capEvidence(evidence, 30),
  )
}

/**
 * What the servers let Claude do, for the verdict's "It can" line: a server
 * it starts here (and the hosts that server is given), or a server elsewhere
 * that Claude talks to directly.
 */
function serverAccess(servers: readonly McpServer[]): string[] {
  const few = (items: readonly string[]): string => `${items.slice(0, 3).join(', ')}${items.length > 3 ? ` and ${items.length - 3} more` : ''}`
  const hostsOf = (server: McpServer): string[] => [...new Set(remoteUrls(server).map(({ url }) => url.hostname.toLowerCase()))]
  const local = servers.filter(server => server.url === undefined)
  const remote = [...new Set(servers.filter(server => server.url !== undefined).flatMap(hostsOf))]
  const reached = [...new Set(local.flatMap(hostsOf))]
  const lines: string[] = []
  if (local.length > 0) {
    lines.push(`start the MCP server${local.length === 1 ? '' : 's'} ${few(local.map(server => server.name))} on your machine${reached.length > 0 ? `, given the address${reached.length === 1 ? '' : 'es'} ${few(reached)}` : ''}`)
  }
  if (remote.length > 0) lines.push(`connect Claude to ${few(remote)}`)
  return lines
}

function referencedVariables(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(ENV_REFERENCE)) {
    const name = match[1] ?? match[2]
    if (name !== undefined) names.push(name)
  }
  return names
}

/**
 * Whether a key named `name` belongs on `host`: the host is one of its
 * service's own domains or below one. For a service with no list, the
 * service's word must be the host's own name (notion for mcp.notion.so), not
 * any label: github.evil.example is evil.example's.
 */
function belongsTo(name: string, host: string): boolean {
  const labels = host.split('.')
  for (const word of vendorWords(name)) {
    const domains = SERVICE_DOMAINS[word]
    if (domains !== undefined) {
      if (domains.some(domain => host === domain || host.endsWith(`.${domain}`))) return true
    } else if (labels.length >= 2 && labels[labels.length - 2] === word) {
      return true
    }
  }
  return false
}

/** The words of a variable's name that name a service: GITHUB_TOKEN gives github. */
function vendorWords(name: string): string[] {
  return name
    .toLowerCase()
    .split('_')
    .map(word => SERVICE_WORDS[word] ?? word)
    .filter(word => word.length >= 3 && !GENERIC_WORDS.has(word))
}

function baseName(command: string): string {
  return (command.split(/[\\/]/).pop() ?? command).toLowerCase()
}

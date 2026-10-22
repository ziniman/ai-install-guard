import type { McpServer, ScanContext } from './context'
import { COLLECTION_HOST, DOWNLOAD_AND_RUN, SECRET_ENV, UNPINNED_RUNNER } from './patterns'
import { row, type CheckResult, type Evidence, type Status } from './types'

const GROUP = 'mcp' as const

/** Words in a variable's name that say nothing about whose credential it is. */
const GENERIC_WORDS = new Set(['api', 'key', 'keys', 'token', 'tokens', 'auth', 'oauth', 'secret', 'access', 'session', 'client', 'bot', 'app', 'personal', 'private', 'password', 'credentials', 'application', 'hub', 'code'])

/** Short or product names in a variable, and the word its service's hosts carry. */
const SERVICE_WORDS: Record<string, string> = { gh: 'github', hf: 'huggingface', hugging: 'huggingface', face: 'huggingface', claude: 'anthropic', node: 'npm' }

/** A `${NAME}` or `$NAME` reference to an environment variable. */
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]{0,100})(?::-[^}]{0,200})?\}|\$([A-Za-z_][A-Za-z0-9_]{0,100})/g

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

/** The remote address a server talks to: its own URL, or one a local proxy is given. */
function remoteUrl(server: McpServer): URL | undefined {
  const candidates = server.url !== undefined ? [server.url] : server.args.filter(arg => /^(?:https?|wss?):\/\//i.test(arg))
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate)
      if (isLocal(url.hostname)) continue
      return url
    } catch {
      continue
    }
  }
  return undefined
}

function isLocal(host: string): boolean {
  return /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i.test(host)
}

function inventoryCheck(servers: readonly McpServer[]): CheckResult {
  const evidence = servers.slice(0, 30).map(server => {
    const what = server.url !== undefined ? `${server.type ?? 'http'} server at ${server.url}` : `runs ${commandLine(server) || '(no command)'}`
    const env = Object.keys(server.env)
    return place(server, `${what}${env.length > 0 ? `; environment: ${env.slice(0, 10).join(', ')}` : ''}`, 'info')
  })
  if (servers.length > 30) evidence.push({ file: '-', excerpt: `and ${servers.length - 30} more`, status: 'info' })
  return row(
    {
      id: 'mcp.servers',
      group: GROUP,
      title: 'MCP servers it adds',
      advice: 'Each MCP server runs as a program on your machine or talks to a server elsewhere, and Claude can call every tool it offers.',
    },
    evidence,
    'info',
  )
}

function launchCheck(servers: readonly McpServer[]): CheckResult {
  const evidence: Evidence[] = []
  for (const server of servers) {
    if (server.command === undefined) continue
    const line = commandLine(server)
    if (DOWNLOAD_AND_RUN.test(line)) {
      evidence.push(place(server, `downloads code and runs it: ${line}`, 'fail'))
      continue
    }
    if (UNPINNED_RUNNER.test(line)) {
      evidence.push(place(server, `fetches a package that is not pinned to an exact version each time it starts: ${line}`, 'warn'))
    } else if (/^(?:npx|bunx|pnpx|uvx|pipx|pnpm|yarn|bun|deno)$/.test(baseName(server.command))) {
      evidence.push(place(server, `fetches a package when it starts; the package is not part of this scan: ${line}`, 'info'))
    }
    if (/^(?:ba|z|da|k)?sh$|^(?:cmd|powershell|pwsh)(?:\.exe)?$/i.test(baseName(server.command)) && server.args.some(arg => /^(?:-c|\/c|-Command|-EncodedCommand|-e)$/i.test(arg))) {
      evidence.push(place(server, `runs an inline shell script: ${line}`, 'warn'))
    }
    if (/^(?:docker|podman)$/.test(baseName(server.command)) && server.args.includes('run') && !server.args.some(arg => /@sha256:[0-9a-f]{64}$/.test(arg))) {
      evidence.push(place(server, `runs a container image not pinned by digest: ${line}`, 'warn'))
    }
  }
  return row(
    {
      id: 'mcp.launch',
      group: GROUP,
      title: 'How each server starts',
      advice: 'A server that downloads code when it starts runs whatever is published then, not what was scanned. Prefer an exact version or a digest.',
    },
    evidence,
  )
}

function remoteCheck(servers: readonly McpServer[]): CheckResult {
  const evidence: Evidence[] = []
  for (const server of servers) {
    const url = remoteUrl(server)
    if (url === undefined) continue
    const host = url.hostname.toLowerCase()
    const via = server.url === undefined ? ' through a local proxy' : ''
    if (url.protocol === 'http:' || url.protocol === 'ws:') {
      evidence.push(place(server, `talks to ${host}${via} without encryption`, 'fail'))
    } else if (COLLECTION_HOST.test(`${host}${url.pathname}`)) {
      evidence.push(place(server, `talks to ${host}${via}, a host often used to collect data`, 'fail'))
    } else if (/^\d{1,3}(?:\.\d{1,3}){3}$|^\[/.test(host)) {
      evidence.push(place(server, `talks to a raw IP address${via}: ${host}`, 'warn'))
    } else {
      evidence.push(place(server, `talks to a remote server${via}: ${host}`, 'warn'))
    }
  }
  return row(
    {
      id: 'mcp.remote',
      group: GROUP,
      title: 'Remote servers',
      advice: 'A remote server sees what Claude sends its tools and can change its tools at any time. Check that each host belongs to the publisher.',
    },
    evidence,
  )
}

function credentialsCheck(servers: readonly McpServer[]): CheckResult {
  const evidence: Evidence[] = []
  for (const server of servers) {
    const url = remoteUrl(server)
    const runner = server.command !== undefined && UNPINNED_RUNNER.test(commandLine(server))
    const handed = new Map<string, string>()
    for (const [key, value] of [...Object.entries(server.env), ...Object.entries(server.headers)]) {
      for (const name of referencedVariables(value)) handed.set(name, key)
      if (SECRET_ENV.test(key)) handed.set(key, key)
    }
    for (const name of referencedVariables(server.url ?? '')) handed.set(name, 'url')
    for (const [name, via] of handed) {
      if (!SECRET_ENV.test(name)) continue
      if (url !== undefined) {
        const host = url.hostname.toLowerCase()
        const owner = vendorWords(name).some(word => host.includes(word))
        evidence.push(
          owner
            ? place(server, `sends ${name} (in ${via}) to ${host}`, 'warn')
            : place(server, `sends ${name} (in ${via}) to ${host}, which is not the service it belongs to`, 'fail'),
        )
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
    evidence,
  )
}

function referencedVariables(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(ENV_REFERENCE)) {
    const name = match[1] ?? match[2]
    if (name !== undefined) names.push(name)
  }
  return names
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

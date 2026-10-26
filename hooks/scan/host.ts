// The scanner's view of the machine. The scan code never touches `$` or Node
// directly: the mod passes a host built on `$.fs` and `$.process`, and tests
// pass one that answers from fixtures in memory.

export type HostEntryKind = 'file' | 'dir' | 'other'

export type HostEntry = {
  name: string
  kind: HostEntryKind
  size: number
  isLink: boolean
}

export type HostStat = {
  kind: HostEntryKind
  size: number
  isLink: boolean
  /** Where the path lands with every link followed; absent when it leads nowhere. */
  realPath?: string
}

export type RunResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type RunOptions = {
  cwd?: string
  timeoutMs?: number
  /** Variables set over the host's own environment. */
  env?: Record<string, string>
}

/** An HTTP answer, the body read as text. */
export type FetchResult = {
  status: number
  ok: boolean
  /** Lower-cased names. */
  headers: Record<string, string>
  text: string
}

export type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }

export type Host = {
  /** HTTPS requests, for repository metadata and the lookups you turn on. Absent where there is no network. */
  fetch?: (url: string, init?: FetchInit) => Promise<FetchResult>
  list: (path: string) => Promise<HostEntry[]>
  stat: (path: string, options?: { resolve: boolean }) => Promise<HostStat>
  readBytes: (path: string) => Promise<Uint8Array>
  /** The target text stored in a symbolic link, as `readlink` prints it. */
  readLink: (path: string) => Promise<string>
  run: (argv: readonly string[], options?: RunOptions) => Promise<RunResult>
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

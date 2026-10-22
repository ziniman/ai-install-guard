// Detection patterns shared by the checks. They are written as escaped
// regular expressions so the guard's own source does not match its rules.

/** A network tool at the start of a shell command or after a separator. */
export const NETWORK_COMMAND = /(?:^|[\s;&|(`'"])(?:curl|wget|nc|ncat|netcat|socat|telnet|ssh|scp|sftp|rsync|ftp|tftp|nslookup)(?=\s|$)/

/** Network access in source code. */
export const NETWORK_CODE =
  /\bfetch\s*\(|\bXMLHttpRequest\b|\bhttps?\.(?:request|get)\s*\(|\brequire\s*\(\s*['"](?:node:)?(?:http|https|net|dgram|tls|dns)['"]\s*\)|\bfrom\s+['"](?:node:)?(?:http|https|net|dgram|tls|dns)['"]|\baxios\b|\bundici\b|\brequests\.(?:get|post|put|patch|request|Session)\b|\burllib\b|\bhttpx\b|\bsocket\.(?:socket|create_connection)\b|\bnew\s+WebSocket\b|\$\s*\.\s*http\s*\.\s*fetch\b|\bdns\.(?:lookup|resolve\w*)\s*\(/

/** Downloading code and running it, or decoding text and running it. */
export const DOWNLOAD_AND_RUN =
  /\b(?:curl|wget)\b[^\n|]{0,500}\|\s*(?:sudo\s+)?(?:\/[\w.\/-]*\/)?(?:env\s+)?(?:ba|z|da|k)?sh\b|\b(?:curl|wget)\b[^\n|]{0,500}\|\s*(?:sudo\s+)?(?:\/[\w.\/-]*\/)?(?:env\s+)?(?:python[23]?|node|perl|ruby|php)\b|\b(?:ba|z)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)|(?:\b(?:source|(?:ba|z|da|k)?sh)|(?:^|(?<=[\s;&|(]))\.)\s+<\(\s*(?:curl|wget)|\bbase64\s+(?:-d|--decode|-D)\b[^\n|]{0,500}\|\s*(?:sudo\s+)?(?:\/[\w.\/-]*\/)?(?:env\s+)?(?:ba|z|da)?sh\b|\bpython[23]?\s+-c\s+["'][^"'\n]{0,500}urllib|\beval\s+["']?\$\(\s*(?:curl|wget|echo|base64)/

/**
 * Fetching and running a package that is not pinned to an exact version:
 * no version, a tag (@latest, @next) or a range (@^1.2) all count. An exact
 * x.y.z, with any prerelease (-rc-1) or build (+5) part, is a pin.
 */
export const UNPINNED_RUNNER =
  /\b(?:npx|bunx|pnpx)\s+(?:-{1,2}[\w-]+\s+){0,5}(?!-)(?:@[\w.-]+\/)?[\w.-]+(?:@(?!\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?(?![\w.+-]))[^\s`'"();&|]*)?(?![@\w./-])|\b(?:uvx|pipx\s+run)\s+(?!\S+(?:==|@)\d)/

/** Shell `eval` and piping into a shell. */
export const SHELL_EVAL = /(?:^|[\s;&|(])eval\s|\|\s*(?:sudo\s+)?(?:\/[\w.\/-]*\/)?(?:env\s+)?(?:ba|z|da|k)?sh\s*(?:$|[;&|)])/m

/** Places that hold credentials. */
export const CREDENTIAL_PATH =
  /\.ssh(?:\/|\b)|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\.aws\/(?:credentials|config)\b|\.(?:netrc|git-credentials|pypirc)\b|\.npmrc\b|\.docker\/config\.json|\.kube\/config\b|\.config\/gh\/hosts|\.gnupg\b|\.claude\/\.credentials|Library\/Keychains|\bsecurity\s+(?:find|dump)-(?:generic|internet)-password|\bdump-keychain\b|\bLogin Data\b|Cookies\.binarycookies|\/Google\/Chrome\/|\.mozilla\/firefox|BraveSoftware|Microsoft\/Edge\//

/** Environment variables that hold secrets, and dumps of the whole environment. */
export const SECRET_ENV =
  /\b(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_CLIENT_SECRET|GOOGLE_APPLICATION_CREDENTIALS|SLACK_BOT_TOKEN|SLACK_TOKEN|STRIPE_SECRET_KEY|HF_TOKEN|HUGGING_FACE_HUB_TOKEN)\b|\bJSON\.stringify\s*\(\s*process\.env\s*\)|\bObject\.(?:entries|keys|values)\s*\(\s*process\.env\s*\)|\bjson\.dumps\s*\(\s*(?:dict\s*\(\s*)?os\.environ|(?:^|[\s;&|])printenv[ \t]*(?:$|[|>;&])|(?:^|[\s;&|])env[ \t]*\|/m

/** Places whose change persists past the session or grants itself more. */
export const PERSISTENCE_TARGET =
  /(?<![\w$)\]])\.(?:bashrc|bash_profile|bash_login|profile|zshrc|zprofile|zshenv|zlogin)\b|\bconfig\.fish\b|\bcrontab\b|\/etc\/cron|\bLaunchAgents\b|\bLaunchDaemons\b|\blaunchctl\s+(?:load|bootstrap|submit)\b|\bsystemctl\s+(?:--user\s+)?enable\b|\/etc\/systemd\/|\.config\/systemd\/|\.git\/hooks\b|\bcore\.hooksPath\b|\/etc\/profile\b|\.config\/autostart\b|CurrentVersion\\+Run\b/

/** Claude Code settings and permission switches. */
export const CLAUDE_SETTINGS =
  /\.claude\/settings(?:\.local)?\.json|\bbypassPermissions\b|--dangerously-skip-permissions|\bdangerouslySkipPermissions\b|\benableAllProjectMcpServers\b|\benabledMcpjsonServers\b|"defaultMode"\s*:\s*"(?:bypassPermissions|acceptEdits)"|\bskipDangerousModePermissionPrompt\b|\bpermissions\s*(?:\.|\[\s*['"])\s*allow\b/

/** Claude Code folders that load what is written into them. */
export const CLAUDE_LOAD_DIR = /\.claude\/(?:skills|plugins|agents|commands|hooks)\b|\bCLAUDE\.md\b/

/** Writing a file from a shell command: a redirect, tee, cp, mv and the like. */
export const WRITE_SHELL =
  /(?<![<>=!-])(?:\d?>>?|&>>?)(?!&)\s*["']?(?!\/dev\/null)[~$\/.\w]|\btee\s+(?:-a\s+)?["']?[~$\/.\w]|(?:^|[\s;&|])(?:cp|mv|install|ln|rsync)\s+\S|\bsed\s+-i\b/

/** Writing a file from JavaScript or Python. */
export const WRITE_CODE =
  /\b(?:writeFile|appendFile|createWriteStream|writeFileSync|appendFileSync|copyFile|copyFileSync|renameSync|symlinkSync|cpSync)\s*\(|\bBun\.write\s*\(|\bDeno\.writeTextFile\s*\(|\$\s*\.\s*fs\s*\.\s*write\b|\bopen\s*\([^\n]{0,300}?,\s*(?:mode\s*=\s*)?['"](?:w|a|x|r\+|w\+|a\+)b?['"]|\.open\s*\(\s*(?:mode\s*=\s*)?['"](?:w|a|x|r\+|w\+|a\+)b?['"]|\.write_(?:text|bytes)\s*\(|\bshutil\.(?:copy\w*|move)\s*\(|\bos\.(?:rename|replace|symlink)\s*\(/

/** Running programs from code. */
export const PROCESS_CODE =
  /\brequire\s*\(\s*['"](?:node:)?child_process['"]\s*\)|\bfrom\s+['"](?:node:)?child_process['"]|\b(?:execSync|execFileSync|spawnSync|execFile)\s*\(|\bchild_process\b|\bBun\.spawn(?:Sync)?\s*\(|\bDeno\.(?:run|Command)\b/

export const PYTHON_PROCESS = /\bsubprocess\.(?:run|call|Popen|check_output|check_call|getoutput|getstatusoutput)\b|\bos\.(?:system|popen|spawn\w*|exec[lv]p?e?)\s*\(|\bpty\.spawn\s*\(/

/** Building code from text at run time. */
export const CODE_FROM_TEXT = /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.(?:runIn\w*Context|Script|compileFunction)\b|\bimport\s*\(\s*['"`]https?:/

export const PYTHON_CODE_FROM_TEXT = /(?:^|[^.\w])(?:exec|eval|compile)\s*\(|\b__import__\s*\(|\b(?:pickle|marshal|dill|cloudpickle)\.loads?\s*\(/

/** Decoding text into bytes or code. */
export const DECODE = /\batob\s*\(|\bBuffer\.from\s*\([^)\n]{0,300}['"](?:base64|hex)['"]|\bbase64\.(?:b64decode|b32decode|a85decode|decodebytes)\b|\bbase64\s+(?:-d|--decode|-D)\b|\bcodecs\.decode\s*\(|\bbytes\.fromhex\s*\(/

/** Hosts often used to collect stolen data. */
export const COLLECTION_HOST =
  /\b(?:webhook\.site|requestbin\.(?:com|net)|pipedream\.net|[\w-]{1,63}\.ngrok(?:-free)?\.(?:io|app|dev)|transfer\.sh|pastebin\.com|paste\.ee|hastebin\.com|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org|burpcollaborator\.net|oast\.(?:fun|me|pro|live|site|online)|interact\.sh|[\w-]{1,63}\.trycloudflare\.com|hooks\.slack\.com)\b/i

/** Known key formats. Evidence names the kind and place, never the value. */
export const SECRET_KEYS: readonly { kind: string; pattern: RegExp }[] = [
  { kind: 'AWS access key ID', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { kind: 'AWS secret access key', pattern: /\baws_?secret_?access_?key\b['"]?\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/i },
  { kind: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{22,255}\b/ },
  { kind: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/ },
  { kind: 'Slack webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]{1,40}\/B[A-Za-z0-9]{1,40}\/[A-Za-z0-9]{1,64}/ },
  { kind: 'private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'Anthropic API key', pattern: /\bsk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,255}/ },
  { kind: 'OpenAI API key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,200}T3BlbkFJ[A-Za-z0-9_-]{16,200}/ },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'Stripe live key', pattern: /\b(?:sk|rk)_live_[0-9a-zA-Z]{24,255}\b/ },
  { kind: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: 'SendGrid key', pattern: /\bSG\.[\w-]{22}\.[\w-]{43}\b/ },
  { kind: 'Hugging Face token', pattern: /\bhf_[A-Za-z0-9]{34,255}\b/ },
]

/** A secret variable given a value in text: `ANTHROPIC_API_KEY=...`, `"GITHUB_TOKEN": "..."`. */
const SECRET_ASSIGNMENT =
  /\b((?:[A-Z][A-Z0-9]*_)*(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_KEY|SECRET_ACCESS_KEY|SECRET_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY))(['"]?\s*[:=]\s*['"]?)([^\s'"`,;]{6,})/g

/**
 * Replaces anything that looks like a key or a secret's value with
 * `[redacted <kind>]`. Every excerpt a report shows passes through it, so a
 * line quoted for another reason cannot print a key.
 */
export function redactSecrets(text: string): string {
  let out = text
  for (const { kind, pattern } of SECRET_KEYS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), `[redacted ${kind}]`)
  }
  return out
    .replace(SECRET_ASSIGNMENT, (_, name: string, separator: string) => `${name}${separator}[redacted]`)
    // A password in a URL: https://user:secret@host keeps the user, hides the secret.
    .replace(/(\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,100}:)[^\s@/]{1,200}@/gi, '$1[redacted]@')
}

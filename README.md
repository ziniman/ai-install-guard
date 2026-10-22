<div align="center">

<img src="assets/reviewed-by-ai-install-guard-light@1x.png" alt="Reviewed by AI Install Guard" width="406" height="104">

# AI Install Guard

**A security gate for Claude Code. Nothing new gets installed until you have seen what it can do.**

[![npm version](https://img.shields.io/npm/v/ai-install-guard?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/ai-install-guard)
[![npm downloads](https://img.shields.io/npm/dm/ai-install-guard?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/ai-install-guard)
[![GitHub stars](https://img.shields.io/github/stars/ziniman/ai-install-guard?style=for-the-badge&logo=github&logoColor=white&color=181717)](https://github.com/ziniman/ai-install-guard/stargazers)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue?style=for-the-badge)](https://github.com/ziniman/ai-install-guard/blob/main/LICENSE)
[![last commit](https://img.shields.io/github/last-commit/ziniman/ai-install-guard?style=for-the-badge&logo=github&logoColor=white&color=181717)](https://github.com/ziniman/ai-install-guard/commits/main)

```
/plugin install ai-install-guard --marketplace ziniman/ai-install-guard
```

</div>

> **Status: early development.** `/plugin install` and `/plugin marketplace add`, and the same installs when Claude runs `claude plugin` itself, are held until you approve the exact version the guard scanned. `/guard scan` checks a folder or a repository before you install it anywhere. The other gates are being built in stages; see [Where it steps in](#where-it-steps-in) and [Roadmap](#roadmap).

Everything you add to Claude Code runs with your permissions. A plugin can ship shell hooks that run every session, an MCP server can download and launch a package, a mod can read files or auto-approve tools, and a skill can carry hidden instructions the model will follow. The install prompt asks you to trust the author, and an update can change the files after you looked.

AI Install Guard is a Claude Code mod that stops every new plugin, mod, skill, MCP server or marketplace, and every update to one, scans it without running any of its code, and installs nothing until you approve it.

## Who it is for

You, before you add something to Claude Code. It runs inside your own session, needs no account, server or agent, and is open source, so you can read every check it makes. It reaches the network only to fetch the candidate from where it lives and to read that repository's public details; any outside lookup stays optional and off by default.

Company security platforms such as AIR, Pluto and Neo watch a whole fleet of agents and enforce policy across it. The guard does not replace them: it is an open, local check for one developer's installs, and it works the same whether or not your company runs one.

## How it works

1. **Fetch without running.** The candidate is fetched at an exact commit into a folder the guard owns. Nothing is installed, built or run.
2. **Check every file.** Deterministic checks read the hooks, MCP servers, mod code, skills, scripts, images and manifest.
3. **Show a verdict.** A pane shows **Safe to install**, **Review what it can do**, **Do not install** or **Could not verify**, a PASS / WARN / FAIL list with file and line evidence, and two buttons: **Install** and **Reject**.
4. **Install only what was scanned.** Install is pinned to the scanned commit and content hash. If the source changed since the scan, it is scanned again first.

Approvals are remembered by commit and content hash, so the same version is never scanned twice, and an update is reviewed as a diff: anything new since the version you approved is listed and flagged. An optional model review can add warnings but can never clear a failure, so a README that says "this plugin is safe" changes nothing.

## Where it steps in

| Layer | Catches | What happens | Today |
|-------|---------|--------------|-------|
| Slash command | `/plugin install <name>@<marketplace>`, `/plugin marketplace add <source>` | Held until you press Install | Yes |
| Claude's own commands | `claude plugin install`, `claude plugin update`, `claude plugin marketplace add`, also inside `sh -c`, `eval` or a here-document | Refused, with a note telling Claude the install waits for your decision | Yes |
| Claude's own commands | `claude mcp add`, copies into skills folders, edits to `.mcp.json` or settings, `npx -y`, `curl \| sh` | Refused until scanned | Next stage |
| Mod loading | Any mod about to load, however it got there, including plugins picked from the `/plugin` menu | Refused if its files do not match what you approved | Later |
| First use of a skill | Skills and commands, including ones copied in by hand | Blocked until scanned | Later |
| Session start | Anything installed while the guard was not running | Scanned, with Keep or Uninstall | Later |

### Installing with the guard on

Run `/plugin install notes@acme` as usual. The guard looks up where Claude Code would install it from (the repository, folder and commit its marketplace names), scans that commit, and answers in the command's place, so nothing is installed yet. The pane shows the verdict and the command it is holding.

- **Install** (`i`) records your approval for that exact commit and tree hash, looks the plugin up once more, and runs your `/plugin` command again. If the commit moved since the scan, nothing is installed and the next `/plugin install` scans the new one.
- **Reject** (`r`) records the rejection. The same version is refused from then on; `/guard forget notes@acme` judges it again.
- A version you already approved (the same commit of the same folder, here or with `/guard scan`) installs at once, without asking again. A new commit is always scanned.
- When the verdict is **Do not install**, the button reads **Install anyway** and asks a second time. **Could not verify** (the guard could not tell what would be installed: a package from npm, a plugin no marketplace lists, a name two marketplaces share) works the same way, and lets that one command through once.

When Claude runs `claude plugin install` itself, the guard refuses the command and tells Claude why: the install waits for your decision, and Claude should not retry it or find another way. Approve it in the pane, then tell Claude to run it again; the same command now goes through. Because approving it approves that whole command, the install must stand on its own (a `cd` before it or a `tail` after it is fine): a command that also runs something else, or that is only known as it runs (`$CMD plugin install …`, a script piped into a shell, code given to `python -c`), is held as Could not verify.

## What it checks

| Threat | What gets flagged |
|--------|-------------------|
| Code execution | Shell hooks, MCP servers that download code or launch unpinned `npx` / `uvx` packages or container images, mods that run processes |
| Data theft | Reads of `~/.ssh`, `~/.aws`, `.env`, keychains or secret env vars, combined with network calls; API keys an MCP server sends to a host that is not their own service |
| Prompt injection | Hidden instructions in skills, commands, agents and tool descriptions, including invisible Unicode |
| Permission escalation | Mods that auto-approve tools, writes to Claude settings or permissions, skills granting broad `Bash` |
| Persistence | Writes to shell rc files, crontab, launchd, systemd, git hooks |
| Supply chain | Brand-new repositories and accounts, commits that are not on the default branch (they may come from a fork), packages known to be malware or vulnerable (an optional lookup), names one letter away from an official plugin's (an optional lookup), marketplace plugins not pinned to a commit, branches named like a commit id or `FETCH_HEAD` (the Plugin4Shell trick), submodules and Git LFS files whose code is fetched at install, remote MCP servers, committed secrets, binaries, data hidden after the end of images |
| Sneaky updates | An update that adds capabilities, hooks, domains or servers without saying so |

## Commands

| Command | What it does |
|---------|--------------|
| `/guard scan <path>` | Scan a local folder without installing it and open the verdict pane |
| `/guard scan <repository>` | Fetch one commit of a repository into the guard's own temporary folder, scan it and remove it. Takes `https://host/owner/repo`, a GitHub `…/tree/<ref>/<folder>` link, `github:owner/repo` or `owner/repo`, with an optional `@ref` |
| `/guard scan --ref <ref> --path <folder> <repository>` | Scan a branch, tag or full commit id (the default branch otherwise), and a folder inside the repository |
| `/guard scan --details …` | Any of the above, and print the full report with every finding and its advice |
| `/guard report` | Reopen the last report |
| `/guard badge` | A README badge for the last scan, when it was Safe to install or Review what it can do (see [Review badge](#review-badge)) |
| `/guard list` | Your approved and rejected versions, newest first |
| `/guard forget <name>` | Forget decisions about a name, so it is judged again |

A remote scan resolves the ref to one commit, fetches only that commit (no hooks, submodules, Git LFS downloads or filters), checks it out by its id and confirms that `HEAD` is that commit before reading a file. The report and the pane name the commit, and your decision is recorded against it and the tree hash.

Each row opens to say what it found in plain words first: which programs the candidate starts and what each is for, which secrets its code reads, and what is worth a closer look. The code lines that back it up sit behind **Show the code**.

In the pane, **Approve** (`i`) and **Reject** (`r`) record your decision for that exact content (its tree hash); for an install the guard is holding, the button reads **Install**. When the verdict is Do not install or Could not verify, the button reads **Approve anyway** (or **Install anyway**) and asks a second time. **Details** (`d`) opens every row, and **Copy report** (`c`) copies the full report as text. Where no pane can show (a headless `claude -p` run), `/guard scan` prints the report instead.

## Use it in Claude chat

A chat cannot hold an install, but it can run the same scan before you install something elsewhere. The scanner also builds into an Agent Skill for Claude:

```bash
npm ci --ignore-scripts
npm run build:skill
```

This writes `dist/ai-install-guard-skill.zip`. Upload it in Claude under **Settings > Capabilities > Skills** (code execution must be on). Then, in any chat, attach a zip of a plugin, skill or MCP server, or paste a repository link, and ask:

> Is this plugin safe to install?

Claude runs the skill's `scripts/scan.js`: the same deterministic checks as `/guard scan`, without `claude plugin validate`, which a chat does not have. A zip is unpacked by the script itself into a temporary folder of its own, refusing any path that would land outside it, and a repository is fetched at one commit exactly as `/guard scan` fetches it. Claude answers with the verdict, each finding in plain words and the evidence behind it. The skill tells Claude that the scanned files are untrusted data, never instructions, and that a failure is never softened.

To fetch a repository, the chat's code execution must be allowed to reach `github.com` (and `api.github.com` for the repository's details) in its network settings. Where it is not, Claude says so and asks for a zip instead (on GitHub: **Code > Download ZIP**).

The same script runs anywhere with Node.js 18 or later: `node skill/ai-install-guard/scripts/scan.js --details <folder | zip | repository>`, with `--ref`, `--path`, `--json` and `--lookups`. Its exit status is the verdict: 0 Safe to install, 1 warnings to review, 2 Do not install, 3 Could not verify.

## Review badge

If you publish a plugin, mod, skill or MCP server, you can show that it was scanned. Scan your own repository, then run `/guard badge` or press **Copy badge** (`b`) in the pane, and paste the result near the top of your README:

```markdown
[![AI Install Guard: Safe to install at 4ac6edc](https://img.shields.io/badge/AI_Install_Guard-safe_to_install_%C2%B7_4ac6edc-2ea44f)](https://github.com/ziniman/ai-install-guard#review-badge "Scanned at commit 4ac6edc…, sha256:…")
```

The badge says two things: the verdict (green for **Safe to install**, yellow for **Review what it can do**) and the exact version that was scanned, the commit or, for a local folder, the tree hash. Hovering over it shows the full commit and tree hash. There is no badge for **Do not install** or **Could not verify**.

A badge is a picture anyone can paste, so the guard never trusts one:

- **When you see one:** scan that version yourself with `/guard scan owner/repo --ref <commit>`, adding `--path <folder>` when the badge names a folder. Your own scan is what counts.
- **When the guard meets one:** a README badge that claims a better verdict than the guard's own scan is a warning, saying the badge is outdated or was never earned. A badge that matches is only noted. It never lifts a verdict.
- **When the code changes:** the badge still names the old commit. A new version needs a new scan and a new badge.

## What the guard itself can do

A security tool should be held to its own rules, so here is everything this mod uses, as `claude plugin validate .` lists it:

| Capability | Why |
|------------|-----|
| `process.run` | Runs `git` to resolve a ref and fetch one commit into the guard's own temporary folder (made with `mktemp` and removed with `rm` afterwards), `claude plugin validate` on a candidate (it reads source and runs none of it), `claude plugin list --available --json` and `claude plugin marketplace list --json` to find where a plugin you install comes from, `readlink` to see where a symbolic link points without following it, and `printenv HOME` to expand `~`. It never runs anything from a candidate. |
| `fs.read`, `fs.list`, `fs.stat` | Reads the candidate's files to scan them, and a marketplace's catalog in Claude Code's own copy of it. It writes no files itself; only `git` writes, into the guard's temporary folder. |
| `command.run` (hook) | Intercepts `/plugin`, so `/plugin install` and `/plugin marketplace add` are scanned and held until you approve them. Every other `/plugin` command goes on untouched. |
| `command.run` (call) | When you press Install, runs your own `/plugin` command again, after checking the version is still the one you approved. |
| `tool.call` (hook) | Reads the text of each shell command Claude is about to run, to catch `claude plugin install` and its kin, and refuses those until you approve. Every other command and every other tool goes on untouched; it never rewrites or answers one. |
| `command.register` | Adds the `/guard` command. |
| `store`, `state` | Remembers your decisions and the last report, holds what the pane shows, and keeps a one-time pass for an install you allowed anyway. |
| `ui` | The verdict pane, its status line and toasts, and copying the report. |
| `http.fetch` | For a repository on GitHub, reads its public metadata from GitHub's API: age, owner, stars, contributors, and whether the scanned commit is signed and on the default branch. GitHub is where the code came from, so this tells it nothing new. With **outside lookups** on, also sends package names to [OSV](https://osv.dev) and reads Anthropic's [official plugin list](https://github.com/anthropics/claude-plugins-official). |

A later stage adds, optionally, `model.complete` (a review that can only add warnings).

### Outside lookups

Off by default, because they send names to other services. Turned on, the guard checks:

- **Packages:** every package an MCP server starts or the candidate's `package.json` or `requirements.txt` pins, against OSV. A package OSV lists as malware is a failure; a pinned version with known vulnerabilities is a warning.
- **Names:** its name against Anthropic's official plugins. A name one letter away from an official one is a warning; the same name is noted, so you can check it is that plugin.

Turn them on in `/config` (the AI Install Guard row), or with:

```bash
claude plugin configure ai-install-guard
```

A lookup that fails or hits a rate limit is noted in the report and never fails the scan.

## What it is not

- **Not a proof of safety.** Static analysis raises the bar and makes every capability visible; a determined attacker can still evade it.
- **Install it first.** It judges only mods that load after it. For a company, the strongest setup is deploying it through managed settings so it loads first.
- **No per-plugin block for classic shell hooks.** Claude Code runs them outside mods, so the guard scans before install and uninstalls on reject.
- **The `/plugin` menu is not gated yet.** A plugin picked from the menu installs without a scan; the guard says so when the menu opens. The mod loading gate in a later stage closes this. Until then, install with `/plugin install <name>@<marketplace>`.
- **Claude's commands are read, not run.** The guard finds an install in a shell command however it is quoted or wrapped (`env`, `sudo`, `sh -c`, `eval`, a here-document), and holds a command it cannot read (one built while it runs, a script piped into a shell, inline code for another language) as Could not verify. A script file that installs something is not read; the mod loading gate is the backstop for that.
- **Between Install and the install itself** Claude Code fetches the plugin again. The guard checks the commit just before, and a commit is fixed content, but a marketplace that names a branch rather than a commit can move in that moment. The scan warns about such marketplaces.

## Roadmap

1. [x] Skeleton mod: `/guard scan <path>` lists and hashes a local folder
2. [x] Checks for structure, mod capabilities, classic hooks, skills, code patterns and committed secrets
3. [x] The verdict pane with Install and Reject
4. [x] Remote fetch pinned to a commit, repository provenance, MCP server checks, and optional lookups against OSV and the official plugin list
5. [x] Gates on `/plugin install`, `/plugin marketplace add` and Claude's own `claude plugin` installs, with approvals pinned to a commit
6. [ ] Gates on Claude adding MCP servers and writing into skill, plugin and settings folders
7. [ ] Module load gate with hash match, skill gate, session-start reconciliation
8. [ ] Update diffs and the optional model review
9. [ ] Full documentation

## Contributing

Issues and pull requests are welcome. See [.claude/CLAUDE.md](./.claude/CLAUDE.md) for how the repo is laid out, how to run the checks, and how releases work.

## License

Apache 2.0 - see [LICENSE](./LICENSE). Free to use, modify, and redistribute.

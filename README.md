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

> **Status: early development.** Today `/guard scan` runs the deterministic checks on a local folder, or on one commit of a repository it fetches without running anything, and shows the verdict in a pane, where you approve or reject that exact version. The install gates below are being built in stages; see [Roadmap](#roadmap).

Everything you add to Claude Code runs with your permissions. A plugin can ship shell hooks that run every session, an MCP server can download and launch a package, a mod can read files or auto-approve tools, and a skill can carry hidden instructions the model will follow. The install prompt asks you to trust the author, and an update can change the files after you looked.

AI Install Guard is a Claude Code mod that stops every new plugin, mod, skill, MCP server or marketplace, and every update to one, scans it without running any of its code, and installs nothing until you approve it.

## Who it is for

You, before you add something to Claude Code. It runs inside your own session, needs no account, server or agent, and is open source, so you can read every check it makes. This release makes no network calls; later stages fetch the candidate itself, and any outside lookup stays optional and off by default. Today you run `/guard scan` on a folder yourself before installing it; the gates that hold an install automatically come in later stages (see [Roadmap](#roadmap)).

Company security platforms such as AIR, Pluto and Neo watch a whole fleet of agents and enforce policy across it. The guard does not replace them: it is an open, local check for one developer's installs, and it works the same whether or not your company runs one.

## How it works

1. **Fetch without running.** The candidate is fetched at an exact commit into a folder the guard owns. Nothing is installed, built or run.
2. **Check every file.** Deterministic checks read the hooks, MCP servers, mod code, skills, scripts, images and manifest.
3. **Show a verdict.** A pane shows **Safe to install**, **Review what it can do**, **Do not install** or **Could not verify**, a PASS / WARN / FAIL list with file and line evidence, and two buttons: **Install** and **Reject**.
4. **Install only what was scanned.** Install is pinned to the scanned commit and content hash. If the source changed since the scan, it is scanned again first.

Approvals are remembered by commit and content hash, so the same version is never scanned twice, and an update is reviewed as a diff: anything new since the version you approved is listed and flagged. An optional model review can add warnings but can never clear a failure, so a README that says "this plugin is safe" changes nothing.

## Where it steps in

| Layer | Catches | What happens |
|-------|---------|--------------|
| Slash command | `/plugin install`, `/plugin update`, `/plugin marketplace add` | Held until you press Install |
| Claude's own tool calls | `claude plugin install`, `claude mcp add`, copies into skills folders, edits to `.mcp.json` or settings, `npx -y`, `curl \| sh` | Denied, with a note to the model that a scan is pending |
| Mod loading | Any mod about to load, however it got there | Refused if its files do not match what you approved |
| First use of a skill | Skills and commands, including ones copied in by hand | Blocked until scanned |
| Session start | Anything installed while the guard was not running | Scanned, with Keep or Uninstall |

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

In the pane, **Approve** (`i`) and **Reject** (`r`) record your decision for that exact content (its tree hash). When the verdict is Do not install or Could not verify, the button reads **Approve anyway** and asks a second time. **Details** (`d`) opens every row, and **Copy report** (`c`) copies the full report as text. Where no pane can show (a headless `claude -p` run), `/guard scan` prints the report instead.

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
| `process.run` | Runs `git` to resolve a ref and fetch one commit into the guard's own temporary folder (made with `mktemp` and removed with `rm` afterwards), `claude plugin validate` on a candidate (it reads source and runs none of it), `readlink` to see where a symbolic link points without following it, and `printenv HOME` to expand `~`. It never runs anything from a candidate. |
| `fs.read`, `fs.list`, `fs.stat` | Reads the candidate's files to scan them. It writes no files itself; only `git` writes, into the guard's temporary folder. |
| `command.register` | Adds the `/guard` command. |
| `store`, `state` | Remembers your decisions and the last report, and holds what the pane shows. |
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

## Roadmap

1. [x] Skeleton mod: `/guard scan <path>` lists and hashes a local folder
2. [x] Checks for structure, mod capabilities, classic hooks, skills, code patterns and committed secrets
3. [x] The verdict pane with Install and Reject
4. [x] Remote fetch pinned to a commit, repository provenance, MCP server checks, and optional lookups against OSV and the official plugin list
5. [ ] Gates on `/plugin` and on Claude's own install commands, with approvals
6. [ ] Module load gate with hash match, skill gate, session-start reconciliation
7. [ ] Update diffs and the optional model review
8. [ ] Full documentation

## Contributing

Issues and pull requests are welcome. See [.claude/CLAUDE.md](./.claude/CLAUDE.md) for how the repo is laid out, how to run the checks, and how releases work.

## License

Apache 2.0 - see [LICENSE](./LICENSE). Free to use, modify, and redistribute.

<div align="center">

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

> **Status: early development.** Today `/guard scan <path>` runs the deterministic checks on a local folder and shows the verdict in a pane, where you approve or reject that exact version. Remote fetching and the install gates below are being built in stages; see [Roadmap](#roadmap).

Everything you add to Claude Code runs with your permissions. A plugin can ship shell hooks that run every session, an MCP server can download and launch a package, a mod can read files or auto-approve tools, and a skill can carry hidden instructions the model will follow. The install prompt asks you to trust the author, and an update can change the files after you looked.

AI Install Guard is a Claude Code mod that stops every new plugin, mod, skill, MCP server or marketplace, and every update to one, scans it without running any of its code, and installs nothing until you approve it.

## Who it is for

You, before you add something to Claude Code. It runs inside your own session, needs no account, server or agent, sends nothing anywhere, and is open source, so you can read every check it makes. Today you run `/guard scan` on a folder yourself before installing it; the gates that hold an install automatically come in later stages (see [Roadmap](#roadmap)).

Company security platforms such as AIR, Pluto and Neo watch a whole fleet of agents and enforce policy across it. The guard does not replace them: it is an open, local check for one developer's installs, and it works the same whether or not your company runs one.

## How it works

1. **Fetch without running.** The candidate is fetched at an exact commit into a folder the guard owns. Nothing is installed, built or run.
2. **Check every file.** Deterministic checks read the hooks, MCP servers, mod code, skills, scripts, images and manifest.
3. **Show a verdict.** A pane shows **Safe to install**, **Install with caution**, **Do not install** or **Could not verify**, a PASS / WARN / FAIL list with file and line evidence, and two buttons: **Install** and **Reject**.
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
| Code execution | Shell hooks, MCP servers that launch binaries or unpinned `npx` / `uvx` packages, mods that run processes |
| Data theft | Reads of `~/.ssh`, `~/.aws`, `.env`, keychains or secret env vars, combined with network calls |
| Prompt injection | Hidden instructions in skills, commands, agents and tool descriptions, including invisible Unicode |
| Permission escalation | Mods that auto-approve tools, writes to Claude settings or permissions, skills granting broad `Bash` |
| Persistence | Writes to shell rc files, crontab, launchd, systemd, git hooks |
| Supply chain | Marketplaces on a moving branch, brand-new repos, look-alike names, committed secrets, binaries, data hidden after the end of images |
| Sneaky updates | An update that adds capabilities, hooks, domains or servers without saying so |

## Commands

| Command | What it does |
|---------|--------------|
| `/guard scan <path>` | Scan a local folder without installing it and open the verdict pane |
| `/guard scan --details <path>` | The same, and print the full report with every finding and its advice |
| `/guard report` | Reopen the last report |
| `/guard list` | Your approved and rejected versions, newest first |
| `/guard forget <name>` | Forget decisions about a name, so it is judged again |

In the pane, **Approve** (`i`) and **Reject** (`r`) record your decision for that exact content (its tree hash). When the verdict is Do not install or Could not verify, the button reads **Approve anyway** and asks a second time. **Details** (`d`) opens every row, and **Copy report** (`c`) copies the full report as text. Where no pane can show (a headless `claude -p` run), `/guard scan` prints the report instead.

## What the guard itself can do

A security tool should be held to its own rules, so here is everything this mod uses, as `claude plugin validate .` lists it:

| Capability | Why |
|------------|-----|
| `process.run` | Runs `claude plugin validate` on a candidate (it reads source and runs none of it), `readlink` to see where a symbolic link points without following it, and `printenv HOME` to expand `~`. Later stages add `git` to fetch candidates into the guard's own temporary folder. It never runs anything from a candidate. |
| `fs.read`, `fs.list`, `fs.stat` | Reads the candidate's files to scan them. It never writes files. |
| `command.register` | Adds the `/guard` command. |
| `store`, `state` | Remembers your decisions and the last report, and holds what the pane shows. |
| `ui` | The verdict pane, its status line and toasts, and copying the report. |

Later stages add `http.fetch` (public repository metadata) and, optionally, `model.complete` (a review that can only add warnings).

## What it is not

- **Not a proof of safety.** Static analysis raises the bar and makes every capability visible; a determined attacker can still evade it.
- **Install it first.** It judges only mods that load after it. For a company, the strongest setup is deploying it through managed settings so it loads first.
- **No per-plugin block for classic shell hooks.** Claude Code runs them outside mods, so the guard scans before install and uninstalls on reject.

## Roadmap

1. [x] Skeleton mod: `/guard scan <path>` lists and hashes a local folder
2. [x] Checks for structure, mod capabilities, classic hooks, skills, code patterns and committed secrets
3. [x] The verdict pane with Install and Reject
4. [ ] Remote fetch pinned to a commit, provenance checks (with an optional reputation lookup against outside catalogs and vulnerability databases), MCP server checks
5. [ ] Gates on `/plugin` and on Claude's own install commands, with approvals
6. [ ] Module load gate with hash match, skill gate, session-start reconciliation
7. [ ] Update diffs and the optional model review
8. [ ] Full documentation

## Contributing

Issues and pull requests are welcome. See [.claude/CLAUDE.md](./.claude/CLAUDE.md) for how the repo is laid out, how to run the checks, and how releases work.

## License

Apache 2.0 - see [LICENSE](./LICENSE). Free to use, modify, and redistribute.

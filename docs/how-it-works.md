# How it works

## Why it exists

Checking what you install is usually a separate step. You read the repository, paste it into a scanning site, rely on the marketplace that listed it, or run a scanner yourself before each install. Each of those sits beside the install rather than in it, so it works only when you remember it, it checks the repository as it looks that day rather than the exact version that installs, and it never sees the installs Claude runs by itself.

AI Install Guard works the other way round. It is a mod, so it lives inside Claude Code and runs in every session on its own. When you run `/plugin install`, add a marketplace, or Claude runs `claude plugin install` itself, the guard stops the install, fetches the exact commit that would be installed, reads every file without running any of it, and holds the install until you press **Install** or **Reject**.

Everything you add to Claude Code runs with your permissions. A plugin can ship shell hooks that run every session, an MCP server can download and launch a package, a mod can read files or auto-approve tools, and a skill can carry hidden instructions the model will follow. The install prompt asks you to trust the author, and an update can change the files after you looked.

## Who it is for

Anyone who adds plugins to Claude Code and would rather not scan each one by hand. It runs inside your own session, needs no account, server or agent, and is open source, so you can read every check it makes. It reaches the network only to fetch the candidate from where it lives and to read that repository's public details; any outside lookup stays optional and off by default.

Company-wide security platforms watch a whole fleet of agents and enforce policy across it. The guard does not replace them: it is an open, local check for one developer's installs, and it works the same whether or not your company runs one.

## The four steps

1. **Fetch without running.** The candidate is fetched at an exact commit into a folder the guard owns. Nothing is installed, built or run.
2. **Check every file.** Deterministic checks read the hooks, MCP servers, mod code, skills, scripts, images and manifest.
3. **Show a verdict.** A pane shows **No red flags**, **Worth a look**, **Do not install** or **Could not verify** and a line on what the candidate can do, with **Install** and **Reject** right under it, then every check with file and line evidence.
4. **Install only what was scanned.** Install is pinned to the scanned commit and content hash. If the source changed since the scan, it is scanned again first.

Approvals are remembered by commit and content hash, so the same version is never scanned twice. Two things are on the [roadmap](roadmap.md): reviewing an update as a diff, so anything new since the version you approved is listed and flagged, and an optional model review, which can add warnings but never clear a failure, so a README that says "this plugin is safe" changes nothing.

## Red flags, and what it can do

The verdict answers one question: is anything suspicious? Most useful plugins need some power, so what a candidate can do is shown beside the verdict, the way a phone shows an app's permissions, and never counts against it:

```
AI Install Guard 0.4.0 · ai-install-guard
✔ No red flags
It can: intercept /plugin · see every Bash call and deny, rewrite or answer it · run programs on your machine · send requests over the network
0 red flags · 0 to look at · 22 passed
```

- **No red flags**: nothing suspicious. Read the "It can" line and decide whether that fits what you want it for.
- **Worth a look**: something specific deserves a closer look first, such as an MCP server that fetches whatever package version is newest each time it starts, a mod that runs programs without saying why in its README, or a key committed to the code. Install is still one press.
- **Do not install**: a red flag, such as hidden instructions, a key sent to a stranger, code downloaded and run, a write to your shell startup files or Claude settings, or a plugin that says it is a theme but runs programs. Installing it anyway asks twice.
- **Could not verify**: the guard could not tell what would be installed. Installing it anyway asks twice.

Quality notes (no license, a thin README, a brand-new repository) are listed on their rows and never change the verdict.

Text that writes about an attack is not read as one. A skill that warns about comments like "ignore previous instructions", a `.env` example that names `ANTHROPIC_API_KEY`, `npx tsc` in a setup step, a page downloaded into a one-line Python program that only reads it (`curl … | python3 -c "…json.load(sys.stdin)…"`, `python3 -m json.tool`), a script that prints, reads or runs a path in `~/.claude/skills` but never writes there, or a hook that sends its Anthropic key to Anthropic is listed as a note, not flagged. To keep this honest, CI scans Anthropic's own marketplace at a pinned commit on every change: 50 of its 53 plugins scan with no red flags, none as Do not install, and the build fails if a change flags more. To run the same count on any marketplace, run `npm run build:skill`, then `node scripts/benchmark.js <marketplace folder>`.

## What it checks

| Threat | What gets flagged |
|--------|-------------------|
| Code execution | Shell hooks, MCP servers that download code or launch unpinned `npx` / `uvx` packages or container images, mods that run processes |
| Data theft | Reads of `~/.ssh`, `~/.aws`, `.env`, keychains or secret env vars, combined with network calls; API keys an MCP server sends to a host that is not their own service |
| Prompt injection | Hidden instructions in skills, commands, agents and tool descriptions, including invisible Unicode |
| Permission escalation | Mods that auto-approve tools, writes to Claude settings or permissions, skills granting broad `Bash` |
| Persistence | Writes to shell rc files, crontab, launchd, systemd, git hooks, and where Claude Code loads plugins, skills and memory (`CLAUDE.md`) |
| Supply chain | Brand-new repositories and accounts, commits that are not on the default branch (they may come from a fork), packages known to be malware or vulnerable (an optional lookup), names one letter away from an official plugin's (an optional lookup), marketplace plugins not pinned to a commit, branches named like a commit id or `FETCH_HEAD` (the Plugin4Shell trick), submodules and Git LFS files whose code is fetched at install, remote MCP servers, committed secrets, binaries, data hidden after the end of images |
| Sneaky updates | An update that adds capabilities, hooks, domains or servers without saying so |

[Back to the documentation](README.md)

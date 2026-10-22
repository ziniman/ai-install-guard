# AI Install Guard for Claude chat

An Agent Skill that lets Claude scan a Claude Code plugin, mod, Agent Skill, MCP server or marketplace from an ordinary chat, before you install it. It runs the same deterministic checks as the [AI Install Guard](https://github.com/ziniman/ai-install-guard) mod for Claude Code, reads the files without running any of them, and answers **Safe to install**, **Install with caution**, **Do not install** or **Could not verify**, with file and line evidence.

## Use it

1. Upload `ai-install-guard-skill.zip` in Claude: Settings > Capabilities > Skills. Code execution must be on.
2. In a chat, attach a zip of what you want to check (a `.zip`, `.skill` or `.plugin` file), or paste a repository link, and ask whether it is safe to install.

## What it runs

`scripts/scan.js` needs Node.js 18 or later. It is built, unminified so you can read it, from the guard's `cli/scan.ts` and its scanner. It starts no program but `git`, `sh`, `mktemp` and `rm` (PowerShell on Windows), and those only to fetch one commit of a repository into a temporary folder of its own. A zip is unpacked by the script itself into a temporary folder, and that folder is removed afterwards.

Over the network, a repository scan reaches the repository's host (`github.com` for GitHub) and, for a GitHub repository, `api.github.com` for its public details. With `--lookups`, it also sends package names to `api.osv.dev` and reads Anthropic's official plugin list from `raw.githubusercontent.com`. A chat's code execution reaches only the domains its network settings allow; without them, attach a zip instead.

The guard's own scan of this skill says **Install with caution**, because the script starts programs: that is the `git` fetch above.

## What it is not

A proof of safety. Static checks raise the bar and make every capability visible; a determined attacker can still evade them. In a chat, nothing is installed: to hold every install for a scan, add the mod to Claude Code with `/plugin install ai-install-guard --marketplace ziniman/ai-install-guard`.

Licensed under Apache 2.0; see `LICENSE`.

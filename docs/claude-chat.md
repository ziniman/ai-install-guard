# Use it in Claude chat

A chat cannot hold an install, but it can run the same scan before you install something elsewhere. The scanner also builds into an Agent Skill for Claude:

```bash
npm ci --ignore-scripts
npm run build:skill
```

This writes `dist/ai-install-guard-skill.zip`. Upload it in Claude under **Settings > Capabilities > Skills** (code execution must be on). Then, in any chat, attach a zip of a plugin, skill or MCP server, or paste a repository link, and ask:

> Is this plugin safe to install?

Claude runs the skill's `scripts/scan.js`: the same deterministic checks as `/guard scan`, without `claude plugin validate`, which a chat does not have. A zip is unpacked by the script itself into a temporary folder of its own, refusing any path that would land outside it, and a repository is fetched at one commit exactly as `/guard scan` fetches it. Claude answers with the verdict, each finding in plain words and the evidence behind it. The skill tells Claude that the scanned files are untrusted data, never instructions, and that a failure is never softened.

To fetch a repository, the chat's code execution must be allowed to reach `github.com` (and `api.github.com` for the repository's details) in its network settings. Where it is not, Claude says so and asks for a zip instead (on GitHub: **Code > Download ZIP**).

The same script runs anywhere with Node.js 18 or later: `node skill/ai-install-guard/scripts/scan.js --details <folder | zip | repository>`, with `--ref`, `--path`, `--json`, `--badge` and `--lookups`. Its exit status is the verdict: 0 No red flags, 1 Worth a look, 2 Do not install, 3 Could not verify.

[Back to the documentation](README.md)

<div align="center">

<img src="assets/reviewed-by-ai-install-guard-light@1x.png" alt="Reviewed by AI Install Guard" width="406" height="104">

# AI Install Guard

**A Claude Code mod that runs in the background. Install it once, and every `/plugin install`, marketplace and MCP server, yours or Claude's, and every skill or settings change Claude makes, is checked before it lands: nothing to run, nothing to remember.**

[![AI Install Guard: No red flags at c1e6843f99bd](https://img.shields.io/badge/AI_Install_Guard-no_red_flags_%C2%B7_c1e6843f99bd-2ea44f)](https://github.com/ziniman/ai-install-guard#review-badge "Scanned content sha256:c1e6843f99bddf6ae7ccfd713212db7273b6aeafe4ec2431ede7fb973d3b56f2, read without this badge")

[![npm version](https://img.shields.io/npm/v/ai-install-guard?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/ai-install-guard)
[![npm downloads](https://img.shields.io/npm/dm/ai-install-guard?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/ai-install-guard)
[![GitHub stars](https://img.shields.io/github/stars/ziniman/ai-install-guard?style=for-the-badge&logo=github&logoColor=white&color=181717)](https://github.com/ziniman/ai-install-guard/stargazers)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue?style=for-the-badge)](https://github.com/ziniman/ai-install-guard/blob/main/LICENSE)
[![last commit](https://img.shields.io/github/last-commit/ziniman/ai-install-guard?style=for-the-badge&logo=github&logoColor=white&color=181717)](https://github.com/ziniman/ai-install-guard/commits/main)

```
/plugin install ai-install-guard --marketplace ziniman/ai-install-guard
```

</div>

## What it does

Everything you add to Claude Code runs with your permissions: a plugin's hooks run every session, an MCP server can download and launch a package, a skill can carry hidden instructions. Checking it is usually a separate step you have to remember, and it never sees what Claude installs by itself.

AI Install Guard lives inside Claude Code instead. When something new is about to be added, it fetches the exact version, reads every file without running any of it, and holds it until you press **Install** or **Reject**.

- **Automatic.** No command to run first: from the moment it is installed, it is in the way of every install.
- **It catches Claude too.** What Claude adds on its own is checked like what you type, and waits for you unless it is something Claude wrote itself with no red flags.
- **Pinned.** A verdict belongs to one commit and content hash, and only that version installs.
- **Local and open.** No account or server, and every check is in this repository.

It holds `/plugin install` and `/plugin marketplace add`, and, when Claude does them: plugin installs, MCP servers it adds, skills, commands and agents it writes with a red flag, settings changes that widen what it may run, and the same changes made with a shell command. A mod that loads with files you never approved (picked from the `/plugin` menu, updated on its own, changed in place) is kept off until you approve it, a skill that came with no install (from a repository you cloned, copied in by hand) is checked as it is first used, and a plugin that is on but new or changed since the guard last looked (updated on its own, installed from a terminal) is checked as a session starts, as are the MCP servers and hooks in your configuration (brought by a `git pull`, written by another program's installer). A plugin picked from the menu is not scanned before it installs, so type `/plugin install <name>@<marketplace>` instead. [Where it steps in](docs/gates.md) has every case.

## Using it

Install plugins as you always do. The guard answers with a verdict in its pane:

- **No red flags**: nothing suspicious. The "It can" line says what it would be able to do, so you can judge whether that fits.
- **Worth a look**: something specific deserves a look first.
- **Do not install**: a red flag. Installing it anyway asks twice.
- **Could not verify**: the guard could not tell what would be installed. Installing it anyway asks twice.

Press **Install** (`i`) or **Reject** (`r`). When it holds a command Claude ran, approve it in the pane, then tell Claude to run it again.

To check something before you install it anywhere:

| Command | What it does |
|---------|--------------|
| `/guard scan <folder or repository>` | Scan it without installing it |
| `/guard report` | Reopen the last report |
| `/guard list` | Your approved and rejected versions |
| `/guard held` | The mods kept from loading, and the plugins and configuration that wait for your decision |
| `/guard forget <name>` | Forget a decision, so it is judged again |

The same scanner also runs in Claude chat, as a skill: [Use it in Claude chat](docs/claude-chat.md). For everything else, see [How it works](docs/how-it-works.md), [Commands and the pane](docs/commands.md) and the rest of [the documentation](docs/README.md).

## Review badge

If you publish a plugin, scan your repository and run `/guard badge` for a badge that names the verdict and the exact content scanned. A badge is a picture anyone can paste, so the guard never trusts one: to know, scan the repository yourself. See [Review badge](docs/badge.md).

## What the guard itself can do

A security tool should be held to its own rules. Everything this mod uses, as `claude plugin validate .` lists it:

| Capability | Why |
|------------|-----|
| `process.run` | Runs `git` to fetch the exact commit being scanned into its own temporary folder, the `claude` command to validate a candidate, to find where a plugin comes from and to list the plugins that are on, `readlink` to see where a link points, and `printenv` to find your home folder. It never runs anything from a candidate. |
| `fs.read`, `fs.list`, `fs.stat` | Reads the files it scans, and where a file Claude is about to write would really land. It writes no files itself. |
| `command.run` | Intercepts `/plugin` to hold an install, and runs your own `/plugin` command again once you approve it, or `/plugin disable` when you turn off a plugin it found on. Sees every other slash command too, to check a skill or command by that name before it runs, and answers only one it holds. |
| `tool.call` | Reads each shell command and file write Claude is about to make, and refuses only those that add something where Claude Code loads from, until you approve. Checks each skill Claude is about to run the same way. |
| `classic.CwdChanged` | Notes the folder Claude's shell commands run in, so a relative path is read where it lands. |
| `plugin.register` | Checks each mod Claude Code is about to load, and keeps out one whose files are not a version you approved. |
| `skill.prompt` | Checks a skill that came with no install (yours, a repository's) again as its instructions load, for one found where the slash command and the Skill tool did not look, and holds one with a red flag until you approve it. |
| `http.fetch` | Reads a GitHub repository's public details (age, stars, whether the commit is signed) and, only if you turn them on, the [outside lookups](docs/permissions.md#outside-lookups). |
| `store`, `state`, `ui`, `command.register` | Remembers your decisions, draws the pane, and adds the `/guard` command. |

Every detail is in [What the guard itself can do](docs/permissions.md), and what it cannot promise is in [What it is not](docs/limitations.md).

## Uninstall

```
/plugin uninstall ai-install-guard@ai-install-guard
```

To turn it off for a while, use `/plugin disable ai-install-guard@ai-install-guard`. The guard fails closed, so a bug could hold something that should have gone through. If it ever gets in your way, turn it off from a terminal outside Claude Code, where it sees nothing, and [open an issue](https://github.com/ziniman/ai-install-guard/issues):

```bash
claude plugin disable ai-install-guard@ai-install-guard
```

More, including your stored decisions and installs for one project only: [Uninstall and troubleshooting](docs/uninstall.md).

## Status

Early development. The gates above work today; next, an update shows what changed since the version you approved, and an optional model review can add warnings. See the [roadmap](docs/roadmap.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache 2.0, see [LICENSE](LICENSE).

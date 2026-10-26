# AI Install Guard documentation

The [README](../README.md) covers what the guard does, how to install it, the short version of using it, and how to remove it. These pages hold the rest.

| Page | What is in it |
|------|---------------|
| [How it works](how-it-works.md) | Why it exists, the four steps from fetch to install, what each verdict means, and the threats it checks for |
| [Where it steps in](gates.md) | Every place the guard holds something: `/plugin`, Claude's own `claude plugin` and `claude mcp add` commands, Claude's writes, settings changes and shell commands |
| [Commands and the pane](commands.md) | Every `/guard` command, how a remote scan is fetched, and the pane's buttons |
| [Use it in Claude chat](claude-chat.md) | The same scanner as an Agent Skill for Claude chat, and as a command-line script |
| [Review badge](badge.md) | Showing that your own plugin was scanned, and why the guard never trusts a badge |
| [What the guard itself can do](permissions.md) | Every capability the mod uses and why, and the optional outside lookups |
| [Uninstall and troubleshooting](uninstall.md) | Removing it, turning it off, what to do if it gets in your way, and your stored decisions |
| [What it is not](limitations.md) | What static scanning cannot promise, and the gaps that later stages close |
| [Roadmap](roadmap.md) | What is done and what comes next |

To work on the guard itself, see [CONTRIBUTING.md](../CONTRIBUTING.md).

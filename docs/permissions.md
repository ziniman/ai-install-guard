# What the guard itself can do

A security tool should be held to its own rules, so here is everything this mod uses, as `claude plugin validate .` lists it.

Installing it runs nothing either. The plugin installs from a `release` branch that holds only the files the mod runs with: its manifest, its hooks, its types, and the README with the pages it links to, the CHANGELOG and the LICENSE. There is no `package.json`, so Claude Code installs no packages and runs no install script, and none of the repository's tests, sample plugins or scripts are copied to your machine.

| Capability | Why |
|------------|-----|
| `process.run` | Runs `git` to resolve a ref and fetch one commit into the guard's own temporary folder (made with `mktemp` and removed with `rm` afterwards), `claude plugin validate` on a candidate (it reads source and runs none of it), `claude plugin list --available --json` and `claude plugin marketplace list --json` to find where a plugin you install comes from, `readlink` to see where a symbolic link points without following it, `printenv HOME` to expand `~`, and `printenv CLAUDE_CONFIG_DIR` to know where Claude's own folder is when that variable moves it. It never runs anything from a candidate. |
| `fs.read`, `fs.list`, `fs.stat` | Reads the candidate's files to scan them, and a marketplace's catalog in Claude Code's own copy of it. For a write Claude is about to make where Claude Code loads from, reads where the path really lands and, for a copy or an append, the file it copies or adds to. It writes no files itself; only `git` writes, into the guard's temporary folder. |
| `command.run` (hook) | Intercepts `/plugin`, so `/plugin install` and `/plugin marketplace add` are scanned and held until you approve them. Every other `/plugin` command goes on untouched. |
| `command.run` (call) | When you press Install, runs your own `/plugin` command again, after checking the version is still the one you approved. |
| `tool.call` (hook) | Reads the text of each shell command Claude is about to run, to catch `claude plugin install`, `claude mcp add` and their kin, and the files the command writes, and refuses those that change where Claude Code loads from until you approve. Reads the path of each file Claude is about to write or edit, and, only for one in a skill, command, agent, plugin or MCP configuration, the content it would write. Every other command and every other tool goes on untouched; it never rewrites or answers one. |
| `classic.CwdChanged` (hook) | Notes the folder Claude's shell commands run in when it changes, so a relative path in a later command is read where it lands. It changes nothing. |
| `plugin.register` (hook) | As Claude Code is about to load a mod you installed, reads and hashes its folder, and keeps the mod from loading unless those exact files are a version you approved. It reads only that folder; an administrator's managed plugins and the ones bundled with Claude Code go on untouched. |
| `skill.prompt` (hook) | As Claude Code loads a skill's or command's instructions for the model, reads and scans that skill's folder or command's file when it came with no install (yours, a repository's, one synced from your account), and in place of the instructions tells Claude it was held when it has a red flag you have not approved. A plugin's skills, Claude Code's own and an administrator's go on untouched, with nothing read. |
| `command.register` | Adds the `/guard` command. |
| `store`, `state` | Remembers your decisions and the last report, which skills it has already named as checked, holds what the pane shows, and keeps a one-time pass for an install you allowed anyway. |
| `ui` | The verdict pane, its status line and toasts, and copying the report. |
| `http.fetch` | For a repository on GitHub, reads its public metadata from GitHub's API: age, owner, stars, contributors, and whether the scanned commit is signed and on the default branch. For `/plugin install <name> --marketplace <owner>/<repo>`, reads that marketplace's catalog from GitHub at the commit that would be added, to find where the plugin is. GitHub is where the code came from, so this tells it nothing new. With **outside lookups** on, also sends package names to [OSV](https://osv.dev) and reads Anthropic's [official plugin list](https://github.com/anthropics/claude-plugins-official). |

A later stage adds, optionally, `model.complete` (a review that can only add warnings).

## Outside lookups

Off by default, because they send names to other services. Turned on, the guard checks:

- **Packages:** every package an MCP server starts or the candidate's `package.json` or `requirements.txt` pins, against OSV. A package OSV lists as malware is a failure; a pinned version with known vulnerabilities is a warning.
- **Names:** its name against Anthropic's official plugins. A name one letter away from an official one is a warning; the same name is noted, so you can check it is that plugin.

Turn them on in `/config` (the AI Install Guard row), or with:

```bash
claude plugin configure ai-install-guard
```

A lookup that fails or hits a rate limit is noted in the report and never fails the scan.

[Back to the documentation](README.md)

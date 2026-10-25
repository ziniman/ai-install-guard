<div align="center">

<img src="assets/reviewed-by-ai-install-guard-light@1x.png" alt="Reviewed by AI Install Guard" width="406" height="104">

# AI Install Guard

**A Claude Code mod that runs in the background. Install it once, and every `/plugin install` and marketplace you add, yours or Claude's, is scanned before anything installs: nothing to run, nothing to remember.**

[![AI Install Guard: No red flags at 6b4108a486c5](https://img.shields.io/badge/AI_Install_Guard-no_red_flags_%C2%B7_6b4108a486c5-2ea44f)](https://github.com/ziniman/ai-install-guard#review-badge "Scanned content sha256:6b4108a486c555746b7b9ff79f9edc65d1d03e8a55d30038d229464df238ca9a, read without this badge")

[![npm version](https://img.shields.io/npm/v/ai-install-guard?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/ai-install-guard)
[![npm downloads](https://img.shields.io/npm/dm/ai-install-guard?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/ai-install-guard)
[![GitHub stars](https://img.shields.io/github/stars/ziniman/ai-install-guard?style=for-the-badge&logo=github&logoColor=white&color=181717)](https://github.com/ziniman/ai-install-guard/stargazers)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue?style=for-the-badge)](https://github.com/ziniman/ai-install-guard/blob/main/LICENSE)
[![last commit](https://img.shields.io/github/last-commit/ziniman/ai-install-guard?style=for-the-badge&logo=github&logoColor=white&color=181717)](https://github.com/ziniman/ai-install-guard/commits/main)

```
/plugin install ai-install-guard --marketplace ziniman/ai-install-guard
```

To turn it off or remove it, see [Uninstall](#uninstall).

</div>

Checking what you install is usually a separate step. You read the repository, paste it into a scanning site, rely on the marketplace that listed it, or run a scanner yourself before each install. Each of those sits beside the install rather than in it, so it works only when you remember it, it checks the repository as it looks that day rather than the exact version that installs, and it never sees the installs Claude runs by itself.

AI Install Guard works the other way round. It is a mod, so it lives inside Claude Code and runs in every session on its own. When you run `/plugin install`, add a marketplace, or Claude runs `claude plugin install` itself, the guard stops the install, fetches the exact commit that would be installed, reads every file without running any of it, and holds the install until you press **Install** or **Reject**.

- **Automatic.** From the moment it is installed it is in the install path. There is no command to run first. (A plugin picked from the `/plugin` menu is not held yet; type `/plugin install` instead. See [Where it steps in](#where-it-steps-in).)
- **It catches Claude too.** Installs Claude starts by itself, and MCP servers it adds with `claude mcp add`, wait for your decision, the same as the ones you type.
- **Pinned.** The verdict belongs to one commit and content hash, and only that version installs.
- **Local and open.** It runs in your own session with no account or server, and every check is in this repository.

Everything you add to Claude Code runs with your permissions. A plugin can ship shell hooks that run every session, an MCP server can download and launch a package, a mod can read files or auto-approve tools, and a skill can carry hidden instructions the model will follow. The install prompt asks you to trust the author, and an update can change the files after you looked.

> **Status: early development.** `/plugin install` and `/plugin marketplace add`, the same installs when Claude runs `claude plugin` itself, MCP servers Claude adds with `claude mcp add` or writes into a configuration, skills, commands and agents Claude writes with a red flag, and settings changes that widen what Claude may do, are held until you approve the exact version the guard scanned. `/guard scan` checks a folder or a repository before you install it anywhere. The other gates are being built in stages; see [Where it steps in](#where-it-steps-in) and [Roadmap](#roadmap).

## Who it is for

Anyone who adds plugins to Claude Code and would rather not scan each one by hand. It runs inside your own session, needs no account, server or agent, and is open source, so you can read every check it makes. It reaches the network only to fetch the candidate from where it lives and to read that repository's public details; any outside lookup stays optional and off by default.

Company-wide security platforms watch a whole fleet of agents and enforce policy across it. The guard does not replace them: it is an open, local check for one developer's installs, and it works the same whether or not your company runs one.

## How it works

1. **Fetch without running.** The candidate is fetched at an exact commit into a folder the guard owns. Nothing is installed, built or run.
2. **Check every file.** Deterministic checks read the hooks, MCP servers, mod code, skills, scripts, images and manifest.
3. **Show a verdict.** A pane shows **No red flags**, **Worth a look**, **Do not install** or **Could not verify** and a line on what the candidate can do, with **Install** and **Reject** right under it, then every check with file and line evidence.
4. **Install only what was scanned.** Install is pinned to the scanned commit and content hash. If the source changed since the scan, it is scanned again first.

Approvals are remembered by commit and content hash, so the same version is never scanned twice, and an update is reviewed as a diff: anything new since the version you approved is listed and flagged. An optional model review can add warnings but can never clear a failure, so a README that says "this plugin is safe" changes nothing.

## Where it steps in

| Layer | Catches | What happens | Today |
|-------|---------|--------------|-------|
| Slash command | `/plugin install <name>@<marketplace>`, `/plugin install <name> --marketplace <source>`, `/plugin marketplace add <source>` | Held until you press Install | Yes |
| Claude's own commands | `claude plugin install`, `claude plugin update`, `claude plugin marketplace add`, also inside `sh -c`, `eval` or a here-document | Refused, with a note telling Claude the install waits for your decision | Yes |
| Claude's own commands | `claude mcp add` and `claude mcp add-json` (`add-from-claude-desktop` is held as Could not verify) | Refused until you approve that exact server configuration | Yes |
| Claude's own writes | Files Claude writes or edits in skill, command and agent folders, MCP servers in `.mcp.json` or `~/.claude.json`, any file of an installed plugin | Checked as they would land: a skill, command or agent with no red flags goes on with a note, anything else is refused until you approve | Yes |
| Claude's own settings | Claude writing or editing `settings.json` or `settings.local.json` (the project's, yours, an organization's) | A change that widens what Claude may do or run is refused until you approve it; one that only narrows it goes on | Yes |
| Claude's own copies | Files copied, cloned or downloaded into those folders with the shell | Refused until scanned | Next stage |
| Mod loading | Any mod about to load, however it got there, including plugins picked from the `/plugin` menu | Refused if its files do not match what you approved | Later |
| First use of a skill | Skills and commands, including ones copied in by hand | Blocked until scanned | Later |
| Session start | Anything installed while the guard was not running | Scanned, with Keep or Uninstall | Later |

### Installing with the guard on

Run `/plugin install notes@acme` as usual. The guard looks up where Claude Code would install it from (the repository, folder and commit its marketplace names), scans that commit, and answers in the command's place, so nothing is installed yet. The pane shows the verdict and the command it is holding. When it could not verify the install, the command's answer says why too.

To install from a marketplace you have not added yet, `/plugin install rtl-toggle --marketplace owner/repo` works the same way: for a marketplace on GitHub, the guard reads its catalog at the commit Claude Code would add and scans the folder or repository that catalog names for the plugin. A marketplace hosted elsewhere is Could not verify until you add it with `/plugin marketplace add`, which the guard scans.

- **Install** (`i`) records your approval for that exact commit and tree hash, looks the plugin up once more, and runs your `/plugin` command again. If the commit moved since the scan, nothing is installed and the next `/plugin install` scans the new one.
- **Reject** (`r`) records the rejection. The same version is refused from then on; `/guard forget notes@acme` judges it again.
- A version you already approved (the same commit of the same folder, here or with `/guard scan`) is scanned again and installs without asking, unless it now judges worse than when you approved it (an outside lookup turned on since may know it as malware). A version you rejected is refused at once. A new commit is always scanned.
- When the verdict is **Do not install**, the button reads **Install anyway** and asks a second time. **Could not verify** (the guard could not tell what would be installed: a package from npm, a plugin no marketplace lists, a name two marketplaces share) works the same way, and lets that one command through once.

When Claude runs `claude plugin install` itself, the guard refuses the command and tells Claude why: the install waits for your decision, and Claude should not retry it or find another way. Approve it in the pane, then tell Claude to run it again; the same command now goes through. Because approving it approves that whole command, the install must stand on its own (a `tail` after it is fine): a command that also runs something else, changes folder or writes a file, or that is only known as it runs (`$CMD plugin install …`, `bash -c "$CMD"`, a script piped into a shell, code for another language that mentions `claude`), is held as Could not verify. A marketplace Claude adds must be named by its full path or as `https://github.com/<owner>/<repo>`, since the guard cannot see the shell's current folder.

### Adding an MCP server

When Claude runs `claude mcp add` or `claude mcp add-json`, the guard reads the server it would add, its command and arguments or its address, with any environment variables and headers, and checks that configuration as it checks the MCP servers a plugin ships: a package started at whatever version is newest, a command that downloads code and runs it, a key sent to a host that is not its own service, the address Claude would connect to. The command is refused with the verdict until you approve, and the approval covers that exact configuration; the same name with another command is checked again. The server's own code is not read yet, only how Claude Code starts it or where it connects; with outside lookups on, a package it starts is checked against OSV.

The server's arguments go after `--` (`claude mcp add notes -- npx -y @acme/notes-mcp`), as Claude Code's documentation writes them: an option after the command without `--` could belong to either, so it is held. What would differ from what was scanned is held too: a name, command, argument, address or scope the shell or Claude Code fills in as it runs (`$HOST`, `${CMD}`), a configuration key the checks do not read, and a value filled in that is not a secret's. Passing a secret that way is fine, quoted so the shell keeps it one value (`-e GITHUB_TOKEN="$GITHUB_TOKEN"`, `-H "Authorization: Bearer $PAT"`, or `${PAT}` in a configuration). An unquoted `~`, `{a..b}` or `$X` is expanded by the shell, so it is held too. `claude mcp add` you type in your own terminal is not held; only Claude's. `/guard forget <server name>` clears what you decided about a server.

### Claude writing skills, MCP servers and plugin files

When Claude writes or edits a file with its Write or Edit tool, the guard looks at the path first: any file outside the places Claude Code loads from goes on at once, with nothing read. A file in a `skills`, `commands` or `agents` folder (in the project's `.claude` or in `~/.claude`) is scanned as it would be once written: a skill as its whole folder with the new file in it, a command or agent as that file. When the scan finds nothing, the change goes on with a note; anything worth a look or worse is refused until you approve it in the pane, and the approval covers that exact content.

An MCP server added or changed in `.mcp.json` or `~/.claude.json` is checked like one added with `claude mcp add`, and always waits for you. A change to the files of a plugin Claude Code installed (`~/.claude/plugins`) is held as Could not verify: it would change what runs outside any install. Output styles count as prompts too. Where a path lands is found as the system finds it, links followed before a `..` after them, and without regard to case, as a disk that ignores case reads it. What the guard cannot read for certain in those places is held rather than passed: a relative path, a write through a link, a file it cannot read, an edit it cannot replay exactly (write the whole file instead). Two changes to one skill at once are taken one at a time.

### Claude changing settings

Settings decide what Claude runs without asking, what runs on its own and where its traffic goes, so a change to `settings.json` or `settings.local.json` that widens any of that waits for you, judged by what it widens:

- **Red flags:** an allow rule that lets Claude run any shell command (`Bash(*)`, `Bash(npm:*)`, an interpreter with `-c`), the `bypassPermissions` mode, a hook or helper command that reaches out or runs downloaded code, an `ANTHROPIC_BASE_URL` or proxy that sends Claude's traffic to another host, a variable that changes what code runs (`NODE_OPTIONS`), and approving every project MCP server.
- **Worth a look:** any other allow rule (`Bash(npm test:*)`), a hook or helper command, a removed deny or ask rule, an extra working folder, a plugin or marketplace turned on outside `/plugin install`, and a setting the guard does not know.
- **Goes on:** a rule that only blocks or asks, a stricter mode, and settings that run nothing (theme, model).

The approval covers that exact file.

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

Text that writes about an attack is not read as one. A skill that warns about comments like "ignore previous instructions", a `.env` example that names `ANTHROPIC_API_KEY`, `npx tsc` in a setup step, or a hook that sends its Anthropic key to Anthropic is listed as a note, not flagged. To keep this honest, CI scans Anthropic's own marketplace at a pinned commit on every change: 50 of its 53 plugins scan with no red flags, none as Do not install, and the build fails if a change flags more. To run the same count on any marketplace, run `npm run build:skill`, then `node scripts/benchmark.js <marketplace folder>`.

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
| `/guard badge` | A README badge for the last scan, when it was No red flags or Worth a look (see [Review badge](#review-badge)) |
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

The same script runs anywhere with Node.js 18 or later: `node skill/ai-install-guard/scripts/scan.js --details <folder | zip | repository>`, with `--ref`, `--path`, `--json`, `--badge` and `--lookups`. Its exit status is the verdict: 0 No red flags, 1 Worth a look, 2 Do not install, 3 Could not verify.

## Review badge

If you publish a plugin, mod, skill or MCP server, you can show that it was scanned. Scan your own repository, then run `/guard badge` or press **Copy badge** (`b`) in the pane (outside Claude Code, add `--badge` to the [command-line scanner](#use-it-in-claude-chat)), and paste the result near the top of your README:

```markdown
[![AI Install Guard: No red flags at 56a8fc7e979d](https://img.shields.io/badge/AI_Install_Guard-no_red_flags_%C2%B7_56a8fc7e979d-2ea44f)](https://github.com/ziniman/ai-install-guard#review-badge "Scanned content sha256:56a8fc7e…, read without this badge")
```

The badge says two things: the verdict (green for **No red flags**, yellow for **Worth a look**) and the content that was scanned, a hash of every file with the README read without its AI Install Guard badge. That is why it names content and not a commit: committing the badge makes a new commit, so a badge naming a commit could never be right for the commit that holds it. Pasting the badge, moving it or replacing an older one leaves the hash as it was, so the badge is right in the commit that adds it, and any other change makes it a badge for an earlier version. Hovering over it shows the full hash. There is no badge for **Do not install** or **Could not verify**. Badges made before 0.4.4 name a commit or a tree hash, and badges made before 0.4.0 say Safe to install or Review what it can do; they still count as what they name.

A badge is a picture anyone can paste, so the guard never trusts one:

- **When you see one:** scan the repository yourself with `/guard scan owner/repo`, adding `--path <folder>` when the badge names a folder. The report says whether the badge is for the version you scanned. Your own scan is what counts.
- **When the guard meets one:** a README badge that claims a better verdict than the guard's own scan is a warning, saying the badge is outdated or, when it names this very version, was never earned. A badge that matches is only noted. It never lifts a verdict.
- **When the code changes:** the badge still names the old content. A new version needs a new scan and a new badge. To keep yours current, make the badge the last step of each change; this repository does it in every pull request with [`scripts/badge.js`](scripts/badge.js), and its CI fails when the badge is not for the pull request's own files.

## What the guard itself can do

A security tool should be held to its own rules, so here is everything this mod uses, as `claude plugin validate .` lists it:

| Capability | Why |
|------------|-----|
| `process.run` | Runs `git` to resolve a ref and fetch one commit into the guard's own temporary folder (made with `mktemp` and removed with `rm` afterwards), `claude plugin validate` on a candidate (it reads source and runs none of it), `claude plugin list --available --json` and `claude plugin marketplace list --json` to find where a plugin you install comes from, `readlink` to see where a symbolic link points without following it, and `printenv HOME` to expand `~`. It never runs anything from a candidate. |
| `fs.read`, `fs.list`, `fs.stat` | Reads the candidate's files to scan them, and a marketplace's catalog in Claude Code's own copy of it. It writes no files itself; only `git` writes, into the guard's temporary folder. |
| `command.run` (hook) | Intercepts `/plugin`, so `/plugin install` and `/plugin marketplace add` are scanned and held until you approve them. Every other `/plugin` command goes on untouched. |
| `command.run` (call) | When you press Install, runs your own `/plugin` command again, after checking the version is still the one you approved. |
| `tool.call` (hook) | Reads the text of each shell command Claude is about to run, to catch `claude plugin install`, `claude mcp add` and their kin, and refuses those until you approve. Reads the path of each file Claude is about to write or edit, and, only for one in a skill, command, agent, plugin or MCP configuration, the content it would write. Every other command and every other tool goes on untouched; it never rewrites or answers one. |
| `command.register` | Adds the `/guard` command. |
| `store`, `state` | Remembers your decisions and the last report, holds what the pane shows, and keeps a one-time pass for an install you allowed anyway. |
| `ui` | The verdict pane, its status line and toasts, and copying the report. |
| `http.fetch` | For a repository on GitHub, reads its public metadata from GitHub's API: age, owner, stars, contributors, and whether the scanned commit is signed and on the default branch. For `/plugin install <name> --marketplace <owner>/<repo>`, reads that marketplace's catalog from GitHub at the commit that would be added, to find where the plugin is. GitHub is where the code came from, so this tells it nothing new. With **outside lookups** on, also sends package names to [OSV](https://osv.dev) and reads Anthropic's [official plugin list](https://github.com/anthropics/claude-plugins-official). |

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

## Uninstall

The guard holds installs, never removals: uninstalling or disabling it, or any other plugin, goes straight through when the command says so plainly. One whose action is only known as it runs, such as `claude plugin "$ACTION" …`, is held, since it could as well be an install.

**Remove it** in Claude Code:

```
/plugin uninstall ai-install-guard@ai-install-guard
```

or from a terminal:

```bash
claude plugin uninstall ai-install-guard@ai-install-guard
```

If you installed it for one project only (`--scope project` or `--scope local`), add the same `--scope`. To remove its marketplace as well, run `/plugin marketplace remove ai-install-guard`. A session that is already open may keep the guard loaded until you restart it.

**Turn it off for a while** with `/plugin disable ai-install-guard@ai-install-guard`, and back on with `/plugin enable ai-install-guard@ai-install-guard`.

**If it ever gets in your way.** The guard fails closed: when it cannot check something, it stops it. So a bug in the guard could hold an install, or a shell command it mistakes for one, that should have gone through. You can always turn it off from a terminal outside Claude Code, where the guard sees nothing:

```bash
claude plugin disable ai-install-guard@ai-install-guard
```

If even that fails, set `"ai-install-guard@ai-install-guard": false` under `enabledPlugins` in `~/.claude/settings.json` (or in the project's `.claude/settings.json` if you installed it there). Then [open an issue](https://github.com/ziniman/ai-install-guard/issues) with the command it stopped, so it can be fixed.

**Your decisions.** Approvals and rejections are kept in the store Claude Code gives the plugin, which can outlast an uninstall, so a later reinstall may find them again. To start clean, run `/guard list` before you uninstall and `/guard forget <name>` for each one. The guard writes no files of its own: its only folder is the temporary one it fetches into, removed after each scan.

**If your organization installed it** through managed settings, it is theirs to remove; ask whoever manages your Claude Code settings.

**In Claude chat,** remove the skill under **Settings > Capabilities > Skills**.

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
6. [x] Gate on Claude adding MCP servers with `claude mcp add`
7. [x] Gate on Claude writing skills, commands, agents, MCP configuration and installed plugins' files
8. [x] Gate on Claude changing settings
9. [ ] Gate on Claude's shell copies into skill, plugin and configuration folders
10. [ ] Module load gate with hash match, skill gate, session-start reconciliation
11. [ ] Update diffs and the optional model review
12. [ ] Full documentation

## Contributing

Issues and pull requests are welcome. See [.claude/CLAUDE.md](./.claude/CLAUDE.md) for how the repo is laid out, how to run the checks, and how releases work.

## License

Apache 2.0 - see [LICENSE](./LICENSE). Free to use, modify, and redistribute.

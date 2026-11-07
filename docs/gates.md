# Where it steps in

The guard holds what is about to be added to Claude Code, whether you add it or Claude does. This page lists each place it steps in and what happens there.

| Layer | Catches | What happens | Today |
|-------|---------|--------------|-------|
| Slash command | `/plugin install <name>@<marketplace>`, `/plugin install <name> --marketplace <source>`, `/plugin marketplace add <source>` | Held until you press Install | Yes |
| Claude's own commands | `claude plugin install`, `claude plugin update`, `claude plugin marketplace add`, also inside `sh -c`, `eval` or a here-document | Refused, with a note telling Claude the install waits for your decision | Yes |
| Claude's own commands | `claude mcp add` and `claude mcp add-json` (`add-from-claude-desktop` is held as Could not verify) | Refused until you approve that exact server configuration | Yes |
| Claude's own writes | An MCP server Claude writes or edits into this folder's `.mcp.json` or your `~/.claude.json` | Refused until you approve that exact configuration, as with `claude mcp add`; any other file goes on at once, with nothing read | Yes |
| Mod loading | Any mod that loads after the guard, however it got there: the `/plugin` menu, an update, files changed in place | Kept from loading until its files are a version you approved, and shown in the pane | Yes |
| First use of a skill | Skills and commands that came with no install: a repository's own, ones you copied in, ones synced from your account | Checked before it runs (your `/name`, Claude's Skill tool) and again as it loads: no red flags runs, named once; anything else is held in the pane, and nothing in it runs | Yes |
| Session start | Plugins on that the guard never checked (an update Claude Code made on its own, an install from a terminal, a mod that loaded before the guard), and MCP servers in your configuration it never checked | Scanned beside the session: no red flags is named once; a red flag, or a mod you never approved, waits in the pane | Yes |

## Installing with the guard on

Run `/plugin install notes@acme` as usual. The guard looks up where Claude Code would install it from (the repository, folder and commit its marketplace names), scans that commit, and answers in the command's place, so nothing is installed yet. The pane shows the verdict and the command it is holding. When it could not verify the install, the command's answer says why too.

To install from a marketplace you have not added yet, `/plugin install rtl-toggle --marketplace owner/repo` works the same way: for a marketplace on GitHub, the guard reads its catalog at the commit Claude Code would add and scans the folder or repository that catalog names for the plugin. A marketplace hosted elsewhere is Could not verify until you add it with `/plugin marketplace add`, which the guard scans.

- **Install** (`i`) records your approval for that exact commit and tree hash, looks the plugin up once more, and runs your `/plugin` command again. If the commit moved since the scan, nothing is installed and the next `/plugin install` scans the new one.
- **Reject** (`r`) records the rejection. The same version is refused from then on; `/guard forget notes@acme` judges it again.
- A version you already approved (the same commit of the same folder, here or with `/guard scan`) is scanned again and installs without asking, unless it now judges worse than when you approved it (an outside lookup turned on since may know it as malware). A version you rejected is refused at once. A new commit is always scanned.
- When the verdict is **Do not install**, the button reads **Install anyway** and asks a second time. **Could not verify** (the guard could not tell what would be installed: a package from npm, a plugin no marketplace lists, a name two marketplaces share) works the same way, and lets that one command through once.

When Claude runs `claude plugin install` itself, the guard refuses the command and tells Claude why: the install waits for your decision, and Claude should not retry it or find another way. Approve it in the pane, then tell Claude to run it again; the same command now goes through.

The guard reads the command as Claude wrote it: each command the shell runs from its text, past `env`, `sudo`, `timeout` and the like, the script of `sh -c '…'` or `eval`, a here-document fed to a shell, and what runs inside `$(…)` or backquotes. Because approving the install approves that whole command, and what runs before it could change what it installs, the install must stand on its own (a `tail` after it is fine, and so is output sent to `/dev/null`): a command that also runs something else, changes folder or writes a file is held as Could not verify, and so is one whose plugin, source or subcommand is only known as it runs (`claude plugin install $NAME`). A `claude` command asked for its `--help` installs nothing. What a command only holds as text is not read for installs: a commit message, a file it writes, a program's input, code for another language. A marketplace Claude adds must be named by its full path or as `https://github.com/<owner>/<repo>`, since the guard cannot see the shell's current folder.

## Adding an MCP server

When Claude runs `claude mcp add` or `claude mcp add-json`, the guard reads the server it would add, its command and arguments or its address, with any environment variables and headers, and checks that configuration as it checks the MCP servers a plugin ships: a package started at whatever version is newest, a command that downloads code and runs it, a key sent to a host that is not its own service, the address Claude would connect to. The command is refused with the verdict until you approve, and the approval covers that exact configuration; the same name with another command is checked again. The server's own code is not read yet, only how Claude Code starts it or where it connects; with outside lookups on, a package it starts is checked against OSV.

The server's arguments go after `--` (`claude mcp add notes -- npx -y @acme/notes-mcp`), as Claude Code's documentation writes them: an option after the command without `--` could belong to either, so it is held. What would differ from what was scanned is held too: a name, command, argument, address or scope the shell or Claude Code fills in as it runs (`$HOST`, `${CMD}`), a configuration key the checks do not read, and a value filled in that is not a secret's. Passing a secret that way is fine, quoted so the shell keeps it one value (`-e GITHUB_TOKEN="$GITHUB_TOKEN"`, `-H "Authorization: Bearer $PAT"`, or `${PAT}` in a configuration). An unquoted `~`, `{a..b}` or `$X` is expanded by the shell, so it is held too. `claude mcp add` you type in your own terminal is not held; only Claude's. `/guard forget <server name>` clears what you decided about a server.

## Claude writing an MCP server

Claude can add an MCP server without `claude mcp add`, by writing it into the configuration Claude Code starts servers from: this folder's `.mcp.json`, or your `~/.claude.json` (which also holds each project's servers). When Claude writes or edits one of those files with its Write or Edit tool, the guard reads which servers the file would hold once written, and checks each one added or changed as it checks one added with `claude mcp add`. It always waits for you, and the approval covers that exact configuration; the same servers written in another order add nothing. Several servers written at once are decided together, and the decision holds for each.

Any other file goes on at once, with nothing read: a `.mcp.json` in another folder or a test's fixtures, skills, settings, a project's code. Where a path lands is found as the system finds it, links followed before a `..` after them. What the guard cannot read for certain in those two files is held rather than passed: a relative path, a write through a link, a file it cannot read, an edit it cannot replay exactly (write the whole file instead).

## Loading mods

Whenever Claude Code is about to load a mod (a plugin with a hooks module), as a session starts and at `/reload-plugins`, the guard hashes the mod's folder and looks for a version you approved with the same files: through an install it held, a `/guard scan`, or this gate's own pane. The same files load. Anything else is kept from loading: a mod picked from the `/plugin` menu, an update Claude Code made on its own, a folder whose files changed since you approved it.

The pane scans the first mod kept out, with **Approve** and **Reject**, and `/guard held` lists every mod kept out in the session and opens the next. Once you approve one, run `/reload-plugins` (or start a new session) and it loads. Files you rejected stay out without asking again, until `/guard forget <name>`. A folder the guard cannot read stays out as Could not verify.

The guard judges only the mods that load after it. Claude Code loads the folders given with `--plugin-dir` first, then installed plugins in the order your settings list them (`enabledPlugins`), so a mod installed before the guard is not judged as it loads; the [check at the start of a session](#at-the-start-of-a-session) covers those. An administrator's managed plugins and the ones bundled with Claude Code load as they are. This gate stops a mod's hooks module only: the skills, classic hooks and MCP servers of the same plugin are covered by the install gates and by the check at the start of a session. The `.in_use` marks Claude Code keeps in an installed plugin's folder are not part of what is compared.

## A skill's first use

A skill can arrive without any install: a repository you clone brings its `.claude/skills` and `.claude/commands`, a folder can be copied into `~/.claude/skills` by hand or by a script, and skills sync from your account. A skill's inline commands (`!` and a command in backquotes) run as Claude Code expands it, before the model reads anything and without asking, so the guard judges a skill before that: when you type `/name`, and when Claude runs it with the Skill tool. It looks for a skill or command by that name where Claude Code would find it: the `.claude` folder of the session's folder and of each folder above it, and your own. It scans a skill as its whole folder, links followed to where it really is, and a command as its one file. The scan counts an inline command that puts text from a web address into the skill as Worth a look, and lists any other as something the skill can do.

- **No red flags:** it runs as it is. The first time the guard sees those files, a note says it checked them.
- **Anything else:** nothing in it runs. Your `/name` is answered with the verdict, and Claude's Skill tool is refused with it, telling Claude not to read the skill's files to follow them. The pane shows the verdict with **Approve** and **Reject**. Once you approve, run it again (or ask Claude to), and those exact files run from then on. Files you rejected stay held without the pane, until `/guard forget <skill folder>`.
- **Files it cannot read**, or a failure of the guard itself, hold the skill with the reason; there is nothing to approve until it can read them.

As its instructions load for the model, the guard checks the skill once more. That catches one found anywhere else, such as a skill a subagent preloads: Claude then reads, in place of the instructions, that it was held. By that point its inline commands have run.

A plugin's skills load as they are: they are judged with the plugin as a whole when it installs, and a skill's folder scanned alone is cut off from the rest of its plugin (a link into the plugin's own files would look like one leaving it). Claude Code's own skills, an administrator's, and an MCP server's prompts, which have no file on this machine, load as they are too.

## At the start of a session

Claude Code adds plugins no gate sees: an update it makes on its own, a plugin installed from a terminal while no session ran, a mod that loads before the guard. So as each session starts, the guard lists the plugins installed and on, and hashes each one's folder. It does this beside the session: the first prompt does not wait for it.

- **Files you approved** (through an install it held, a `/guard scan`, the mod loading gate, or this check) are left alone, and so are files it checked before with no red flags.
- **No red flags:** a note names it once.
- **A red flag, or a mod whose files you never approved:** it waits in the pane with **Keep** and **Turn off**. Keep records your approval for those exact files. Turn off records the rejection and runs `/plugin disable <name>@<marketplace>` for you. It waits again each session until you decide; `/guard held` lists what waits and is still on, and opens the next, unless the pane holds a verdict still waiting for you. A plugin you rejected that is on all the same is named once for each rejection.
- **A folder it cannot read** waits as Could not verify; Turn off still turns it off.

The first check on a machine names everything already on in one note and opens no pane, since you chose those plugins before the guard looked at them; `/guard held` opens each one to look at, in that session or a later one, without the guard naming them again. From then on, a plugin that is new or has changed is checked as a session starts.

By the time the check runs, the plugin's classic hooks and MCP servers have started for this session: the check tells you, and Turn off keeps them from the next. It leaves out the mods the loading gate already kept out, an administrator's plugins and the guard itself. A headless run (`claude -p`) is not checked, since no pane can show what it finds.

### Your configuration

The same check then reads the MCP servers in your configuration, which changes outside Claude too: a `git pull` that brings a project's `.mcp.json`, another program's installer writing to `~/.claude.json`, an edit made in a terminal. It reads the files and runs nothing; `claude mcp list` would start each server to check on it, so the guard does not use it.

- **MCP servers:** each server in your `~/.claude.json`, yours and this folder's, and in this folder's `.mcp.json`, laid out and hashed as the gates lay out one Claude adds, so a server you approved then (with `claude mcp add`, or in a configuration Claude wrote, several servers at once included) counts as approved here. One with no red flags is named once; one with a red flag waits in the pane with **Keep** and **Reject**. The server started with the session, so Reject cannot stop it there: the guard refuses its tools, from the first call in every session after, headless runs included, and tells you the command that removes it (`claude mcp remove <name> -s <scope>`). It never changes your configuration itself.
- **A file that is there but cannot be read** is named as Could not verify each session until it can.

An administrator's managed servers are theirs, and left out. The first check on a machine names what is already there in one note and opens no pane, as it does for plugins.

[Back to the documentation](README.md)

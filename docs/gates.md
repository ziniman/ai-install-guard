# Where it steps in

The guard holds what is about to be added to Claude Code, whether you add it or Claude does. This page lists each place it steps in and what happens there.

| Layer | Catches | What happens | Today |
|-------|---------|--------------|-------|
| Slash command | `/plugin install <name>@<marketplace>`, `/plugin install <name> --marketplace <source>`, `/plugin marketplace add <source>` | Held until you press Install | Yes |
| Claude's own commands | `claude plugin install`, `claude plugin update`, `claude plugin marketplace add`, also inside `sh -c`, `eval` or a here-document | Refused, with a note telling Claude the install waits for your decision | Yes |
| Claude's own commands | `claude mcp add` and `claude mcp add-json` (`add-from-claude-desktop` is held as Could not verify) | Refused until you approve that exact server configuration | Yes |
| Claude's own writes | Files Claude writes or edits in skill, command and agent folders, MCP servers in `.mcp.json` or `~/.claude.json`, any file of an installed plugin | Checked as they would land: a skill, command or agent with no red flags goes on with a note, anything else is refused until you approve | Yes |
| Claude's own settings | Claude writing or editing `settings.json` or `settings.local.json` (the project's, yours, an organization's) | A change that widens what Claude may do or run is refused until you approve it; one that only narrows it goes on | Yes |
| Claude's own shell commands | Files written, copied, moved, linked, cloned, downloaded or unpacked into those folders and files with the shell (`>`, `tee`, `cp`, `mv`, `ln`, `rsync`, `git clone`, `curl -o`, `wget`, `unzip`, `tar -x`, `sed -i`) | Text Claude writes is checked as a Write of it would be; a file or folder copied in, or a repository cloned, is scanned and waits for you; what cannot be known before it runs (a download, an archive, a link) is Could not verify | Yes |
| Mod loading | Any mod about to load, however it got there, including plugins picked from the `/plugin` menu | Refused if its files do not match what you approved | Later |
| First use of a skill | Skills and commands, including ones copied in by hand | Blocked until scanned | Later |
| Session start | Anything installed while the guard was not running | Scanned, with Keep or Uninstall | Later |

## Installing with the guard on

Run `/plugin install notes@acme` as usual. The guard looks up where Claude Code would install it from (the repository, folder and commit its marketplace names), scans that commit, and answers in the command's place, so nothing is installed yet. The pane shows the verdict and the command it is holding. When it could not verify the install, the command's answer says why too.

To install from a marketplace you have not added yet, `/plugin install rtl-toggle --marketplace owner/repo` works the same way: for a marketplace on GitHub, the guard reads its catalog at the commit Claude Code would add and scans the folder or repository that catalog names for the plugin. A marketplace hosted elsewhere is Could not verify until you add it with `/plugin marketplace add`, which the guard scans.

- **Install** (`i`) records your approval for that exact commit and tree hash, looks the plugin up once more, and runs your `/plugin` command again. If the commit moved since the scan, nothing is installed and the next `/plugin install` scans the new one.
- **Reject** (`r`) records the rejection. The same version is refused from then on; `/guard forget notes@acme` judges it again.
- A version you already approved (the same commit of the same folder, here or with `/guard scan`) is scanned again and installs without asking, unless it now judges worse than when you approved it (an outside lookup turned on since may know it as malware). A version you rejected is refused at once. A new commit is always scanned.
- When the verdict is **Do not install**, the button reads **Install anyway** and asks a second time. **Could not verify** (the guard could not tell what would be installed: a package from npm, a plugin no marketplace lists, a name two marketplaces share) works the same way, and lets that one command through once.

When Claude runs `claude plugin install` itself, the guard refuses the command and tells Claude why: the install waits for your decision, and Claude should not retry it or find another way. Approve it in the pane, then tell Claude to run it again; the same command now goes through. Because approving it approves that whole command, the install must stand on its own (a `tail` after it is fine): a command that also runs something else, changes folder or writes a file, or that is only known as it runs (`$CMD plugin install …`, `bash -c "$CMD"`, a script piped into a shell, code for another language that mentions `claude`), is held as Could not verify. A marketplace Claude adds must be named by its full path or as `https://github.com/<owner>/<repo>`, since the guard cannot see the shell's current folder.

## Adding an MCP server

When Claude runs `claude mcp add` or `claude mcp add-json`, the guard reads the server it would add, its command and arguments or its address, with any environment variables and headers, and checks that configuration as it checks the MCP servers a plugin ships: a package started at whatever version is newest, a command that downloads code and runs it, a key sent to a host that is not its own service, the address Claude would connect to. The command is refused with the verdict until you approve, and the approval covers that exact configuration; the same name with another command is checked again. The server's own code is not read yet, only how Claude Code starts it or where it connects; with outside lookups on, a package it starts is checked against OSV.

The server's arguments go after `--` (`claude mcp add notes -- npx -y @acme/notes-mcp`), as Claude Code's documentation writes them: an option after the command without `--` could belong to either, so it is held. What would differ from what was scanned is held too: a name, command, argument, address or scope the shell or Claude Code fills in as it runs (`$HOST`, `${CMD}`), a configuration key the checks do not read, and a value filled in that is not a secret's. Passing a secret that way is fine, quoted so the shell keeps it one value (`-e GITHUB_TOKEN="$GITHUB_TOKEN"`, `-H "Authorization: Bearer $PAT"`, or `${PAT}` in a configuration). An unquoted `~`, `{a..b}` or `$X` is expanded by the shell, so it is held too. `claude mcp add` you type in your own terminal is not held; only Claude's. `/guard forget <server name>` clears what you decided about a server.

## Claude writing skills, MCP servers and plugin files

When Claude writes or edits a file with its Write or Edit tool, the guard looks at the path first: any file outside the places Claude Code loads from goes on at once, with nothing read. A file in a `skills`, `commands` or `agents` folder (in the project's `.claude` or in `~/.claude`) is scanned as it would be once written: a skill as its whole folder with the new file in it, a command or agent as that file. When the scan finds nothing, the change goes on with a note; anything worth a look or worse is refused until you approve it in the pane, and the approval covers that exact content.

An MCP server added or changed in `.mcp.json` or `~/.claude.json` is checked like one added with `claude mcp add`, and always waits for you. A change to the files of a plugin Claude Code installed (`~/.claude/plugins`) is held as Could not verify: it would change what runs outside any install. Output styles count as prompts too. Where a path lands is found as the system finds it, links followed before a `..` after them, and without regard to case, as a disk that ignores case reads it. What the guard cannot read for certain in those places is held rather than passed: a relative path, a write through a link, a file it cannot read, an edit it cannot replay exactly (write the whole file instead). Two changes to one skill at once are taken one at a time.

## Claude changing settings

Settings decide what Claude runs without asking, what runs on its own and where its traffic goes, so a change to `settings.json` or `settings.local.json` that widens any of that waits for you, judged by what it widens:

- **Red flags:** an allow rule that lets Claude run any shell command (`Bash(*)`, `Bash(npm:*)`, an interpreter with `-c`), the `bypassPermissions` mode, a hook or helper command that reaches out or runs downloaded code, an `ANTHROPIC_BASE_URL` or proxy that sends Claude's traffic to another host, a variable that changes what code runs (`NODE_OPTIONS`), and approving every project MCP server.
- **Worth a look:** any other allow rule (`Bash(npm test:*)`), a hook or helper command, a removed deny or ask rule, an extra working folder, a plugin or marketplace turned on outside `/plugin install`, and a setting the guard does not know.
- **Goes on:** a rule that only blocks or asks, a stricter mode, and settings that run nothing (theme, model).

The approval covers that exact file.

## Claude changing those places with the shell

Claude can make the same changes with a shell command instead of Write, so the guard reads every shell command for the files it writes, without running it. A command that writes nowhere Claude Code loads from goes on at once, with nothing read. One that does is judged by what lands:

- **Text the command holds** (a here-document, `echo`, `printf`, `tee`) is checked exactly as a Write of that text would be: a skill with no red flags goes on with a note, a settings change that widens what Claude may do waits, and so on. An append is checked as the file it makes.
- **A file or folder copied or moved in** (`cp`, `mv`, `install`, `rsync`, `ditto`, `cat a > b`) is scanned where it is now and always waits for you, even with no red flags, since it comes from somewhere else. The approval covers that exact content.
- **A repository cloned in** (`git clone`) is scanned at the commit it would clone and waits for you, as a plugin install does.
- **What cannot be known before it runs** is Could not verify: a download (`curl -o`, `wget`), an archive unpacked (`unzip`, `tar -x`), an edit made by a program (`sed -i`), a link (`ln -s`, which would load whatever it points to, now and later), a `git pull` or checkout in one of those folders, and a program the guard does not know that is given one of those paths. Install anyway lets that exact command through once.

A command that makes more than one such change is held: make each change on its own. Relative paths are read from the folder the session is in, which the guard follows as Claude changes it, and from any `cd` earlier in the same command; a folder that `CLAUDE_CONFIG_DIR` names counts as `~/.claude`. Code the guard does not read is held only when the command names one of those places: inline Python, Node and the like that may write, copy, move or delete files, run another program or hide what it does (`eval`, decoding); an `awk` or `sed` program that writes files; a script piped into a shell or an interpreter; and a program or path only known as it runs. Inline code that only reads a file there and prints it goes on. A script file, such as a skill's own script run from where it is installed, is judged like any program, by the paths it is given; one that writes there on its own is not seen, and the later skill and session-start gates are the backstop for that.

[Back to the documentation](README.md)

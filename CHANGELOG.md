# Changelog

All notable changes to ai-install-guard. Ordered newest to oldest.

---

## v0.8.10 &nbsp;·&nbsp; 2026-11-01

**Checks** - Two false positives that flagged well-made plugins as Do not install, and so opened the pane at each of their updates, are now notes. In a skill's code block, a page downloaded into a one-line Python program that only reads it (`curl … | python3 -c "…json.load(sys.stdin)…"`, `python3 -m json.tool`) is data, not code downloaded and run; one whose code could run what it reads (`exec`, `os.system`, a shell substitution), whose output is piped on, or that sits inside a group, a substitution or a loop still fails, as does any download piped into Node. And in a script that writes files, a path where Claude Code loads plugins, skills or memory now counts as written only when it can reach a write, followed through the names it is given and the calls that build a path: one only printed, read or run as a script is listed, not flagged

**Install gate** - A shell command running JavaScript with a template in it (``node -e 'console.log(`${a} ${b}`)'``) is no longer held as a command built as it runs, when the code starts no process. The template is the code's own text, so it is read for install words like the rest of the code. A backquote that runs a command only known as it runs is still held: one a shell runs (in double quotes, in a script a shell is given, or in an argument `watch` or `su -c` may hand to one), one in Ruby, Perl or PHP, where it runs a shell command, one in a string that code may hand to a shell, and any in JavaScript that can start a process

---

## v0.8.9 &nbsp;·&nbsp; 2026-10-31

**Session start** - The check as a session starts now also reads your configuration: each MCP server in `~/.claude.json` and this folder's `.mcp.json`, and what your own and this folder's settings files run on their own (hooks, the status line, helper commands, and environment variables that change what runs or where traffic goes). That catches what a `git pull` or another program's installer adds outside Claude. It reads the files and runs nothing. A server with no red flags is named once; one with a red flag, or a settings file that runs something you have not approved, waits in the pane with Keep and Reject. Keep approves what a settings file runs, not the whole file, and a later change shows only what it adds or takes away. The guard never edits your configuration: Reject on a server makes it refuse that server's tools, from the first call in every session after, and tells you the command that removes it

**`/guard held`** - Also lists the MCP servers and settings files in your configuration that wait for your decision

**Decisions** - Once the list of decisions is full, the oldest approval is forgotten before any rejection, since a forgotten approval only asks again

## v0.8.8 &nbsp;·&nbsp; 2026-10-31

**Claude's shell commands** - A command with code the guard does not read, such as a `sed` edit or an inline Python script, is no longer held because its text names Claude Code and MCP servers or plugins in a sentence. Only the `claude` command as the shell spells it, and `plugin i` in lowercase, count as a sign of an install there, so editing docs or source that talk about Claude Code goes through

## v0.8.7 &nbsp;·&nbsp; 2026-10-31

**Session start** - As a session starts, the guard checks every plugin installed and on, beside the session so the first prompt does not wait. That catches what no gate sees: an update Claude Code made on its own, a plugin installed from a terminal while no session ran, a mod that loaded before the guard. Files you approved, or checked before with no red flags, are left alone. A new or changed plugin with no red flags is named once; one with a red flag, or a mod you never approved, waits in the pane with Keep and Turn off, which runs `/plugin disable` for it. The first check on a machine names what was already on in one note and opens no pane, since you chose those plugins before the guard looked

**`/guard held`** - Also lists the plugins on that wait for your decision, and opens the next one in the pane

---

## v0.8.6 &nbsp;·&nbsp; 2026-10-31

**A skill's first use** - A skill or command that came with no install (a repository's own, one copied into `~/.claude/skills`, one synced from your account) is scanned before it runs, when you type `/name` or Claude calls the Skill tool, since its inline commands run as Claude Code expands it. One with no red flags runs, named once; one with a red flag is held in the pane with Approve and Reject, and nothing in it runs. It is checked again as its instructions load, for a skill found anywhere else. A plugin's skills are left to the plugin's install, since a skill's folder read alone is cut off from the rest of its plugin

**Skills: inline commands** - A command a skill runs as it loads (`!` and a command in backquotes) is read as one: one that puts text from a web address into the skill is Worth a look, and any other is listed under what the skill can do

**Claude writing a skill** - A skill Claude writes with no red flags is remembered as checked, so its first use does not name it again

**`/guard scan`** - A file the guard may not read is reported as one it could not read, not as one that changed during the scan

---

## v0.8.5 &nbsp;·&nbsp; 2026-10-30

**Claude's shell commands** - `command -v` and `command -V` are read as a lookup that runs nothing, so a loop that checks which tools are installed no longer counts as running a program only known as it runs. `perl -i` and `ruby -i` are read as `sed -i` is: each file after the code is an edit judged by where it lands, with the copy a suffix such as `-i.bak` keeps, so editing a file Claude Code does not load goes on and editing a skill or a settings file still waits. A replacement of plain text (Perl's with no `e` flag, `$` or `@`; Ruby's `gsub` string with no `#`) is read as the text it writes, so words such as "write" or "require" in it hold nothing. Both commands were held as Could not verify beside a mention of `.claude`. An in-place edit beside a module (`-M`, `-r`), code that picks its own files or changes folder, and Perl's and Ruby's other ways to run a program (`qx`, `%x`, a pipe opened as a file) stay held

---

## v0.8.4 &nbsp;·&nbsp; 2026-10-29

**Mod loading** - A mod Claude Code is about to load, however it got there (the `/plugin` menu, an update made on its own, files changed in place), loads only when its folder holds exactly files you approved. Anything else is kept off, scanned in the pane with Approve and Reject, and loads after `/reload-plugins` once you approve it. The guard judges the mods that load after it; managed and built-in plugins load as they are

**`/guard held`** - Lists the mods kept from loading in this session and opens the next undecided one in the pane

**`/guard scan`** - The `.in_use` marks Claude Code keeps in an installed plugin's folder are left out of the tree hash, so an installed copy hashes as the commit it was installed from. A folder with anything else in `.in_use` counts in full

**The `/plugin` menu note** - Now says that a mod picked there stays off until you approve it

---

## v0.8.3 &nbsp;·&nbsp; 2026-10-29

**Claude's shell commands** - Inline code that names Claude's folder is held only when it may write, copy, move or delete files, run another program or hide what it does, so a Python or Node one-liner that only reads a settings file and prints it goes on. Code piped into an interpreter through `-` counts as code from input, which stays held

**Install gate** - A path such as `.claude-plugin/marketplace.json` is no longer read as the words of a plugin install in another language's code, and a `claude` command the guard read whole and found to install nothing (`claude plugin test .`) no longer makes a script run beside it look like a possible install. Both held commands that installed nothing

**Install** - The marketplace names the plugin by its `https://` address, so installing or updating the guard works without a GitHub SSH key. 0.8.1 named it as a `github` source, which Claude Code clones over SSH when a key looks configured, and an update inside a session does not fall back to HTTPS

---

## v0.8.2 &nbsp;·&nbsp; 2026-10-28

**Install gate** - A plugin whose marketplace names a branch or tag other than the default is scanned as that branch's commit, so it is no longer warned as a commit a fork could have put there. The guard's own update from its release branch was held as Worth a look for this

**Release** - The release branch's commits are made through GitHub's API, so GitHub signs them and a scan of an install shows them verified

---

## v0.8.1 &nbsp;·&nbsp; 2026-10-26

**Install** - Installing the guard now copies only the mod (its manifest, hooks, types and README) from a `release` branch CI builds at each version, not the whole repository: no test samples, and no build tools installed or install scripts run

**Review badge** - A README badge whose verdict matches the scan now says so first; that it was made for other content is a second line, not a warning

---

## v0.8.0 &nbsp;·&nbsp; 2026-10-25

**Claude's shell commands** - The guard now reads every shell command Claude runs for the files it writes, without running it, and holds a change where Claude Code loads from as it holds a Write. Text the command holds (a here-document, `echo`, `printf`, `tee`) is checked as a Write of that text; a file or folder copied, moved or synced in is scanned and always waits for you; a repository cloned in is scanned at the commit it would clone; a download, an archive unpacked, a `sed -i` edit, a link, a checkout there, or a program given one of those paths is Could not verify. A command that makes more than one such change, or runs code the guard does not read while naming Claude's folder, is held. Relative paths are read from the session's current folder, which the guard follows as it changes

**Claude's writes** - A folder that `CLAUDE_CONFIG_DIR` names is read as `~/.claude`, for Write and Edit as for the shell, so skills and settings kept there are checked too

---

## v0.7.0 &nbsp;·&nbsp; 2026-10-25

**Settings** - When Claude writes or edits `settings.json` or `settings.local.json` (the project's, yours or an organization's), the guard compares the file before and after. A change that widens what Claude may do or run waits for you, judged by what it widens: an allow rule for any shell command, `bypassPermissions`, a hook or helper that reaches out, a redirected `ANTHROPIC_BASE_URL` or proxy, or approving every project MCP server is a red flag; any other allow rule, hook or helper, a removed deny rule or hook, every hook turned off, or a plugin turned on outside `/plugin install` is worth a look. An allow rule for a program that runs whatever it is given (`sudo`, `env`, `xargs`, `npx`, or `npm run` with no script named) counts as any shell command. A change that only narrows what runs, or touches nothing that runs, goes on. Each settings file's approvals are its own, a file is found under the name a link gives it, and a settings file inside a plugin or skill folder is that plugin's or skill's

---

## v0.6.0 &nbsp;·&nbsp; 2026-10-25

**Claude's writes** - When Claude writes or edits a file with its Write or Edit tool in a place Claude Code loads from, the guard checks it as it would land. A skill (its whole folder with the new file in it), command or agent with no red flags goes on with a note; one worth a look or worse is refused until you approve that exact content. An MCP server added or changed in `.mcp.json` or `~/.claude.json` gets the same checks as `claude mcp add` and always waits for you. A change to an installed plugin's files is held as Could not verify. Any other file goes on at once, with nothing read. What cannot be read for certain in those places (a relative path, a write through a link, an edit the guard cannot replay) is held, and two changes to one skill at once are taken one at a time

**scanner** - A plain-text file a prompt names counts as a prompt, and a `skill.md` in any case makes a skill, as a disk that ignores case loads it

---

## v0.5.0 &nbsp;·&nbsp; 2026-10-25

**MCP servers** - When Claude runs `claude mcp add` or `claude mcp add-json`, the guard reads the server it would add (its command and arguments or its address, environment variables and headers), checks that configuration as it checks a plugin's MCP servers, and refuses the command until you approve that exact configuration in the pane. `claude mcp add-from-claude-desktop` is held as Could not verify. What would make the added server differ from the scanned one is held: a part the shell or Claude Code fills in as it runs (only a secret's value may be, quoted so it stays one value), and a configuration key the checks do not read. The server's own code is not read yet, only how it starts or where it connects

**shell reader** - It records which words the shell expands as a command runs (a variable, a substitution, a tilde, a pattern, a brace list or range) and which it may split, so a quoted address with `?` in it, or JSON in single quotes, is read as written; `claude-code.exe`, `claude.cmd` and the other Windows launchers are the claude command too

**`pane`** - The header names an MCP server as such, with "An" before it

---

## v0.4.4 &nbsp;·&nbsp; 2026-10-25

**`/guard badge`** - A badge names the scanned content, a hash of every file with the README read without its AI Install Guard badge, not a commit. Committing a badge makes a new commit, so a badge naming a commit could never be right for the commit that held it; this one is right in the commit that adds it and stays right until anything else changes. Badges made before keep counting as the commit or tree they name

**`provenance`** - A badge that claims more than the scan finds, for this very version, says it was never earned rather than outdated

**command line** - `--badge` prints the README badge after the report, as `/guard badge` does in Claude Code, and `--json` includes the content hash

---

## v0.4.3 &nbsp;·&nbsp; 2026-10-25

**`pane`** - When the report is taller than the pane, a dim "↓ scroll for the checks" sits beside the counts, so it is clear there is more below the buttons; it goes once the checks are in view

---

## v0.4.2 &nbsp;·&nbsp; 2026-10-25

**`pane`** - Install, Reject and the other buttons sit right under the verdict instead of after every check, so acting on a verdict never needs a scroll, and the button row wraps instead of running off a narrow pane's edge

**`plugin metadata`** - The plugin, marketplace and npm descriptions say what sets the guard apart: it is a mod that runs in the background and scans every `/plugin install` and marketplace add, yours or Claude's, before it happens, with nothing to run first. The chat skill's description names all four current verdicts

---

## v0.4.1 &nbsp;·&nbsp; 2026-10-25

**`prompts`** - Text that writes about an attack is no longer read as one. A quoted "ignore previous instructions", "data exfiltration" in a list of what a skill must not do, a `<system>` placeholder with no closing tag, a key named in a `.env` example, a credential file named but not read, an author's note in an HTML comment, `npx tsc` and a command named like `/help` (Claude Code's own keeps the name) are notes. A phrase that only hides something ("silently", "without telling the user") counts when its paragraph names an address, a network tool or a credential. A hidden comment that does, or tells the model to keep quiet, is still worth a look, and a key sent anywhere but its own service still fails. Homebrew's and other well-known installers piped into a shell are worth a look; any other download and run still fails. Every match is judged before any is dropped, so mentions placed first cannot hide a real finding, and the quotes around a frontmatter value do not make it a mention

**`hooks`** - A hook script is judged with the local modules it imports: a key it reads fails only when that code can send it somewhere other than the key's own service, and a docstring that names the key is a note. A file passed to a launcher script (`bash run.sh hook.py`) is read as its own language, not as shell

**`code`** - Words in a string that read as prose, such as a review prompt that names `eval()` or `169.254.169.254`, are notes. A key used only with its own service, a key file's bare name in a list with no network or home folder in the file, `core.hooksPath=/dev/null`, a permission mode named in a list, a zero-width joiner inside an emoji, and a data-collection host that is the plugin's own service (a Telegram plugin talking to Telegram) are no longer flagged. JavaScript counts as minified only when its long lines are mostly code, not a long prompt string; a minified library under `assets/` or `vendor/` and a large file are notes

**`mod`** - Whether a mod calls itself cosmetic is read from its manifest's description when it has one, and never from a README image's alt text

**`benchmark`** - `scripts/benchmark.js` scans every plugin a marketplace ships in its own folder and counts the verdicts. CI runs it on Anthropic's official marketplace at a pinned commit and fails if a change flags more: 50 of its 53 plugins now scan with no red flags and none as Do not install, against 38 and 4 in 0.4.0

---

## v0.4.0 &nbsp;·&nbsp; 2026-10-25

**`verdict`** - The verdict now answers one question, whether anything is suspicious: **No red flags**, **Worth a look**, **Do not install** or **Could not verify**. What a candidate can do (shell hooks, MCP servers it starts or connects to, network access, Bash allowed without asking, programs its scripts start) is listed beside it on an "It can" line, like an app's permissions, and no longer makes it look worse on its own. Against Anthropic's official marketplace, No red flags went from 21 of 54 plugins to 39, and Do not install from 12 to 4

**`checks`** - A capability the README explains, a plain shell hook, a container run by tag, a key sent to its own service, a skill's `allowed-tools: Bash`, a script that starts programs and a marketplace source that follows a branch are shown as what the candidate can do. A high-risk mod capability the README does not explain, and a committed key or filled `.env`, are worth a look rather than a reason to refuse. A missing license or README and a brand-new repository or account are notes. Red flags are unchanged: hidden characters, injection, credential theft, download-and-run, persistence, settings changes, a capability that contradicts what the plugin says it is, and the rest still fail

**`pane`** - The verdict box shows the "It can" line, and the counts read as red flags, things to look at, and passes. A direction mark written as a string constant is a note on how to write it, not a warning

**`/guard badge`** - New badges say No red flags or Worth a look; badges made before keep counting as the verdict they name

---

## v0.3.3 &nbsp;·&nbsp; 2026-10-24

**`pane`** - The title names the guard's version beside its name (AI Install Guard 0.3.3 · …), read from the copy that is running, so a screenshot says which version judged; the copied report's first line names it too, as does the chat skill's report

---

## v0.3.2 &nbsp;·&nbsp; 2026-10-23

**`pane`** - The held command, the verdict's reasons and the title wrap instead of being cut off at the pane's edge, so a long reason can be read in a narrow pane. A Could not verify reason shows as a sentence of its own under the banner

**`/plugin install`** - When the guard could not verify an install, the command's answer says why, and names the button that installs it anyway; a scan's own findings stay in the pane. `/plugin install <name> --marketplace <source>` is now scanned like any install: for a marketplace on GitHub, its catalog is read at the commit Claude Code would add, and the folder or repository it names for the plugin is scanned. Claude's own `claude plugin install … --marketplace` must name the marketplace by its https address or full path

---

## v0.3.1 &nbsp;·&nbsp; 2026-10-23

**`README`** - An Uninstall section, linked from the top: how to remove or pause the guard in Claude Code or from a terminal, how to turn it off from outside Claude Code if it ever holds something it should not, how to clear your decisions before you go, and that the guard never holds an uninstall or a disable

**`ci`** - The workflows use the current Node 24 releases of checkout, setup-node and upload-artifact, pinned to their commits, instead of Node 20 ones the runners now force onto Node 24, and npm no longer warns about the `always-auth` setting the old setup-node wrote

---

## v0.3.0 &nbsp;·&nbsp; 2026-10-23

**`/plugin install`** - The guard now holds installs. `/plugin install <name>@<marketplace>` and `/plugin marketplace add <source>` are looked up (the repository, folder and commit Claude Code would install from), scanned at that commit and answered in the command's place, so nothing installs until you press Install in the pane. Install records your approval for that commit and tree hash, looks the plugin up once more, and runs your command again; a commit that moved since the scan is not installed. A version you already approved installs without asking again unless a new scan judges it worse, a rejected one stays refused, and what the guard cannot pin (an npm package, a plugin no marketplace lists, a name two marketplaces share) is Could not verify, with Install anyway behind a second confirmation that lets that one command through once. The `/plugin` menu itself is not gated yet, and says so when it opens

**`claude plugin`** - When Claude runs `claude plugin install`, `claude plugin update` or `claude plugin marketplace add` itself, including inside `sh -c`, `eval`, a here-document or a longer command line, the command is refused with a reason telling Claude the install waits for your decision, and the scan opens in the pane. Once you approve, the same command goes through. Approving it approves that whole command, so the install must stand on its own: one that also runs something else, or that is only known as it runs (a variable, a script piped into a shell, inline code for another language), is held as Could not verify; so is a shell or `eval` told to run a variable, whatever it holds. A marketplace Claude adds must be named by its full path or its https address, since the guard cannot see the shell's current folder. Every other command runs untouched, including ones that only print an install's words

**`/guard scan`** - The same scan and pane now serve `/guard scan` and the gates; a version approved through `/guard scan` counts when you install that same commit of that same folder

**`checks`** - A mod's `tool.call` or `tool.check` hook narrowed to one tool is described as that tool's ("sees every Bash call"), still as high risk, instead of as every tool call

---

## v0.2.0 &nbsp;·&nbsp; 2026-10-22

**`outsideLookups`** - Harder to fool: each package runner's own options are read (`-p` is a package to npx but a Python version to uvx), so `--with`, `--with-requirements` and file arguments no longer hide the main package; Python extras such as `httpx[cli]` are looked up; an advisory OSV answers with an empty or malformed record stays unresolved and a package with no usable answer is reported as not looked up; up to 300 advisories are read for malware instead of 30; every marketplace name is compared; and one scan asks for the official list and each advisory once, however many plugins it lists

**`provenance`** - A GitHub request that fails late is noted where it belongs and no longer hides the warnings earlier requests found; a listed plugin's worse finding now brings its own reason to the marketplace's row

**`skill`** - AI Install Guard for Claude chat: `npm run build:skill` bundles the scanner into an Agent Skill, `dist/ai-install-guard-skill.zip`, to upload to Claude. Attach a zip of a plugin, skill or MCP server, or paste a repository link, and Claude runs the same deterministic checks and presents the verdict, the plain-language summary and the evidence, treating the scanned files as untrusted data and never softening a failure. Where a chat's network settings block GitHub, it says so and asks for a zip

**`cli`** - `node scan.js <folder | zip | repository>` runs the scan outside Claude Code, with `--ref`, `--path`, `--details`, `--json` and `--lookups`, and exits with the verdict (0 to 3). A zip is unpacked by the scanner itself into its own temporary folder, which is removed afterwards. When it holds one folder, or one plugin or skill beside other files, that is what is scanned; several side by side need `--path`. Paths that would land outside the folder, special files, encrypted entries, names listed twice and anything over the size limits stop the scan as Could not verify, and links are recreated as links and judged, never followed. It starts only `git`, `sh`, `mktemp` and `rm` (PowerShell on Windows), without any `GIT_` variable from its own environment, and a command that prints more than 4 MiB fails the scan rather than being read in part

**`checks`** - A right-to-left plugin is no longer told Do not install just for defining a direction mark as a constant: a bidirectional control that is the whole of a one-line string, with nothing after it on its line but `;`, `,` or a comment, is a warning that names the escape to write instead, since it cannot reorder any code. Anywhere else, in a language the tokenizer does not know, and for tag characters, it still fails, and a file full of such constants cannot crowd out a real one

**`verdict`** - The middle verdict is now **Review what it can do**, formerly Install with caution. It means the candidate has powerful access worth knowing about, which a trustworthy tool may need too, not that it is a lesser kind of safe. The badge uses the new words, and a badge with the old words still counts as that verdict

**`pane`** - The mod capability rows now say in plain words what a mod can do and whether its README says why, which programs it starts (read from its code, with shells and other risky ones called out), and the README's own explanation, quoted and marked as the plugin's words

**`provenance`** - For a repository on GitHub, the report now says how old it and its owner's account are, its stars, forks and contributors, whether it is archived or a fork, and whether the scanned commit is signed and on the default branch. A brand-new account, a new repository with one author and few stars, and a commit named by id that is not on the default branch (it may come from a fork) are warnings; a lookup that fails is only noted

**`outsideLookups`** - A new setting, off by default. Turned on, the packages a plugin's MCP servers start or its manifests pin are checked against OSV, where malware (MAL ids, or advisories marked CWE-506) fails and a pinned version's known vulnerabilities warn, and its name is compared with Anthropic's official plugins, where a near miss warns

**`/guard badge`** - A README badge for plugin authors: after a scan that was Safe to install or Install with caution, `/guard badge` or Copy badge in the pane gives a shields.io badge naming the verdict and the exact commit or tree hash scanned, linked to how to check it. The guard never trusts a badge it meets: one that claims more than its own scan finds is a warning, and one that matches is only noted

**`README`** - The Reviewed by AI Install Guard mark heads the README

**`/guard scan <repository>`** - Scans one commit of a remote repository (`https://`, `github:owner/repo` or `owner/repo`, with `@ref`, `--ref` and `--path`). The ref is resolved with `git ls-remote`, only that commit is fetched into the guard's own temporary folder with no hooks, submodules, LFS downloads or filters, and the checkout must land on the pinned commit before anything is read; the folder is removed afterwards. Short commit ids, refs that name both a branch and a tag, and non-https sources are refused

**`provenance`** - New rows for a remote scan: the source and its pinned commit, branches or tags named like a commit id or `FETCH_HEAD` (the Plugin4Shell trick, a failure), and submodules whose code was not scanned. For a marketplace, each plugin it lists from elsewhere is checked for a full commit pin or an exact package version

**`mcp`** - MCP server checks: every server and what it runs or talks to, servers that download code or start unpinned packages or container images, inline shell scripts, remote and unencrypted servers, and API keys sent to a host that is not their own service

**`structure`** - Flags Git LFS pointers and git filters, whose real content is filled in at install and could not be scanned

**`pane`** - A row now says what it found in plain words before any code: which programs a candidate starts and what each is for, with shells, compilers and programs chosen at run time called out as worth a look, and which secrets or credential files its code reads. The code lines sit behind their own Show the code toggle, and the verdict's reasons use the same plain headline

**`checks`** - Fewer false alarms, found by scanning a real skill: a standalone skill is no longer failed for having no plugin manifest, a local preview address is not a remote instruction, a person called a reviewer is not a security scanner, a browser's program path is not its profile data, and one-word placeholder hosts are not listed

---

## v0.1.0 &nbsp;·&nbsp; 2026-10-22

**`pane`** - `/guard scan` opens a verdict pane: the recommendation and its reasons in a coloured banner, the counts, and every check grouped with failures first, each row opening to its evidence and advice. Approve and Reject record the decision against the exact tree hash; on Do not install or Could not verify the button reads Approve anyway and asks a second time. Details opens every row and Copy report copies the full text. Progress shows in the pane and the status line, and a toast says when the verdict is ready

**`/guard report`, `/guard list`, `/guard forget`** - Reopen the last report, list your decisions, and forget the ones about a name

**`checks`** - Deterministic checks for structure and manifest (Claude Code's own validator, binaries and disguised files, symbolic links that leave the folder, data after an image's end, bundled permission settings), mod capabilities (every hooked event and `$` call in plain language, high-risk calls, capability mismatch), classic shell hooks and their scripts, skills, commands and agents (prompt injection, credential instructions, broad `allowed-tools`, remote instructions, look-alike names, text aimed at the scanner), code patterns (hidden Unicode with tag characters decoded, execution, obfuscation, credentials with network code, persistence, install scripts, registry redirects, network addresses) and committed secrets, each with a fixture and a test

**`/guard scan`** - Prints a verdict (Safe to install, Install with caution, Do not install, Could not verify), its top reasons and one line per check; `--details` adds every finding and its advice. Quoted text is escaped and marked as untrusted

**`/guard scan`** - Lists every file of a local folder, reads and hashes each one, records symbolic links with where they land without following them, and prints a SHA-256 tree hash that pins the exact content

**`release`** - Versioning, npm publishing and GitHub releases run from CI when a version bump is merged, as in ai-instruct

---

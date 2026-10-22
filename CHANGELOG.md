# Changelog

All notable changes to ai-install-guard. Ordered newest to oldest.

---

## Unreleased

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

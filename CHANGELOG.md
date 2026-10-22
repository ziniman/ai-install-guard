# Changelog

All notable changes to ai-install-guard. Ordered newest to oldest.

---

## Unreleased

**`checks`** - A right-to-left plugin is no longer told Do not install just for defining a direction mark as a constant: a bidirectional control that is the whole of a one-line string, with nothing after it on its line but `;`, `,` or a comment, is a warning that names the escape to write instead, since it cannot reorder any code. Anywhere else, in a language the tokenizer does not know, and for tag characters, it still fails, and a file full of such constants cannot crowd out a real one

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

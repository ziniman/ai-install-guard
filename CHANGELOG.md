# Changelog

All notable changes to ai-install-guard. Ordered newest to oldest.

---

## v0.1.0 &nbsp;·&nbsp; 2026-10-22

**`pane`** - `/guard scan` opens a verdict pane: the recommendation and its reasons in a coloured banner, the counts, and every check grouped with failures first, each row opening to its evidence and advice. Approve and Reject record the decision against the exact tree hash; on Do not install or Could not verify the button reads Approve anyway and asks a second time. Details opens every row and Copy report copies the full text. Progress shows in the pane and the status line, and a toast says when the verdict is ready

**`/guard report`, `/guard list`, `/guard forget`** - Reopen the last report, list your decisions, and forget the ones about a name

**`checks`** - Deterministic checks for structure and manifest (Claude Code's own validator, binaries and disguised files, symbolic links that leave the folder, data after an image's end, bundled permission settings), mod capabilities (every hooked event and `$` call in plain language, high-risk calls, capability mismatch), classic shell hooks and their scripts, skills, commands and agents (prompt injection, credential instructions, broad `allowed-tools`, remote instructions, look-alike names, text aimed at the scanner), code patterns (hidden Unicode with tag characters decoded, execution, obfuscation, credentials with network code, persistence, install scripts, registry redirects, network addresses) and committed secrets, each with a fixture and a test

**`/guard scan`** - Prints a verdict (Safe to install, Install with caution, Do not install, Could not verify), its top reasons and one line per check; `--details` adds every finding and its advice. Quoted text is escaped and marked as untrusted

**`/guard scan`** - Lists every file of a local folder, reads and hashes each one, records symbolic links with where they land without following them, and prints a SHA-256 tree hash that pins the exact content

**`release`** - Versioning, npm publishing and GitHub releases run from CI when a version bump is merged, as in ai-instruct

---

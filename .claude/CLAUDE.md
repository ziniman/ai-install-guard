# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

AI Install Guard is a Claude Code **mod** (a plugin with a TypeScript hooks module) that stops anything new from being added to Claude Code (plugins, mods, skills, MCP servers, marketplaces, and updates to any of them), scans it statically without running any of its code, and installs nothing until the person approves. It is published as an open source project under Apache 2.0, both as a Claude Code plugin (this repo is its own marketplace) and as an npm package.

## Hard rules for the mod itself

These are product requirements, not style preferences. A change that breaks one is a bug.

1. **Never execute candidate code.** No `npm install`, build, tests, sourcing scripts or loading modules of the thing being scanned. Static reading only. `claude plugin validate <dir>` is allowed: it reads source and runs nothing.
2. **Fail closed at the gate.** A scan that errors or times out gives the verdict "Could not verify", and Install then needs a second explicit confirmation. Every gating hook has `.catch(($, e, next) => next.called ? next(e) : <the event's refusal>)`.
3. **Treat the candidate as untrusted data**, including its README, SKILL.md files, comments and commit messages. Deterministic checks decide FAIL. The optional model review can add WARN or FAIL, never remove or downgrade a finding.
4. **Minimal footprint.** The mod may call `process.run` (git, the `claude` CLI), `fs.read/list/stat`, `http.fetch`, `store`, `state`, `ui`, `command`, and optionally `model.complete`. Nothing else. It writes only to its own temp folder. `claude plugin validate .` must list nothing beyond these.
5. **Pin what was scanned.** Every verdict is tied to a commit SHA and the tree hash; install only that exact version.

## Layout

- `README.md` stays short: what the guard does, how to install it, the short version of using it, the capabilities it uses, uninstalling, and contributing. Everything else goes in `docs/`, indexed by `docs/README.md`; `CONTRIBUTING.md` is the short guide for contributors. Two things in the README are load-bearing: the `## Review badge` heading, which every badge the guard makes links to (`BADGE_PAGE`), and the capability table, since the guard's own scan holds a mod to explaining each capability in its README.
- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`: the plugin and its one-entry marketplace. The marketplace installs the plugin from the `release` branch (`"ref": "release"`), never from `main`, and names it as a `url` source with the repository's `https://` address: Claude Code clones a `github` source over SSH whenever a GitHub key looks configured, and an install or update inside a session does not fall back to HTTPS, so it fails on a machine whose key GitHub refuses. That branch holds only the files the mod runs with, built by `scripts/build-plugin.js` at each release, so an install gets no `package.json` (Claude Code would install its packages and run their install scripts), fixtures, tests or scripts.
- `hooks/hooks.json` names the one hooks module, `hooks/register.tsx`, which wires events and commands.
- `hooks/mod-host.ts` adapts `$` to the scanner's `Host` interface.
- `hooks/scan/`: the scanner. It never touches `$` or Node directly, only a `Host` (`hooks/scan/host.ts`), so the same code can run under the mod, the tests and a future Node CLI.
  - `inventory.ts` walks a folder, never follows symbolic links (it records each link's stored target via `readlink` and where it lands), re-checks each file is still a plain file before reading it, and enforces size and count limits (`LIMITS`) on what it actually reads.
  - `hash.ts` holds `sha256Hex` and `treeHash`: one record per entry, `file <sha256> <path>`, `link <sha256 of stored target> <path>`, `dir - <path>` or `other - <path>`, each ended by NUL (no path can hold one), sorted by path, hashed. A link counts by its stored target so the same tree hashes the same on every machine. Changing this format changes every stored approval. `treeHash(entries, replaced)` also gives the README badge's hash (`badgeHash` in `checks/provenance.ts`): the same records with the README counted as `withoutBadges` reads it, so a badge stays right in the commit that adds it. Approvals use the plain tree hash only.
  - `safe-text.ts` shows control and invisible characters from a candidate as `<U+XXXX>`; everything a report quotes from a candidate goes through it.
  - `remote.ts` reads a remote source (`parseRemote`), resolves its ref to one commit with `git ls-remote` (`resolveRef`, which refuses ambiguous or special names), and `fetchPinned` fetches only that commit into a `mktemp` folder, checks it out by id and asserts `HEAD` is the pin (the Plugin4Shell defence). `scanRemote` in `scan.ts` scans that folder and removes it. Tests script git through a fake host (`hooks/remote.test.ts`); never fetch in a test.
  - `github.ts` reads a GitHub source's public metadata through `Host.fetch` (repository and owner age, stars, contributors, the scanned commit's signature and whether it is on the default branch). `lookups.ts` holds the outside lookups behind the `outsideLookups` setting: OSV for packages (malware by MAL id or CWE-506) and Anthropic's official plugin list for look-alike names. Every lookup failure is an INFO row, never a failure. Tests answer the network from a table (`hooks/provenance.test.ts`).
  - `scan.ts` runs a folder scan: inventory, `checks/context.ts` (file roles, manifest, hooks modules, classic hooks, MCP servers, prompts), Claude Code's validator (`checks/validator.ts`), then every check group, sorted into the report's order. `verdict.ts` decides on red flags only: any FAIL is Do not install, any WARN is Worth a look (something specific and suspicious), otherwise No red flags; a scan error is Could not verify. What the candidate can do (shell hooks, MCP servers, network, Bash without asking, programs it starts) is never a WARN: a check reports it as INFO and lists it in its row's `access`, which the verdict gathers into its "It can" line. Quality notes (license, README, repository age) are INFO too. `report.ts` prints the text report.
  - `checks/`: one file per group (`provenance`, `structure`, `mod`, `hooks`, `mcp`, `prompts`, `code`, `secrets`, `quality`), shared regexes in `patterns.ts`, and `text.ts` (matches with line numbers, and `spanKinds`, a small tokenizer that tells code from strings, comments and regex literals). Each check returns one row built with `row()` from its evidence; the row takes the worst status any evidence carries.
  - File roles decide weight: a hooks module, a script a hook or skill names, `bin/` and other code count in full; tests and docs nothing refers to, and CI or dotfiles, are only reported (INFO). A match inside a comment or a regex literal is also only reported, so a check's own patterns do not trip it, and so is one in a string that reads as prose (`proseTest` in `checks/code.ts`: a prompt that names `eval()`), except a download piped into a shell. Prompt text is read the same way: quoted words are a mention, and a phrase that only hides something counts when its paragraph names a way out. A hook script is judged with the local modules it imports (`ctx.imports`, followed by `localImports`), so a key it reads fails only when that code can send it beyond the key's own service.
- Never put a literal invisible or bidirectional character in source: write `\u202e`, never the character. The hidden-characters check fails the guard's own source if one slips in.
  - `report.ts` formats the plain-text report.
- `hooks/gate/`: the install gates. `requests.ts` reads an install from `/plugin` arguments or from a shell command Claude is about to run (`claude plugin install`, `marketplace add`, and `claude mcp add`/`add-json`, whose server becomes the request's configuration) (`splitShell` quotes and splits like a POSIX shell, follows `sh -c`, `eval` and here-documents, and marks text only known at run time); it never throws, since it runs before every shell command. `resolve.ts` finds where Claude Code would install from, through `claude plugin list --available --json`, `claude plugin marketplace list --json` and a marketplace's own catalog file, refusing a relative source that climbs out of its marketplace or passes through a link. `gate.ts` decides: a decision already made on the same commit of the same folder answers at once, anything else is scanned and held in the pane, and what cannot be pinned is Could not verify. `writes.ts` reads Claude's Write and Edit by path first (`writePlace`: skills, commands, agents, `~/.claude/plugins`, `.mcp.json`, `.claude.json`, with `..` resolved and case ignored), then the content that would land (an Edit applied to the file as it is), and the MCP servers a configuration adds or changes; `judgeWrite` in `gate.ts` lets a prompt with no red flags through with a note and holds the rest. `shell-writes.ts` reads, from a shell command's text alone, every file it writes (redirections, `tee`, `cp`, `mv`, `install`, `ln`, `rsync`, `ditto`, `git clone` and the git subcommands that change a working tree, `curl`, `wget`, `unzip`, `tar`, `sed -i`, `dd`, `rm`), following `cd` within the command, nested shells, `eval` and substitutions; a program it does not know counts by the one-word paths it is given, and code it does not read (an interpreter's inline code, an `awk` or `sed` program that may write, a script piped into a shell, a program or path known only as it runs) is `unseen`; a script file or module an interpreter or shell runs is judged like a program, by the paths it is given, so a skill's own script runs as the skill says. `shell-change.ts` finds where each write lands (the session's folder, which `register.tsx` keeps from `session.start` and `classic.CwdChanged`, `~` and links; a folder `CLAUDE_CONFIG_DIR` names, looked up once with `claudeConfigDir`, counts as `~/.claude` for both gates) and turns the one change in a place Claude Code loads from into what `judgeShell` in `gate.ts` judges: text as a Write of it, a copied file as text that always waits, a copied folder or a clone as a scan, anything else Could not verify. More than one change, or an unseen part of a command that names Claude's folder (`NAMES_CLAUDE`), is Could not verify. A settings file (`settings.json`, `settings.local.json` under `.claude`, `managed-settings.json`) is compared before and after by `settings.ts`, which turns what the change widens or narrows into evidence; a change that widens anything is held as a report built from that evidence, pinned to the exact file. A skill is scanned as its real folder with the new file in place (`scan/overlay-host.ts`). An MCP server has no folder: its configuration is laid out as a one-file `.mcp.json` in memory (`scan/virtual-host.ts`, a host that lists and reads only those files and runs nothing) and scanned there, so its tree hash pins the approval to that exact configuration. `recheck.ts` looks the version up again when Install is pressed, because a plugin's own `$.command.run` skips its own `command.run` hook.
- `hooks/guard/`: the pane. `view.ts` turns a scan report into the compact `GuardView` the pane draws (evidence capped, quoted text made safe), `pane.tsx` draws it and handles its buttons, `decisions.ts` keeps decisions and the last report in `$.store` (capped; the store is 4 MiB in all). `run.ts` runs a scan with the pane showing it, for `/guard scan` and the gates alike. `passes.ts` keeps the one-time passes in `$.state` for an install allowed although nothing could be pinned.
- `types/index.d.ts`: the state contract (`plugin.json` names it under `types`). The pane's view is one value, `ai-install-guard.view`. Claude Code reads a state reference only from the file that uses it, so each module declares its own `atom({ plugin: 'ai-install-guard', key: 'view' } as const, null)`; never import one.
- `hooks/*.test.ts`: tests, run by `claude plugin test .`. `pane.test.ts` mounts the pane on the terminal and desktop surfaces and drives its buttons. `Text` elements keep no `key`; find them by text, and key a `Box` or `Button` when a test needs to address it.
- `hooks/test-support/`: `memfs.ts` serves fixtures to the engine's `fs.*` and `process.run` events; `fixtures.gen.ts` is generated.
- `fixtures/<name>/`: inert sample plugins, one per rule, listed with the rule each trips in `fixtures/README.md`. Never installed, loaded or run. `hooks/checks.test.ts` holds the table of what each fixture must trip.
- `scripts/`: `sync-versions.js` (release), `build-fixtures.js` (tests), `build-skill.js` (the chat skill), `badge.js`, which keeps the README's own AI Install Guard badge for the files git would commit (`--check` in CI), `build-plugin.js`, which builds the plugin as it ships from a commit's stored files (`SHIPS` and `LEFT_OUT`; keep them in step with `files` in `package.json`, less the marketplace): `--out <folder>` for CI, which validates and scans it, and `--release <sha>` for the release workflow, which commits it onto the `release` branch through GitHub's API (`gh api` with the workflow's token), so GitHub signs the commit and a scan of an install shows it verified, and `benchmark.js`, which scans every plugin a marketplace ships in its own folder with the built chat skill and counts verdicts. CI runs it on Anthropic's official marketplace at `OFFICIAL_MARKETPLACE_SHA` in `ci.yml` and fails above `OFFICIAL_MAX_RED` Do not install or `OFFICIAL_MAX_LOOK` Worth a look. Those plugins are well made, so a flag there is most likely a false positive: fix the check, and move the pin and limits only on purpose, after reading the new flags.
- `cli/`: the scanner outside Claude Code, for the chat skill. `node-host.ts` is a `Host` on `node:fs`, `node:child_process` (it starts only `git`, `sh`, `mktemp`, `rm` and PowerShell, never passes on an inherited `GIT_` variable, and fails a command whose output passes 4 MiB rather than cut it) and Node's `fetch`; `unzip.ts` unpacks a zip into a new folder (every path checked before a byte is written, links made last, the scanner's limits enforced); `scan.ts` is the command line, `scan.js <folder | zip | repository>`, exiting with the verdict. `scan.spec.mjs` runs the built script on the fixtures and on zips of them with `node:test` (`npm run test:skill`); it reads the fixture table from `hooks/checks.test.ts`, so keep its `{ fixture: '…', flags: […], verdict: '…' }` rows on one line each. It has its own `tsconfig.json`, with Node's types, which the mod never gets.
- `skill/ai-install-guard/`: the Agent Skill for Claude chat. `SKILL.md` and `README.md` are source; `scripts/scan.js` (the esbuild bundle of `cli/scan.ts`) and `LICENSE` are build output and gitignored, and `npm run build:skill` zips the folder to `dist/ai-install-guard-skill.zip` with fixed times and no compression (each zlib deflates differently), so the same sources give the same zip on any machine. None of it ships in the npm package.

## The mod runtime

A hooks module runs in its own environment: no DOM, no Node, no timers, no `eval`, no `import()`. Everything outside it goes through `$`. Globals available include `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `URL` and `crypto.subtle.digest`. JSX compiles against the global `h`, and elements come from `$.ui.resolve(e)`.

The scan runs inside the `/guard` command's hook (its 10 s budget counts the hook's own time, never `$` calls), updating the pane's state between stages; `$.clock` is not used, as it is not in the allowed capabilities.

The API is early access and moves between releases. The declaration file is the authority: the engine lays it at `.claude-plugin/types/claude-code/index.d.ts` when it loads the mod from a folder it watches (an interactive `claude --plugin-dir .`). That folder is gitignored. Grep it for every event and `$` call before using one.

Hooks on `$` calls (`fs.read`, `process.run`, ...) answer `{ value }` or `{ deny }`, not the bare result. Tests stand in for `$.store` with `mock.store(on)` and for the pane's `ui.*` calls with `serveUi(on)` from `hooks/test-support/memfs.ts`.

## Commands

```sh
npm run validate        # claude plugin validate --strict .
npm run typecheck       # tsc -p . (needs .claude-plugin/types, see above) and tsc -p cli
npm test                # claude plugin test .
npm run test:skill      # build the chat skill and run cli/scan.spec.mjs
npm run check           # all four
npm run build:fixtures  # regenerate hooks/test-support/fixtures.gen.ts after editing fixtures/
npm run build:skill     # skill/ai-install-guard/scripts/scan.js and dist/ai-install-guard-skill.zip
npm run benchmark -- <marketplace folder>  # verdict counts over a marketplace's own plugins (build:skill first)
npm run badge           # build the scanner, scan what git would commit, rewrite the README badge
```

Run all four checks after every change and report their results. `npm ci --ignore-scripts` installs what the build needs (esbuild, Node's types) without running any package's install script.

Try the mod in a real session:

```sh
claude -p "/guard scan fixtures/clean-plugin" --plugin-dir .   # headless, one command
claude --plugin-dir .                                           # interactive, hot-reloads on save
```

### Tests

`claude plugin test` runs tests with no file system, network or processes: `$.fs.read` and friends have no implementation beneath the plugin unless the test supplies one. So fixtures live on disk in `fixtures/` for people to read, and `npm run build:fixtures` packs them (base64, links kept as links) into `hooks/test-support/fixtures.gen.ts`. Tests mount one with `serveFixture(on, root, files)`, or call scanner functions directly with `memoryHost(root, files)`. Reading through a symbolic link in the memory host throws, so a test fails if the scanner ever follows one. CI fails if `fixtures.gen.ts` is out of date.

Every check needs a fixture that trips exactly that rule and a passing test. Name fixture test files anything but `*.test.ts`, or the test runner will pick them up.

## Git workflow

**All changes go through pull requests. Never commit or push directly to `main`.**

1. Branch off the latest `main`: `git checkout main && git pull && git checkout -b <type>/<short-description>` (e.g. `feat/verdict-pane`, `fix/symlink-loop`).
2. Commit in focused, logical steps.
3. Before opening the PR, run `npm run check` and a local Qodo review (the `qodo-review` skill), and address what it finds. Then, as the very last step before every push (Qodo fix pushes included), run `npm run badge` and commit `README.md` with the rest: the README badge names the content it was scanned at, so any change makes it stale, and CI fails a PR whose badge is not for its own files. Behind `main`, sync first and run it again.
4. Push and open the PR with `gh pr create`. `gh` is logged in as the owner's own account, so the PR is authored by a person and the Qodo bot reviews it.
5. Work the Qodo review to completion with the `qodo-review-resolver` skill: fix each finding (or dismiss it with a reason), push the fixes as `Address Qodo review: <what changed>` commits, then comment `/agentic_review` on the PR (`gh pr comment <n> --body /agentic_review`) so Qodo reviews the new head; pushing alone does not trigger it. Repeat until the review is clean at the head commit.
6. Do not merge. The owner merges.

### Commit messages

- No `Co-Authored-By` trailer or any other tool attribution, in commits or PR bodies.
- No em dashes anywhere in the message.
- The body explains why, not just what.

## Release process

Same as ai-instruct. Publishing to npm, tagging and the GitHub release all happen in CI when a PR that bumps the version is merged. Never run `npm publish` locally.

1. **Bump the version in the same PR** (skip for changes that should not ship, such as README or CI tweaks): `npm version patch` (or `minor` / `major`). `.npmrc` sets `git-tag-version=false`, so this only edits files: the `version` hook runs `scripts/sync-versions.js`, which writes the version to `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and stages them.
2. **Add a `## vX.Y.Z &nbsp;·&nbsp; YYYY-MM-DD` entry** at the top of `CHANGELOG.md` (rename `## Unreleased` when it holds the changes) and commit everything.
3. **Open the PR.** `.github/workflows/ci.yml` checks that the fixtures module and plugin versions are in sync, validates and tests the mod, and, if the version changed, that it is not on npm yet and has a CHANGELOG entry. The job summary says whether merging will publish.
4. **Merge.** `.github/workflows/release.yml` runs on every push to `main`. It finds the commit on `main` that set the current version (the PR's merge commit) and builds the release from that commit, even on a later push: if the version is not on npm yet it runs `npm publish` there, and if the `vX.Y.Z` tag or GitHub release is missing it creates them at that commit, titled `vX.Y.Z - <PR title>` with the CHANGELOG entry as notes. It also builds the plugin as it ships from that commit and adds it to the `release` branch, one commit per version, unless that version is already there. So the package, the tag and the plugin always name the same files, and a re-run repairs a half-finished release. To ship different files, bump the version. The marketplace's catalog is read from `main`, but the plugin installs from the `release` branch, so a merge without a version bump reaches nobody's install.

`0.0.0` is the unreleased placeholder: CI and the release workflow never publish it.

npm auth uses [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC): no `NPM_TOKEN` secret and no 2FA prompt. The trusted publisher is configured on npmjs.com under the package settings: GitHub Actions, repo `ziniman/ai-install-guard`, workflow `release.yml`, with `npm publish` among its allowed actions. Renaming the workflow file breaks publishing until that setting is updated. Once CI has published, the package's Publishing access is set to "Require two-factor authentication and disallow tokens", so only the trusted publisher can publish.

**Never bump the version by hand-editing `package.json`.** It skips the sync hook, and CI fails on mismatched plugin versions.

## Changelog

Update `CHANGELOG.md` with every change to behaviour, checks, commands or plugin metadata. Skip typo fixes, formatting and version-bump-only commits. One bold entry per changed area:

```markdown
## vX.Y.Z &nbsp;·&nbsp; YYYY-MM-DD

**`/guard scan`** - One line on what changed and why it matters
```

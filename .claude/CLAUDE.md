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

- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`: the plugin and its one-entry marketplace (source `./`).
- `hooks/hooks.json` names the one hooks module, `hooks/register.tsx`, which wires events and commands.
- `hooks/mod-host.ts` adapts `$` to the scanner's `Host` interface.
- `hooks/scan/`: the scanner. It never touches `$` or Node directly, only a `Host` (`hooks/scan/host.ts`), so the same code can run under the mod, the tests and a future Node CLI.
  - `inventory.ts` walks a folder, never follows symbolic links, reads and hashes every file, and enforces size and count limits (`LIMITS`).
  - `hash.ts` holds `sha256Hex` and `treeHash`: one line per entry, `file <sha256> <path>` or `link <sha256 of target> <path>`, sorted by path, joined with `\n`, hashed. Changing this format changes every stored approval.
  - `report.ts` formats the plain-text report.
- `hooks/*.test.ts`: tests, run by `claude plugin test .`.
- `hooks/test-support/`: `memfs.ts` serves fixtures to the engine's `fs.*` and `process.run` events; `fixtures.gen.ts` is generated.
- `fixtures/<name>/`: inert sample plugins, one per rule. Never installed, loaded or run.
- `scripts/`: `sync-versions.js` (release) and `build-fixtures.js` (tests).

## The mod runtime

A hooks module runs in its own environment: no DOM, no Node, no timers, no `eval`, no `import()`. Everything outside it goes through `$`. Globals available include `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `URL` and `crypto.subtle.digest`. JSX compiles against the global `h`, and elements come from `$.ui.resolve(e)`.

The API is early access and moves between releases. The declaration file is the authority: the engine lays it at `.claude-plugin/types/claude-code/index.d.ts` when it loads the mod from a folder it watches (an interactive `claude --plugin-dir .`). That folder is gitignored. Grep it for every event and `$` call before using one.

Hooks on `$` calls (`fs.read`, `process.run`, ...) answer `{ value }` or `{ deny }`, not the bare result.

## Commands

```sh
npm run validate        # claude plugin validate --strict .
npm run typecheck       # tsc -p . (needs .claude-plugin/types, see above)
npm test                # claude plugin test .
npm run check           # all three
npm run build:fixtures  # regenerate hooks/test-support/fixtures.gen.ts after editing fixtures/
```

Run all three checks after every change and report their results.

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
3. Before opening the PR, run `npm run check` and a local Qodo review (the `qodo-review` skill), and address what it finds.
4. Push and open the PR with `gh pr create`. `gh` is logged in as the owner's own account, so the PR is authored by a person and the Qodo bot reviews it.
5. Work the Qodo review to completion with the `qodo-review-resolver` skill: fix each finding (or dismiss it with a reason), push the fixes as `Address Qodo review: <what changed>` commits, and repeat until the review is clean at the head commit.
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
4. **Merge.** `.github/workflows/release.yml` runs on every push to `main`. If the version is not on npm yet, it runs `npm publish`, then creates the `vX.Y.Z` tag and a GitHub release titled `vX.Y.Z - <PR title>` with the CHANGELOG entry as notes. The plugin marketplace reads `main` directly, so it updates on merge either way.

`0.0.0` is the unreleased placeholder: CI and the release workflow never publish it.

npm auth uses [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC): no `NPM_TOKEN` secret and no 2FA prompt. The trusted publisher is configured on npmjs.com under the package settings: GitHub Actions, repo `ziniman/ai-install-guard`, workflow `release.yml`. Renaming the workflow file breaks publishing until that setting is updated.

**Never bump the version by hand-editing `package.json`.** It skips the sync hook, and CI fails on mismatched plugin versions.

## Changelog

Update `CHANGELOG.md` with every change to behaviour, checks, commands or plugin metadata. Skip typo fixes, formatting and version-bump-only commits. One bold entry per changed area:

```markdown
## vX.Y.Z &nbsp;·&nbsp; YYYY-MM-DD

**`/guard scan`** - One line on what changed and why it matters
```

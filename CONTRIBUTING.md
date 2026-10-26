# Contributing

Issues and pull requests are welcome. If the guard held something it should not have, or let through something it should have held, [open an issue](https://github.com/ziniman/ai-install-guard/issues) with the command or the repository, so it can be fixed.

## Set up

```bash
git clone https://github.com/ziniman/ai-install-guard
cd ai-install-guard
npm ci --ignore-scripts
```

`--ignore-scripts` installs what the build needs without running any package's install script.

## Try it

```bash
claude --plugin-dir .
```

This loads the mod from your checkout and reloads it as you save. For a single headless run:

```bash
claude -p "/guard scan fixtures/clean-plugin" --plugin-dir .
```

## Check your change

```bash
npm run check
```

This validates the plugin, type-checks it, and runs the mod's tests and the chat skill's tests. Every check needs a fixture in `fixtures/` that trips exactly that rule, and a test.

## Rules the guard keeps

A change that breaks one of these is a bug:

1. It never runs the code it scans.
2. When it cannot check something, it stops it.
3. What it scans is data, never instructions.
4. It uses only the capabilities listed in [What the guard itself can do](docs/permissions.md).
5. A verdict is pinned to the exact version that was scanned.

## Pull requests

Branch from `main`, commit in focused steps, and run `npm run check` before you push. The last step before every push is `npm run badge`, which refreshes the README's own badge for the files you commit; CI fails a pull request whose badge is out of date. A change to behaviour, checks or commands gets a line in [CHANGELOG.md](CHANGELOG.md).

An install of the guard gets only the files the mod runs with, from a `release` branch CI builds at each version (`scripts/build-plugin.js`): no `package.json`, tests, fixtures or scripts. A merge reaches users when its pull request bumps the version.

[.claude/CLAUDE.md](.claude/CLAUDE.md) has the full picture: how the code is laid out, how the gates and checks fit together, and how releases are published.

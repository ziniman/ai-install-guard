# Uninstall, turn off, and troubleshooting

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

[Back to the documentation](README.md)

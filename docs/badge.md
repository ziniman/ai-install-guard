# Review badge

If you publish a plugin, mod, skill or MCP server, you can show that it was scanned. Scan your own repository, then run `/guard badge` or press **Copy badge** (`b`) in the pane (outside Claude Code, add `--badge` to the [command-line scanner](claude-chat.md)), and paste the result near the top of your README:

```markdown
[![AI Install Guard: No red flags at 56a8fc7e979d](https://img.shields.io/badge/AI_Install_Guard-no_red_flags_%C2%B7_56a8fc7e979d-2ea44f)](https://github.com/ziniman/ai-install-guard#review-badge "Scanned content sha256:56a8fc7e…, read without this badge")
```

The badge says two things: the verdict (green for **No red flags**, yellow for **Worth a look**) and the content that was scanned, a hash of every file with the README read without its AI Install Guard badge. That is why it names content and not a commit: committing the badge makes a new commit, so a badge naming a commit could never be right for the commit that holds it. Pasting the badge, moving it or replacing an older one leaves the hash as it was, so the badge is right in the commit that adds it, and any other change makes it a badge for an earlier version. Hovering over it shows the full hash. There is no badge for **Do not install** or **Could not verify**. Badges made before 0.4.4 name a commit or a tree hash, and badges made before 0.4.0 say Safe to install or Review what it can do; they still count as what they name.

A badge is a picture anyone can paste, so the guard never trusts one:

- **When you see one:** scan the repository yourself with `/guard scan owner/repo`, adding `--path <folder>` when the badge names a folder. The report says whether the badge is for the version you scanned. Your own scan is what counts.
- **When the guard meets one:** a README badge that claims a better verdict than the guard's own scan is a warning, saying the badge is outdated or, when it names this very version, was never earned. A badge whose verdict the scan agrees with is only noted, with a second line when it was made for other content (an earlier version, or the whole repository when only part of it is installed). It never lifts a verdict.
- **When the code changes:** the badge still names the old content. A new version needs a new scan and a new badge. To keep yours current, make the badge the last step of each change; this repository does it in every pull request with [`scripts/badge.js`](https://github.com/ziniman/ai-install-guard/blob/main/scripts/badge.js), and its CI fails when the badge is not for the pull request's own files.

[Back to the documentation](README.md)

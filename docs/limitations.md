# What it is not

- **Not a proof of safety.** Static analysis raises the bar and makes every capability visible; a determined attacker can still evade it.
- **Install it first.** It judges only mods that load after it. For a company, the strongest setup is deploying it through managed settings so it loads first.
- **No per-plugin block for classic shell hooks.** Claude Code runs them outside mods, so the guard cannot stop one once its plugin is installed. Its protection is the scan before install: a plugin you reject is never installed.
- **The `/plugin` menu is not gated yet.** A plugin picked from the menu installs without a scan; the guard says so when the menu opens. The mod loading gate in a later stage closes this. Until then, install with `/plugin install <name>@<marketplace>`.
- **Claude's commands are read, not run.** The guard finds an install in a shell command however it is quoted or wrapped (`env`, `sudo`, `sh -c`, `eval`, a here-document), and holds a command it cannot read (one built while it runs, a script piped into a shell, inline code for another language) as Could not verify. It finds the files a command writes the same way, through the programs it knows; a program that writes into Claude's folders on its own, without being given the path (an installer script, a package run with `npx`), is not seen. A script file that installs something is not read; the mod loading, skill and session-start gates are the backstop for that.
- **Between Install and the install itself** Claude Code fetches the plugin again. The guard checks the commit just before, and a commit is fixed content, but a marketplace that names a branch rather than a commit can move in that moment. The scan warns about such marketplaces.

[Back to the documentation](README.md)

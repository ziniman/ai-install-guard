# Commands and the pane

| Command | What it does |
|---------|--------------|
| `/guard scan <path>` | Scan a local folder without installing it and open the verdict pane |
| `/guard scan <repository>` | Fetch one commit of a repository into the guard's own temporary folder, scan it and remove it. Takes `https://host/owner/repo`, a GitHub `…/tree/<ref>/<folder>` link, `github:owner/repo` or `owner/repo`, with an optional `@ref` |
| `/guard scan --ref <ref> --path <folder> <repository>` | Scan a branch, tag or full commit id (the default branch otherwise), and a folder inside the repository |
| `/guard scan --details …` | Any of the above, and print the full report with every finding and its advice |
| `/guard report` | Reopen the last report |
| `/guard badge` | A README badge for the last scan, when it was No red flags or Worth a look (see [Review badge](badge.md)) |
| `/guard list` | Your approved and rejected versions, newest first |
| `/guard held` | The mods kept from loading in this session, and the next one undecided in the pane (see [Loading mods](gates.md#loading-mods)) |
| `/guard forget <name>` | Forget decisions about a name, so it is judged again |

A remote scan resolves the ref to one commit, fetches only that commit (no hooks, submodules, Git LFS downloads or filters), checks it out by its id and confirms that `HEAD` is that commit before reading a file. The report and the pane name the commit, and your decision is recorded against it and the tree hash.

Each row opens to say what it found in plain words first: which programs the candidate starts and what each is for, which secrets its code reads, and what is worth a closer look. The code lines that back it up sit behind **Show the code**.

In the pane, **Approve** (`i`) and **Reject** (`r`) record your decision for that exact content (its tree hash); for an install the guard is holding, the button reads **Install**. When the verdict is Do not install or Could not verify, the button reads **Approve anyway** (or **Install anyway**) and asks a second time. **Details** (`d`) opens every row, and **Copy report** (`c`) copies the full report as text. Where no pane can show (a headless `claude -p` run), `/guard scan` prints the report instead.

[Back to the documentation](README.md)

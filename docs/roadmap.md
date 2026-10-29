# Roadmap

1. [x] Skeleton mod: `/guard scan <path>` lists and hashes a local folder
2. [x] Checks for structure, mod capabilities, classic hooks, skills, code patterns and committed secrets
3. [x] The verdict pane with Install and Reject
4. [x] Remote fetch pinned to a commit, repository provenance, MCP server checks, and optional lookups against OSV and the official plugin list
5. [x] Gates on `/plugin install`, `/plugin marketplace add` and Claude's own `claude plugin` installs, with approvals pinned to a commit
6. [x] Gate on Claude adding MCP servers with `claude mcp add`
7. [x] Gate on Claude writing skills, commands, agents, MCP configuration and installed plugins' files
8. [x] Gate on Claude changing settings
9. [x] Gate on Claude's shell writes, copies, clones and downloads into skill, plugin and configuration folders
10. [x] Mod load gate: a mod loads only when its files are a version you approved
11. [ ] Skill gate on first use, and session-start reconciliation
12. [ ] Update diffs and the optional model review
13. [x] Documentation

[Back to the documentation](README.md)

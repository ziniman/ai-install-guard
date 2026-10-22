# Fixtures

Inert sample plugins for AI Install Guard's tests. Each one is built to trip
one rule (`clean-plugin` trips none). They are data: nothing here is
installed, loaded or run, and several deliberately contain patterns that look
malicious, such as shell hooks that call `curl`, a link toward an SSH key,
prompt injection and AWS's documented example keys. None of the keys or
addresses are real.

The tests cannot read the disk, so `npm run build:fixtures` packs this folder
into `hooks/test-support/fixtures.gen.ts`. Rebuild and commit that file
whenever a fixture changes; CI fails if it is out of date.

| Fixture | Trips | Expected verdict |
|---------|-------|------------------|
| `clean-plugin` | nothing | Safe to install |
| `no-license` | `provenance.license` | Install with caution |
| `invalid-manifest` | `structure.manifest` | Do not install |
| `binary-in-skill` | `structure.files` | Do not install |
| `symlink-outside` | `structure.links` | Do not install |
| `png-trailing` | `structure.images` | Do not install |
| `settings-bypass` | `structure.settings` | Do not install |
| `mod-process-run` | `mod.high-risk` | Do not install |
| `mod-theme-mismatch` | `mod.mismatch` (and `mod.high-risk`, which a mismatch needs) | Do not install |
| `mod-http-fetch` | `mod.medium-risk` | Install with caution |
| `curl-hook` | `hooks.commands` | Do not install |
| `hook-auto-approve` | `hooks.auto-approve` (its shell hook is also a warning) | Do not install |
| `skill-hidden-tags` | `code.hidden-characters` | Do not install |
| `skill-injection` | `prompts.injection` | Do not install |
| `skill-credentials` | `prompts.credentials` | Do not install |
| `skill-bash-wildcard` | `prompts.tools` | Do not install |
| `skill-remote-instructions` | `prompts.remote` | Install with caution |
| `command-name-collision` | `prompts.names` | Install with caution |
| `scanner-pass-readme` | `prompts.scanner`, and its `curl` hook still fails | Do not install |
| `script-exec` | `code.execution` | Install with caution |
| `obfuscated-blob` | `code.obfuscation` | Install with caution |
| `cred-exfil` | `code.credentials` | Do not install |
| `persistence-rc` | `code.persistence` | Do not install |
| `postinstall` | `code.install-scripts` | Do not install |
| `npmrc-registry` | `code.registries` | Install with caution |
| `aws-key` | `secrets.keys` | Do not install |
| `env-file` | `secrets.env-files` | Do not install |
| `mcp-npx` | `mcp.launch` (an MCP server started with an unpinned `npx -y`) | Install with caution |
| `mcp-curl` | `mcp.launch` (an MCP server that downloads a script and runs it), and `mcp.remote` for the address in its script | Do not install |
| `lfs-pointer` | `structure.fetched` (a command stored as a Git LFS pointer; it has no `.gitattributes`, which would apply the filter to this repository) | Do not install |
| `mcp-remote-secret` | `mcp.credentials` (an Anthropic key sent to another host), and `mcp.remote` | Do not install |

Name nothing here `*.test.ts`: the test runner would pick it up.

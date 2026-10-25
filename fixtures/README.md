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

Only red flags change the verdict. A fixture whose rule is a capability or a
quality note shows it instead: as a line of the verdict's "It can", or as a
note on its row.

| Fixture | Trips | Expected verdict |
|---------|-------|------------------|
| `clean-plugin` | nothing | No red flags |
| `no-license` | `provenance.license`, as a note | No red flags |
| `invalid-manifest` | `structure.manifest` | Do not install |
| `binary-in-skill` | `structure.files` | Do not install |
| `symlink-outside` | `structure.links` | Do not install |
| `png-trailing` | `structure.images` | Do not install |
| `settings-bypass` | `structure.settings` | Do not install |
| `mod-process-run` | `mod.high-risk` (it runs programs and its README does not say why) | Worth a look |
| `mod-theme-mismatch` | `mod.mismatch` (and `mod.high-risk`, which a mismatch needs) | Do not install |
| `mod-http-fetch` | `mod.medium-risk`, as "It can: send requests over the network" | No red flags |
| `curl-hook` | `hooks.commands` | Do not install |
| `hook-auto-approve` | `hooks.auto-approve` (its shell hook shows as "It can: run shell commands …") | Do not install |
| `skill-hidden-tags` | `code.hidden-characters` | Do not install |
| `rtl-direction-mark` | `code.hidden-characters` as a note (direction marks written raw as the whole of a string, as a right-to-left plugin might define them) | No red flags |
| `bidi-before-code` | `code.hidden-characters` (a bidirectional control in a string with code after it on the same line, which can display out of order) | Do not install |
| `skill-injection` | `prompts.injection` | Do not install |
| `skill-credentials` | `prompts.credentials` | Do not install |
| `skill-bash-wildcard` | `prompts.tools`, as "It can: run any shell command without asking, in the build skill" | No red flags |
| `skill-remote-instructions` | `prompts.remote` | Worth a look |
| `command-name-collision` | `prompts.names`, as a note (Claude Code's own `/help` keeps the bare name) | No red flags |
| `scanner-pass-readme` | `prompts.scanner`, and its `curl` hook still fails | Do not install |
| `script-exec` | `code.execution`, as "It can: start git" | No red flags |
| `obfuscated-blob` | `code.obfuscation` | Worth a look |
| `cred-exfil` | `code.credentials` | Do not install |
| `persistence-rc` | `code.persistence` | Do not install |
| `postinstall` | `code.install-scripts` | Do not install |
| `npmrc-registry` | `code.registries` | Worth a look |
| `aws-key` | `secrets.keys` | Worth a look |
| `env-file` | `secrets.env-files` | Worth a look |
| `mcp-npx` | `mcp.launch` (an MCP server started with an unpinned `npx -y`) | Worth a look |
| `mcp-curl` | `mcp.launch` (an MCP server that downloads a script and runs it); the address in its script is a note | Do not install |
| `lfs-pointer` | `structure.fetched` (a command stored as a Git LFS pointer; it has no `.gitattributes`, which would apply the filter to this repository) | Do not install |
| `mcp-remote-secret` | `mcp.credentials` (an Anthropic key sent to another host) | Do not install |
| `benign-mentions` | nothing: a review plugin that quotes an injection phrase, names its key in a `.env` example and a docstring, runs `npx tsc`, lists key file names never to send, and sends its Anthropic key only to Anthropic (shown as "It can: use your ANTHROPIC_API_KEY with api.anthropic.com") | No red flags |

Name nothing here `*.test.ts`: the test runner would pick it up.

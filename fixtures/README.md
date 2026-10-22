# Fixtures

Inert sample plugins for AI Install Guard's tests. Each one is built to trip
exactly one rule (`clean-plugin` trips none). They are data: nothing here is
installed, loaded or run, and some deliberately contain patterns that look
malicious, such as fake keys and shell hooks that call `curl`.

The tests cannot read the disk, so `npm run build:fixtures` packs this folder
into `hooks/test-support/fixtures.gen.ts`. Rebuild and commit that file
whenever a fixture changes; CI fails if it is out of date.

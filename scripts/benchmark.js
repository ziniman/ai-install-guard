#!/usr/bin/env node

'use strict';

// Scans every plugin a marketplace ships in its own folder (sources that
// start with ./) with the chat skill's built scanner, and prints how many
// land on each verdict and what each flag was. Plugins that are well made
// and trusted should come out with no red flags; this is how to tell
// whether a change to the checks made them noisier.
//
//   node scripts/benchmark.js <marketplace folder> [--max-red N] [--max-look N] [--json <file>]
//
// With --max-red or --max-look it exits 1 when more plugins than that are
// Do not install or Worth a look. Run `npm run build:skill` first.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCANNER = path.join(REPO_ROOT, 'skill', 'ai-install-guard', 'scripts', 'scan.js');
const ORDER = ['No red flags', 'Worth a look', 'Do not install', 'Could not verify'];

function usage(message) {
  if (message) console.error(message);
  console.error('usage: node scripts/benchmark.js <marketplace folder> [--max-red N] [--max-look N] [--json <file>]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { folder: undefined, maxRed: undefined, maxLook: undefined, json: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[(i += 1)];
      if (next === undefined) usage(`${arg} needs a value`);
      return next;
    };
    const count = () => {
      const text = value();
      if (!/^\d+$/.test(text)) usage(`${arg} needs a whole number`);
      return Number(text);
    };
    if (arg === '--max-red') args.maxRed = count();
    else if (arg === '--max-look') args.maxLook = count();
    else if (arg === '--json') args.json = value();
    else if (arg.startsWith('--')) usage(`unknown option ${arg}`);
    else if (args.folder === undefined) args.folder = arg;
    else usage(`unexpected argument ${arg}`);
  }
  if (args.folder === undefined) usage();
  return args;
}

/** The plugin folders a marketplace lists by relative path, in its order. */
function localPlugins(folder) {
  const manifest = path.join(folder, '.claude-plugin', 'marketplace.json');
  const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const root = fs.realpathSync(folder);
  const out = [];
  for (const plugin of Array.isArray(parsed.plugins) ? parsed.plugins : []) {
    if (typeof plugin.source !== 'string' || !plugin.source.startsWith('./')) continue;
    const dir = path.resolve(root, plugin.source);
    // Only folders inside the marketplace, as Claude Code itself allows.
    if (dir !== root && !dir.startsWith(root + path.sep)) continue;
    if (fs.existsSync(dir) && fs.lstatSync(dir).isDirectory()) out.push({ name: String(plugin.name), dir });
  }
  return out;
}

function scan(dir) {
  const run = spawnSync(process.execPath, [SCANNER, '--json', '--', dir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try {
    return JSON.parse(run.stdout);
  } catch {
    return { verdict: { recommendation: 'Could not verify', reasons: [(run.stderr || 'no output').trim().slice(0, 200)] }, results: [] };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(SCANNER)) usage(`${path.relative(REPO_ROOT, SCANNER)} is missing: run npm run build:skill first`);
  const plugins = localPlugins(args.folder);
  if (plugins.length === 0) usage(`no plugins with a ./ source in ${args.folder}`);

  const rows = plugins.map(plugin => {
    const report = scan(plugin.dir);
    const flags = [];
    for (const result of report.results ?? []) {
      for (const item of result.evidence ?? []) {
        if (item.status !== 'fail' && item.status !== 'warn') continue;
        const where = item.file === '-' ? '' : ` ${item.file}${item.line ? `:${item.line}` : ''}`;
        flags.push(`${item.status === 'fail' ? 'red flag' : 'look'}  ${result.id}${where}  ${item.excerpt}`);
      }
    }
    return { name: plugin.name, verdict: report.verdict?.recommendation ?? 'Could not verify', reasons: report.verdict?.reasons ?? [], flags };
  });

  const counts = Object.fromEntries(ORDER.map(verdict => [verdict, rows.filter(row => row.verdict === verdict).length]));
  console.log(`${rows.length} plugins: ${ORDER.map(verdict => `${counts[verdict]} ${verdict}`).join(', ')}`);
  for (const verdict of ORDER.slice(1)) {
    for (const row of rows.filter(entry => entry.verdict === verdict)) {
      console.log(`\n${row.name}: ${verdict}`);
      for (const line of row.flags.length > 0 ? row.flags : row.reasons) console.log(`  ${line}`);
    }
  }
  if (args.json !== undefined) fs.writeFileSync(args.json, `${JSON.stringify({ counts, plugins: rows }, null, 2)}\n`);

  const over = [];
  if (args.maxRed !== undefined && counts['Do not install'] > args.maxRed) over.push(`${counts['Do not install']} Do not install (at most ${args.maxRed})`);
  if (args.maxLook !== undefined && counts['Worth a look'] > args.maxLook) over.push(`${counts['Worth a look']} Worth a look (at most ${args.maxLook})`);
  if (counts['Could not verify'] > 0) over.push(`${counts['Could not verify']} Could not verify`);
  if (over.length > 0) {
    console.error(`\nMore flags than expected: ${over.join('; ')}`);
    process.exit(1);
  }
}

main();

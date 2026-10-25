#!/usr/bin/env node

'use strict';

// Keeps the README's AI Install Guard badge for the version that holds it.
// The badge names the content it was scanned at, with the README read
// without the badge, so it stays right in the commit that adds it, and only
// until anything else changes: every PR refreshes it, and CI checks it.
//
//   node scripts/badge.js          rewrite the badge in README.md for these files
//   node scripts/badge.js --check  exit 1 when the badge is not for these files
//
// "These files" are the ones git would commit: tracked files and new ones
// git does not ignore, as they are on disk now. They are copied (links as
// links) into a temporary folder and scanned there by this repository's own
// built scanner, so run `npm run build:skill` first.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCANNER = path.join(REPO_ROOT, 'skill', 'ai-install-guard', 'scripts', 'scan.js');
const README = path.join(REPO_ROOT, 'README.md');
/** The README's badge line, as /guard badge and --badge write it. */
const BADGE_LINE = /^\[!\[AI Install Guard: [^\n]*\]\(https:\/\/img\.shields\.io\/badge\/AI_Install_Guard-[^\n]*$/m;

function fail(message) {
  console.error(`badge: ${message}`);
  process.exit(1);
}

/** The paths git would commit, relative to the repository root. */
function committable() {
  const run = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (run.status !== 0) fail(`git ls-files failed: ${run.stderr.trim()}`);
  return [...new Set(run.stdout.split('\0').filter(Boolean))];
}

/** Copies those paths into a new temporary folder: a link stays a link, never followed. */
function copyTree(paths) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-install-guard-badge-'));
  for (const rel of paths) {
    const from = path.join(REPO_ROOT, rel);
    let stat;
    try {
      stat = fs.lstatSync(from);
    } catch {
      continue; // Deleted from disk, so it will not be committed either.
    }
    const to = path.join(root, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else if (stat.isFile()) fs.copyFileSync(from, to);
  }
  return root;
}

function scan(root) {
  const run = spawnSync(process.execPath, [SCANNER, '--json', '--badge', '--', root], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try {
    return JSON.parse(run.stdout);
  } catch {
    return fail(`the scanner gave no report: ${(run.stderr || run.stdout || '').trim().slice(0, 300)}`);
  }
}

function main() {
  const check = process.argv.includes('--check');
  if (!fs.existsSync(SCANNER)) fail(`${path.relative(REPO_ROOT, SCANNER)} is missing: run npm run build:skill first`);
  const readme = fs.readFileSync(README, 'utf8');
  const current = BADGE_LINE.exec(readme)?.[0];
  if (current === undefined) fail('README.md has no AI Install Guard badge line to keep current');

  const root = copyTree(committable());
  let report;
  try {
    report = scan(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const verdict = report.verdict?.recommendation ?? 'Could not verify';
  if (report.badge === undefined || report.badge.refusal !== undefined) fail(`no badge for these files (${verdict}): ${report.badge?.refusal ?? 'the scan gave none'}`);
  const wanted = report.badge.markdown;

  if (current === wanted) {
    console.log(`badge: the README badge is for these files (${verdict}, content ${report.badge.pin}).`);
    return;
  }
  if (check) {
    const named = /no_red_flags_%C2%B7_([0-9a-f]+)|worth_a_look_%C2%B7_([0-9a-f]+)/.exec(current);
    fail(`the README badge names ${named?.[1] ?? named?.[2] ?? 'another version'}, but these files are ${verdict} at content ${report.badge.pin}. Run npm run build:skill and npm run badge, then commit README.md.`);
  }
  fs.writeFileSync(README, readme.replace(current, () => wanted));
  console.log(`badge: README badge updated to ${verdict} at content ${report.badge.pin}. Commit README.md with the rest.`);
}

main();

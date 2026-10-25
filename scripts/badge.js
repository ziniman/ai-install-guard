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
/** The README's badge lines, as /guard badge and --badge write them. */
const BADGE_LINES = /^\[!\[AI Install Guard: [^\n]*\]\(https:\/\/img\.shields\.io\/badge\/AI_Install_Guard-[^\n]*$/gm;
/** Any AI Install Guard badge image, in whatever form. */
const BADGE_IMAGE = /img\.shields\.io\/badge\/AI(?:_|%20| )Install(?:_|%20| )Guard-/gi;

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

/** The paths git reports with `args` (`--cached` for staged changes, none for unstaged). */
function changed(...args) {
  const run = spawnSync('git', ['diff', '--name-only', '-z', ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (run.status !== 0) fail(`git diff failed: ${run.stderr.trim()}`);
  return run.stdout.split('\0').filter(Boolean);
}

/**
 * Copies those paths into a new temporary folder: a link stays a link, its
 * target exactly as git stores it and never followed, so the copy is what a
 * scan of the published repository reads and hashes.
 */
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
  // A badge inside a fenced code block is an example shown as text, as the guard's own badge check reads it.
  const fenced = fencedRanges(readme);
  const outside = pattern => [...readme.matchAll(pattern)].filter(found => !fenced.some(([from, to]) => found.index >= from && found.index < to));
  const lines = outside(BADGE_LINES).map(found => found[0]);
  if (lines.length === 0) fail('README.md has no AI Install Guard badge line to keep current');
  // Every badge must be one this script rewrites: one in another form would stay stale unseen.
  const images = outside(BADGE_IMAGE).length;
  if (images !== lines.length) fail(`README.md has ${images} AI Install Guard badges but ${lines.length} in the form /guard badge writes; make each one that form, on a line of its own`);
  // The badge counts each file as it is on disk; a file half staged would be committed as something else.
  if (!check) {
    const unstaged = new Set(changed());
    const partial = changed('--cached').filter(file => unstaged.has(file) && file !== 'README.md');
    if (partial.length > 0) fail(`these files have staged and unstaged changes: ${partial.join(', ')}. The badge counts each file as it is on disk, so stage all of it or stash the rest, then run this again.`);
  }

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

  const stale = lines.filter(line => line !== wanted);
  if (stale.length === 0) {
    console.log(`badge: the README badge is for these files (${verdict}, content ${report.badge.pin}).`);
    return;
  }
  if (check) {
    const named = stale.map(line => /_%C2%B7_([0-9a-f]+)-/.exec(line)?.[1] ?? 'another version');
    fail(`the README badge names ${named.join(', ')}, but these files are ${verdict} at content ${report.badge.pin}. Run npm run badge, then commit README.md.`);
  }
  fs.writeFileSync(README, readme.replace(BADGE_LINES, (line, index) => (fenced.some(([from, to]) => index >= from && index < to) ? line : wanted)));
  console.log(`badge: README badge updated to ${verdict} at content ${report.badge.pin}. Commit README.md with the rest.`);
  // What else the badge counted that is not committed yet: it has to go in with README.md.
  const pending = [...new Set([...changed(), ...changed('--cached'), ...committable().filter(file => !tracked().has(file))])].filter(file => file !== 'README.md');
  if (pending.length > 0) console.log(`badge: it also counts these uncommitted changes, so commit them in the same commit: ${pending.slice(0, 20).join(', ')}${pending.length > 20 ? ', …' : ''}`);
}

/** Where the Markdown's fenced code blocks are, as [start, end) offsets. */
function fencedRanges(text) {
  const ranges = [];
  let open;
  let offset = 0;
  for (const line of text.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open === undefined && fence !== null) open = { at: offset, mark: fence[1] };
    else if (open !== undefined && fence !== null && fence[1][0] === open.mark[0] && fence[1].length >= open.mark.length && line.trim() === fence[1]) {
      ranges.push([open.at, offset + line.length]);
      open = undefined;
    }
    offset += line.length + 1;
  }
  if (open !== undefined) ranges.push([open.at, text.length]);
  return ranges;
}

/** The paths git already tracks. */
function tracked() {
  const run = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return new Set(run.status === 0 ? run.stdout.split('\0').filter(Boolean) : []);
}

main();

#!/usr/bin/env node

'use strict';

// Builds the plugin as it ships: only the files the mod runs with (its
// manifest, its hooks without their tests, its types) and what a person reads
// beside them (README and the pages it links to, CHANGELOG, LICENSE and the
// README's image). No
// package.json, so installing it installs no packages and runs no install
// script; no fixtures, tests, scripts or CI files.
//
// The files come from a commit, as git stores them, never from the working
// folder, so the same commit always gives the same plugin.
//
//   node scripts/build-plugin.js --out <folder> [--commit <sha>]
//       write the plugin's files from a commit (HEAD by default) into a new folder
//   node scripts/build-plugin.js --release <sha>
//       commit them onto the `release` branch, which the marketplace installs
//       from, through GitHub's API so GitHub signs the commit (the release
//       workflow, with GH_TOKEN); a version already there is left as it is

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const BRANCH = 'release';

/** What ships: these files, and everything under these folders, except what LEFT_OUT names. */
const SHIPS = ['.claude-plugin/plugin.json', 'hooks/', 'types/', 'assets/', 'docs/', 'README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'LICENSE'];
const LEFT_OUT = [/^hooks\/.*\.test\.ts$/, /^hooks\/test-support\//];

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

function ships(file) {
  return SHIPS.some(item => (item.endsWith('/') ? file.startsWith(item) : file === item)) && !LEFT_OUT.some(pattern => pattern.test(file));
}

/** The shipped files of a commit: mode, blob id and path of each, as git stores them. */
function shippedEntries(commit) {
  const listing = git(['ls-tree', '-r', '-z', '--full-tree', commit]);
  const entries = [];
  for (const record of listing.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode, type, id] = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    if (type !== 'blob' || !ships(file)) continue;
    if (mode === '120000') throw new Error(`${file} is a symbolic link; the plugin ships files only`);
    entries.push({ mode, id, file });
  }
  if (!entries.some(entry => entry.file === '.claude-plugin/plugin.json')) throw new Error(`${commit} has no .claude-plugin/plugin.json`);
  return entries;
}

/** The tree object holding exactly `entries`, written through an index of its own. */
function treeOf(entries) {
  const index = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'guard-plugin-')), 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    git(['read-tree', '--empty'], { env });
    git(['update-index', '--add', '-z', '--index-info'], { env, input: entries.map(entry => `${entry.mode} ${entry.id}\t${entry.file}\0`).join('') });
    return git(['write-tree'], { env }).trim();
  } finally {
    fs.rmSync(path.dirname(index), { recursive: true, force: true });
  }
}

function versionAt(commit) {
  return JSON.parse(git(['show', `${commit}:.claude-plugin/plugin.json`])).version;
}

function writeOut(commit, out) {
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) throw new Error(`${out} is not empty`);
  for (const entry of shippedEntries(commit)) {
    const target = path.join(out, ...entry.file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, execFileSync('git', ['cat-file', 'blob', entry.id], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 }));
    if (entry.mode === '100755') fs.chmodSync(target, 0o755);
  }
  console.log(`Wrote the plugin as it ships at ${commit.slice(0, 12)} to ${out}`);
}

/** Whether origin has the release branch: `git ls-remote --exit-code` exits 2 when it has no such ref, and any other failure is an error. */
function branchExists() {
  try {
    git(['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${BRANCH}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (error) {
    if (error.status === 2) return false;
    throw new Error(`could not ask origin for the ${BRANCH} branch: ${String(error.stderr || error.message).trim()}`);
  }
}

function release(commit) {
  const version = versionAt(commit);
  const entries = shippedEntries(commit);
  const tree = treeOf(entries);
  // Only a branch the remote says is not there starts anew; any other failure
  // stops the release, so a commit is never built without the branch it extends.
  let parent;
  if (branchExists()) {
    git(['fetch', '--quiet', 'origin', `refs/heads/${BRANCH}`]);
    parent = git(['rev-parse', 'FETCH_HEAD']).trim();
  } else {
    console.log(`There is no ${BRANCH} branch yet; this release starts it.`);
  }
  if (parent !== undefined && versionAt(parent) === version) {
    console.log(`The ${BRANCH} branch already holds ${version}.`);
    return;
  }
  const message = `Release v${version}\n\nThe plugin as it ships, built from ${commit}: the files the mod runs with, and nothing else.\n`;
  // Made through GitHub's API rather than pushed, so GitHub signs the commit
  // and an install's scan shows it verified. Every file is one of main's own
  // blobs, so GitHub already holds them; the tree it builds must be the one
  // git builds here from the same files.
  const built = api('POST', 'git/trees', { tree: entries.map(entry => ({ path: entry.file, mode: entry.mode, type: 'blob', sha: entry.id })) });
  if (built.sha !== tree) throw new Error(`GitHub built the tree ${built.sha} for these files, not ${tree}`);
  const made = api('POST', 'git/commits', { message, tree, parents: parent === undefined ? [] : [parent] });
  if (made.verification?.verified !== true) console.log(`GitHub did not verify ${made.sha}: ${made.verification?.reason ?? 'it gave no reason'}`);
  // The branch only moves forward: an update that is not one fails rather than overwrite it.
  if (parent === undefined) api('POST', 'git/refs', { ref: `refs/heads/${BRANCH}`, sha: made.sha });
  else api('PATCH', `git/refs/heads/${BRANCH}`, { sha: made.sha, force: false });
  console.log(`Added ${version} to the ${BRANCH} branch as ${made.sha.slice(0, 12)}${made.verification?.verified === true ? ', signed by GitHub' : ''}.`);
}

/** GitHub's REST API on this repository through `gh`, with a JSON body; the release workflow gives it its token. */
function api(method, route, body) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo === undefined || repo === '') throw new Error('GITHUB_REPOSITORY is not set: --release runs in the release workflow');
  const out = execFileSync('gh', ['api', '--method', method, `repos/${repo}/${route}`, '--input', '-'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: JSON.stringify(body),
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function main() {
  const args = process.argv.slice(2);
  const value = name => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const commit = git(['rev-parse', '--verify', `${value('--release') ?? value('--commit') ?? 'HEAD'}^{commit}`]).trim();
  if (args.includes('--release')) return release(commit);
  const out = value('--out');
  if (out === undefined) throw new Error('usage: build-plugin.js --out <folder> [--commit <sha>] | --release <sha>');
  writeOut(commit, path.resolve(out));
}

try {
  main();
} catch (error) {
  console.error(`build-plugin: ${error.message}`);
  process.exit(1);
}

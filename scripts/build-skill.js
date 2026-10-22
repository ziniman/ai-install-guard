#!/usr/bin/env node

'use strict';

// Builds the Agent Skill that runs the guard's scanner in a Claude chat:
// bundles cli/scan.ts and the scanner into one readable file,
// skill/ai-install-guard/scripts/scan.js, copies the LICENSE beside
// SKILL.md and README.md, and zips the folder to dist/ai-install-guard-skill.zip for
// upload (Settings > Capabilities > Skills). The zip is reproducible: fixed
// times and order, so the same sources give the same bytes.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO_ROOT = path.resolve(__dirname, '..');
const NAME = 'ai-install-guard';
const SKILL_DIR = path.join(REPO_ROOT, 'skill', NAME);
const BUNDLE = path.join(SKILL_DIR, 'scripts', 'scan.js');
const ZIP = path.join(REPO_ROOT, 'dist', `${NAME}-skill.zip`);

let crcTable;

function crc32(bytes) {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00, the earliest time a zip can hold.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/**
 * A zip archive of `entries`, each `{ name, data, mode }`: `mode` is a Unix
 * mode with its type bits (0o100644 a file, 0o040755 a folder, 0o120777 a
 * link whose data is its target). Files are deflated, the rest stored. Names
 * are written as given, so tests can build archives the reader must refuse.
 */
function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '');
    const mode = entry.mode ?? 0o100644;
    const isFile = (mode & 0o170000) === 0o100000;
    const body = isFile ? zlib.deflateRawSync(data, { level: 9 }) : data;
    const method = isFile ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The SKILL.md front matter, checked against what a skill upload accepts. */
function checkSkillFile(text) {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (front === null) throw new Error('SKILL.md has no front matter');
  const field = key => {
    const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front[1]);
    return match === null ? undefined : match[1].trim();
  };
  const name = field('name');
  const description = field('description');
  if (name !== NAME) throw new Error(`SKILL.md name is "${name}", not "${NAME}"`);
  if (description === undefined || description === '') throw new Error('SKILL.md has no description');
  if (description.length > 1024) throw new Error(`SKILL.md description is ${description.length} characters, over 1024`);
  if (/[<>]/.test(description)) throw new Error('SKILL.md description must not hold < or >');
}

async function build() {
  const esbuild = require('esbuild');
  const { version } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

  checkSkillFile(fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8'));
  fs.rmSync(path.join(SKILL_DIR, 'scripts'), { recursive: true, force: true });

  // Not minified: whoever installs the skill can read what it runs.
  await esbuild.build({
    entryPoints: [path.join(REPO_ROOT, 'cli', 'scan.ts')],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    charset: 'ascii',
    legalComments: 'none',
    define: { GUARD_VERSION: JSON.stringify(version) },
    banner: {
      js: [
        '#!/usr/bin/env node',
        `// AI Install Guard ${version}: the deterministic scanner, for the chat skill.`,
        '// Built from cli/scan.ts by scripts/build-skill.js. Source and license (Apache-2.0):',
        '// https://github.com/ziniman/ai-install-guard',
      ].join('\n'),
    },
    logLevel: 'warning',
  });
  fs.copyFileSync(path.join(REPO_ROOT, 'LICENSE'), path.join(SKILL_DIR, 'LICENSE'));

  const files = ['SKILL.md', 'README.md', 'LICENSE', 'scripts/scan.js'];
  const entries = [
    { name: `${NAME}/`, mode: 0o040755 },
    { name: `${NAME}/scripts/`, mode: 0o040755 },
    ...files.map(file => ({ name: `${NAME}/${file}`, data: fs.readFileSync(path.join(SKILL_DIR, file)), mode: 0o100644 })),
  ];
  const zip = writeZip(entries);
  fs.mkdirSync(path.dirname(ZIP), { recursive: true });
  fs.writeFileSync(ZIP, zip);

  const sha = crypto.createHash('sha256').update(zip).digest('hex');
  const rel = file => path.relative(REPO_ROOT, file);
  console.log(`Built ${rel(BUNDLE)} (${(fs.statSync(BUNDLE).size / 1024).toFixed(0)} KB)`);
  console.log(`Wrote ${rel(ZIP)} (${(zip.length / 1024).toFixed(0)} KB, sha256 ${sha})`);
}

module.exports = { writeZip, crc32 };

if (require.main === module) {
  build().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

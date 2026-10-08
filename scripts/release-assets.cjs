#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function fail(message) {
  console.error(`Release preparation failed: ${message}`);
  process.exit(1);
}

function expectedAssets(version) {
  return [
    ...['dmg', 'zip'].map((ext) => `fake-fantasy-editor-${version}-mac-arm64.${ext}`),
    ...['dmg', 'zip'].map((ext) => `fake-fantasy-editor-${version}-mac-x64.${ext}`),
    ...['exe', 'zip'].map((ext) => `fake-fantasy-editor-${version}-win-x64.${ext}`),
    `fake-fantasy-editor-${version}-linux-x86_64.AppImage`,
    `fake-fantasy-editor-${version}-linux-amd64.deb`
  ];
}

function stage(platform, arch) {
  const supported = {
    'mac arm64': ['dmg', 'zip'],
    'mac x64': ['dmg', 'zip'],
    'win x64': ['exe', 'zip'],
    'linux x64': ['AppImage', 'deb']
  };
  const extensions = supported[`${platform} ${arch}`];
  if (!extensions) fail(`unsupported build target ${platform}/${arch}`);

  const dist = path.join(root, 'dist');
  const staging = path.join(root, 'release-assets');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  for (const ext of extensions) {
    const artifactArch = platform === 'linux' && ext === 'AppImage'
      ? 'x86_64'
      : platform === 'linux' && ext === 'deb'
        ? 'amd64'
        : arch;
    const filename = `fake-fantasy-editor-${pkg.version}-${platform}-${artifactArch}.${ext}`;
    const source = path.join(dist, filename);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile() || fs.statSync(source).size === 0) {
      fail(`expected non-empty installer is missing: dist/${filename}`);
    }
    fs.copyFileSync(source, path.join(staging, filename));
  }
}

function collect() {
  const directory = path.join(root, 'release-assets');
  const expected = expectedAssets(pkg.version).sort();
  const found = fs.readdirSync(directory, { withFileTypes: true });
  if (found.some((entry) => !entry.isFile())) fail('release-assets contains a directory or non-file entry');
  const actual = found.map((entry) => entry.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`expected exactly ${expected.length} installer files; found: ${actual.join(', ') || '(none)'}`);
  }

  const lines = expected.map((filename) => {
    const bytes = fs.readFileSync(path.join(directory, filename));
    if (bytes.length === 0) fail(`installer is empty: ${filename}`);
    return `${crypto.createHash('sha256').update(bytes).digest('hex')}  ${filename}`;
  });
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

function checkRelease(jsonPath, complete) {
  const release = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!release.isDraft) fail('a release with this tag is already published; published releases are immutable here');
  const allowed = [...expectedAssets(pkg.version), 'SHA256SUMS'].sort();
  const actual = release.assets.map((asset) => asset.name).sort();
  if (actual.some((name) => !allowed.includes(name))) {
    fail(`draft release contains unexpected assets: ${actual.filter((name) => !allowed.includes(name)).join(', ')}`);
  }
  if (complete && JSON.stringify(actual) !== JSON.stringify(allowed)) {
    fail(`draft release is missing expected assets: ${allowed.filter((name) => !actual.includes(name)).join(', ')}`);
  }
}

function validate(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/.exec(tag || '');
  if (!match) fail(`tag must use vX.Y.Z or vX.Y.Z-prerelease syntax: ${tag || '(empty)'}`);

  const version = tag.slice(1);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  if (pkg.version !== version || lock.version !== version || lock.packages?.['']?.version !== version) {
    fail(`tag ${tag} must match package.json and both package-lock.json root versions`);
  }

  const tagSha = execFileSync('git', ['rev-parse', `refs/tags/${tag}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  const mainSha = execFileSync('git', ['rev-parse', 'refs/remotes/origin/main^{commit}'], { cwd: root, encoding: 'utf8' }).trim();
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', tagSha, mainSha], { cwd: root, stdio: 'ignore' });
  } catch {
    fail(`${tag} (${tagSha}) is not an ancestor of origin/main (${mainSha})`);
  }

  const output = process.env.GITHUB_OUTPUT;
  if (!output) fail('GITHUB_OUTPUT is unavailable');
  fs.appendFileSync(output, `tag=${tag}\nversion=${version}\nsha=${tagSha}\nprerelease=${match[4] ? 'true' : 'false'}\n`);
  console.log(`Validated ${tag} at ${tagSha} as an ancestor of origin/main.`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'stage' && args.length === 2) stage(args[0], args[1]);
else if (command === 'collect' && args.length === 0) collect();
else if (command === 'check-draft' && args.length === 1) checkRelease(args[0], false);
else if (command === 'check-complete' && args.length === 1) checkRelease(args[0], true);
else if (command === 'validate' && args.length === 1) validate(args[0]);
else fail('usage: release-assets.cjs validate <tag> | stage <platform> <arch> | collect | check-draft <json> | check-complete <json>');

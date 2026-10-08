'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'extensions/pkg-studio');
const version = require(path.join(extension, 'package.json')).version;
const output = path.join(root, 'dist', `fantasy-pkg-studio-${version}.vsix`);
fs.mkdirSync(path.dirname(output), { recursive: true });
if (!process.env.npm_execpath) throw new Error('请通过 npm run package:plugin 运行打包。');
const result = spawnSync(process.execPath, [process.env.npm_execpath,
  'exec', '--yes', '--package=@vscode/vsce@4.0.0', '--',
  'vsce', 'package', '--no-dependencies', '--allow-missing-repository',
  '--skip-license', '--out', output,
], { cwd: extension, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status || 0;

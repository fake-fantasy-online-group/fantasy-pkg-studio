'use strict';

const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(extensionRoot, '../..');
const runtime = path.join(extensionRoot, 'runtime');
const runtimeModules = path.join(runtime, 'node_modules');
fs.rmSync(runtime, { recursive: true, force: true });
fs.mkdirSync(runtimeModules, { recursive: true });
for (const source of ['src/pkg.cjs', 'src/preview.cjs', 'src/dimg.cjs']) {
  fs.copyFileSync(path.join(projectRoot, source), path.join(runtime, path.basename(source)));
}
const pngjsSource = path.join(projectRoot, 'node_modules/pngjs');
fs.cpSync(pngjsSource, path.join(runtimeModules, 'pngjs'), { recursive: true });
console.log('Packaged current PKG core and pngjs into extensions/pkg-studio/runtime.');

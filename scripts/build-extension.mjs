// Assembles the Firefox build of the companion extension in dist-extension/firefox/.
//
// Chromium loads extension/ as it is. Firefox needs a different manifest
// (extension/manifest.firefox.json) under the name manifest.json, so this
// copies the shared scripts next to it.

import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'extension');
const out = path.join(root, 'dist-extension', 'firefox');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const file of ['background.js', 'content.js']) await cp(path.join(src, file), path.join(out, file));
await cp(path.join(src, 'manifest.firefox.json'), path.join(out, 'manifest.json'));
console.log(`Built ${path.relative(root, out)}/`);

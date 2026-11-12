// Assembles the static site in dist/:
//   src/                 -> dist/
//   pyodide (npm)        -> dist/vendor/pyodide/
//   @ffmpeg/core (npm)   -> dist/vendor/ffmpeg/
//   yt-dlp + yt-dlp-ejs  -> dist/vendor/wheels/   (pure-Python wheels from PyPI)
//
// YTDLP_VERSION=2026.10.26 pins yt-dlp; by default the latest release is used.

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const vendor = path.join(dist, 'vendor');
const modules = path.join(root, 'node_modules');

async function pypi(name, version) {
  const url = `https://pypi.org/pypi/${name}/${version ? `${version}/` : ''}json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function downloadWheel(name, version) {
  const meta = await pypi(name, version);
  const file = meta.urls.find((f) => f.packagetype === 'bdist_wheel' && f.filename.endsWith('-none-any.whl'));
  if (!file) throw new Error(`${name} ${meta.info.version} has no pure-Python wheel`);
  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`${file.url}: HTTP ${res.status}`);
  await writeFile(path.join(vendor, 'wheels', file.filename), Buffer.from(await res.arrayBuffer()));
  console.log(`  ${name} ${meta.info.version}`);
  return { meta, filename: file.filename };
}

await rm(dist, { recursive: true, force: true });
await cp(path.join(root, 'src'), dist, { recursive: true });
await mkdir(path.join(vendor, 'wheels'), { recursive: true });

console.log('Vendoring runtimes from node_modules');
for (const file of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
  await cp(path.join(modules, 'pyodide', file), path.join(vendor, 'pyodide', file));
}
for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  await cp(path.join(modules, '@ffmpeg/core/dist/esm', file), path.join(vendor, 'ffmpeg', file));
}

console.log('Downloading wheels from PyPI');
const ytdlp = await downloadWheel('yt-dlp', process.env.YTDLP_VERSION);
// yt-dlp only accepts the exact solver-script version it was released with
const ejsPin = (ytdlp.meta.info.requires_dist ?? [])
  .map((req) => req.match(/^yt-dlp-ejs\s*==\s*([\w.]+)/)?.[1])
  .find(Boolean);
const ejs = await downloadWheel('yt-dlp-ejs', ejsPin);

await writeFile(
  path.join(vendor, 'manifest.json'),
  JSON.stringify({ wheels: [ytdlp.filename, ejs.filename], built: new Date().toISOString() }, null, 2),
);
console.log(`Built ${path.relative(root, dist)}/`);

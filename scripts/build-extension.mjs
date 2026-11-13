// Packages the companion extension:
//
//   downloads/browser-yt-dlp-bridge-chrome.zip    extension/ as Chromium loads it
//   downloads/browser-yt-dlp-bridge-firefox.zip   the Firefox variant
//   downloads/browser-yt-dlp-bridge.xpi           copy of extension/signed/*.xpi, if any
//   downloads/downloads.json                      what the page should offer
//   dist-extension/firefox/                       unpacked Firefox variant (for about:debugging)
//
// Chromium loads extension/ as it is. Firefox needs a different manifest
// (extension/manifest.firefox.json) under the name manifest.json.

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'extension');
const out = path.join(root, 'dist-extension');
const downloads = path.join(root, 'downloads');
const SCRIPTS = ['background.js', 'content.js'];

// Just enough of the zip format for a handful of small text files
function zip(files) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name);
    const packed = zlib.deflateRawSync(data);
    const common = Buffer.alloc(26);
    common.writeUInt16LE(20, 0); // version needed
    common.writeUInt16LE(0x0800, 2); // UTF-8 names
    common.writeUInt16LE(8, 4); // deflate
    common.writeUInt32LE(0x00210000, 6); // fixed timestamp (1980-01-01) keeps builds reproducible
    common.writeUInt32LE(zlib.crc32(data), 10);
    common.writeUInt32LE(packed.length, 14);
    common.writeUInt32LE(data.length, 18);
    common.writeUInt16LE(nameBytes.length, 22);

    const local = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), common, nameBytes, packed]);
    const central = Buffer.alloc(14); // comment length, disk, attributes: all zero
    central.writeUInt32LE(offset, 10); // where the local header starts
    directory.push(Buffer.concat([Buffer.from('PK\x01\x02\x14\x00', 'latin1'), common, central, nameBytes]));
    parts.push(local);
    offset += local.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.write('PK\x05\x06', 'latin1');
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}

await rm(out, { recursive: true, force: true });
await rm(downloads, { recursive: true, force: true });
await mkdir(path.join(out, 'firefox'), { recursive: true });
await mkdir(downloads, { recursive: true });

const scripts = await Promise.all(SCRIPTS.map(async (name) => [name, await readFile(path.join(src, name))]));
const chromeManifest = await readFile(path.join(src, 'manifest.json'));
const firefoxManifest = await readFile(path.join(src, 'manifest.firefox.json'));

for (const name of SCRIPTS) await cp(path.join(src, name), path.join(out, 'firefox', name));
await writeFile(path.join(out, 'firefox', 'manifest.json'), firefoxManifest);

const names = { chrome: 'browser-yt-dlp-bridge-chrome.zip', firefox: 'browser-yt-dlp-bridge-firefox.zip', firefoxSigned: null };
await writeFile(path.join(downloads, names.chrome), zip([['manifest.json', chromeManifest], ...scripts]));
await writeFile(path.join(downloads, names.firefox), zip([['manifest.json', firefoxManifest], ...scripts]));

// A Mozilla-signed build (see README) lets Firefox install in one click
const signed = (await readdir(path.join(src, 'signed')).catch(() => [])).find((f) => f.endsWith('.xpi'));
if (signed) {
  names.firefoxSigned = 'browser-yt-dlp-bridge.xpi';
  await cp(path.join(src, 'signed', signed), path.join(downloads, names.firefoxSigned));
}
await writeFile(path.join(downloads, 'downloads.json'), JSON.stringify(names, null, 2) + '\n');
console.log(`Built ${path.relative(root, downloads)}/`);

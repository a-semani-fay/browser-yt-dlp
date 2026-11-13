// Serves dist/ and a same-origin CORS proxy at /proxy, for local use.
//   node scripts/dev-server.mjs [port]

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { handleProxy } from '../proxy/worker.mjs';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const port = Number(process.argv[2] ?? process.env.PORT ?? 8000);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.py': 'text/x-python',
  '.zip': 'application/zip',
  '.whl': 'application/zip',
  '.svg': 'image/svg+xml',
  // Firefox only offers to install an add-on served with this type
  '.xpi': 'application/x-xpinstall',
};

async function proxy(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const response = await handleProxy(
    new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    }),
    // Only reachable from this machine, so local targets are fine here
    { allowPrivateHosts: true },
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
  else res.end();
}

async function serveFile(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  let file = path.join(dist, path.normalize(decodeURIComponent(pathname)));
  if (!file.startsWith(dist)) return res.writeHead(403).end();
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const { size } = await stat(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'content-length': size,
      'cache-control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found\n');
  }
}

createServer((req, res) => {
  const handler = req.url.startsWith('/proxy') ? proxy : serveFile;
  handler(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`browser-yt-dlp: http://localhost:${port}/  (CORS proxy at /proxy)`);
});

// Runs the real Python shim and the real yt-dlp under Pyodide in Node, with a
// fake browser bridge. Needs `npm run build` first (it reads dist/).

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadPyodide } from 'pyodide';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');

const data = Uint8Array.from({ length: 2500 }, (_, i) => (i * 7 + (i >> 8)) & 255);
const requests = [];
const headers = (obj) => JSON.stringify(Object.entries(obj));

// A site behind our proxy: /big honours Range, /norange ignores it, /empty rejects it
function fetchSync(url, method) {
  const params = new URL(url).searchParams;
  const target = params.get('url');
  const sent = JSON.parse(params.get('h') || '{}');
  requests.push(`${method} ${target} ${sent.Range ?? ''}`.trim());

  if (target.endsWith('.js')) {
    return { status: 200, headers: headers({ 'content-type': 'text/javascript' }), body: new TextEncoder().encode('var junk=1;') };
  }
  if (target.endsWith('/empty')) {
    return sent.Range
      ? { status: 416, headers: '[]', body: new Uint8Array(0) }
      : { status: 200, headers: headers({ 'content-length': '0' }), body: new Uint8Array(0) };
  }
  if (target.endsWith('/norange')) return { status: 200, headers: headers({ 'content-length': '2500' }), body: data };
  if (target.endsWith('/404')) return { status: 404, headers: '[]', body: new TextEncoder().encode('gone') };
  if (target.endsWith('/redirect')) {
    return {
      status: 200,
      headers: headers({
        'x-proxy-status': '302',
        'x-proxy-location': '/whoami',
        'x-proxy-set-cookie': encodeURIComponent(JSON.stringify(['sess=abc; Path=/'])),
      }),
      body: new Uint8Array(0),
    };
  }
  if (target.endsWith('/whoami')) {
    return { status: 200, headers: '[]', body: new TextEncoder().encode(`cookie=${sent.Cookie ?? ''}`) };
  }
  const [, start, end] = /bytes=(\d+)-(\d+)/.exec(sent.Range).map(Number);
  const last = Math.min(end, data.length - 1);
  return {
    status: 206,
    headers: headers({ 'content-range': `bytes ${start}-${last}/${data.length}` }),
    body: data.slice(start, last + 1),
  };
}

globalThis.__expected = data;
globalThis.__ytdlpBridge = {
  fetchSync,
  hasFfmpeg: () => false,
  runJs(code) {
    const out = [];
    const sink = () => {};
    new Function('console', code)({ log: (...p) => out.push(p.join(' ')), error: sink, warn: sink, info: sink, debug: sink });
    return out.join('\n');
  },
  jsEngine: () => 'node-test',
  emit() {},
};

const pyodide = await loadPyodide();
for (const wheel of readdirSync(path.join(dist, 'vendor/wheels'))) {
  pyodide.unpackArchive(new Uint8Array(readFileSync(path.join(dist, 'vendor/wheels', wheel))), 'wheel');
}
pyodide.FS.writeFile('/home/pyodide/browser_ytdlp.py', readFileSync(path.join(dist, 'py/browser_ytdlp.py')));
pyodide.runPython(`
import json, js, yt_dlp
import browser_ytdlp as b
from yt_dlp.networking import Request

b._RANGE_CHUNK = 1000
expected = js.__expected.to_py().tobytes()
ydl = yt_dlp.YoutubeDL(b._base_options({'cors_proxy': 'https://proxy.test/'}))
`);
const py = (code) => JSON.parse(pyodide.runPython(`json.dumps(${code})`));

test('a plain GET is fetched lazily in ranges and looks like a normal 200', () => {
  requests.length = 0;
  pyodide.runPython(`r = ydl.urlopen('https://x.test/big'); body = r.read()`);
  assert.deepEqual(py(`[r.status, r.headers['Content-Length'], body == expected]`), [200, '2500', true]);
  assert.deepEqual(requests, [
    'GET https://x.test/big bytes=0-999',
    'GET https://x.test/big bytes=1000-1999',
    'GET https://x.test/big bytes=2000-2499',
  ]);
});

test('closing early does not fetch the rest', () => {
  requests.length = 0;
  pyodide.runPython(`r = ydl.urlopen('https://x.test/big'); part = r.read(300); r.close()`);
  assert.equal(py(`part == expected[:300]`), true);
  assert.equal(requests.length, 1);
});

test('an explicit Range is passed through untouched', () => {
  pyodide.runPython(`r = ydl.urlopen(Request('https://x.test/big', headers={'Range': 'bytes=100-199'})); body = r.read()`);
  assert.deepEqual(py(`[r.status, body == expected[100:200]]`), [206, true]);
});

test('servers that reject or ignore Range still work', () => {
  assert.deepEqual(py(`[ydl.urlopen('https://x.test/empty').read().decode(), ydl.urlopen('https://x.test/norange').read() == expected]`), ['', true]);
});

test('HTTP errors surface as yt-dlp HTTPError', () => {
  pyodide.runPython(`
try:
    ydl.urlopen('https://x.test/404')
    err = None
except Exception as e:
    err = [type(e).__name__, e.status, e.response.read().decode()]
`);
  assert.deepEqual(py(`err`), ['HTTPError', 404, 'gone']);
});

test('redirects are followed client-side and carry cookies set on the way', () => {
  pyodide.runPython(`r = ydl.urlopen('https://x.test/redirect')`);
  assert.deepEqual(py(`[r.url, r.read().decode()]`), ['https://x.test/whoami', 'cookie=sess=abc']);
});

test('YouTube challenges are routed to the browser JS runtime', () => {
  pyodide.runPython(`
from yt_dlp.extractor.youtube.jsc._director import initialize_jsc_director
from yt_dlp.extractor.youtube.jsc.provider import JsChallengeRequest, JsChallengeType, NChallengeInput

calls = []
orig = b.bridge.runJs
b.BrowserJCP._run_js_runtime = lambda self, stdin: (calls.append(len(stdin)), str(orig(stdin)))[1]
director = initialize_jsc_director(ydl.get_info_extractor('Youtube'))
available = sorted(k for k, p in director.providers.items() if p.is_available())
# The player is junk, so the real solver script must run and then refuse it
solved = director.bulk_solve([JsChallengeRequest(JsChallengeType.N, NChallengeInput(
    'https://www.youtube.com/s/player/abcd1234/player_ias.vflset/en_US/base.js', ['abc']), 'vid')])
`);
  assert.deepEqual(py(`available`), ['Browser']);
  assert.equal(py(`len(calls)`), 1);
  assert.ok(py(`calls[0]`) > 10000, 'solver script was passed to the JS runtime');
  assert.deepEqual(py(`solved`), []);
});

// Runs the real Python shim and the real yt-dlp under Pyodide in Node, with a
// fake browser bridge, using the wheels committed in vendor/.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadPyodide } from 'pyodide';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
for (const wheel of readdirSync(path.join(site, 'vendor/wheels'))) {
  pyodide.unpackArchive(new Uint8Array(readFileSync(path.join(site, 'vendor/wheels', wheel))), 'wheel');
}
pyodide.FS.writeFile('/home/pyodide/browser_ytdlp.py', readFileSync(path.join(site, 'py/browser_ytdlp.py')));
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

// ---- format presets ---------------------------------------------------------

// The presets live in app.js, which is a browser module; lift just that block out.
const appSource = readFileSync(path.join(site, 'app.js'), 'utf8');
const presetSource = appSource.slice(appSource.indexOf('const H264 ='), appSource.indexOf('function showPresetHint'));
const PRESETS = vm.runInNewContext(`${presetSource}; PRESETS`);

const video = (id, vcodec, height, ext, tbr) => ({
  format_id: id, url: `https://x.test/${id}`, ext, vcodec, acodec: 'none', height, width: (height * 16) / 9, tbr, protocol: 'https',
});
const audio = (id, acodec, ext, tbr, language, language_preference) => ({
  format_id: id, url: `https://x.test/${id}`, ext, vcodec: 'none', acodec, tbr, abr: tbr, language, language_preference, protocol: 'https',
});

// What YouTube offers for an auto-dubbed video: the dub is flagged as the
// viewer's default (5) and the original as original (10), in both codecs.
const DUBBED = [
  video('313', 'vp9', 2160, 'webm', 18000),
  video('401', 'av01.0.12M.08', 2160, 'mp4', 12000),
  video('248', 'vp9', 1080, 'webm', 2600),
  video('137', 'avc1.640028', 1080, 'mp4', 4400),
  video('136', 'avc1.4d401f', 720, 'mp4', 2300),
  audio('251-en', 'opus', 'webm', 160, 'en', 5),
  audio('251-ja', 'opus', 'webm', 130, 'ja', 10),
  audio('140-en', 'mp4a.40.2', 'm4a', 192, 'en', 5),
  audio('140-ja', 'mp4a.40.2', 'm4a', 128, 'ja', 10),
  audio('140-es', 'mp4a.40.2', 'm4a', 129, 'es', -1),
];

function pick(presetName, formats) {
  const { hint, ...options } = PRESETS[presetName];
  globalThis.__case = JSON.stringify({ options, formats });
  return JSON.parse(pyodide.runPython(`
case = json.loads(js.__case)
picker = yt_dlp.YoutubeDL(b._base_options({**case['options'], 'simulate': True, 'quiet': True}))
info = picker.process_video_result(
    {'id': 'vid', 'title': 't', 'extractor': 'test', 'extractor_key': 'Test', 'webpage_url': 'https://x.test/', 'formats': case['formats']},
    download=False)
json.dumps({'ids': [f['format_id'] for f in info.get('requested_formats') or [info]], 'ext': info['ext']})
`));
}

test('compatible presets pick H.264 + AAC and the original audio track', () => {
  assert.deepEqual(pick('compatible', DUBBED), { ids: ['137', '140-ja'], ext: 'mp4' });
  assert.deepEqual(pick('compatible720', DUBBED), { ids: ['136', '140-ja'], ext: 'mp4' });
});

test('audio presets pick the original track', () => {
  assert.deepEqual(pick('audio', DUBBED).ids, ['140-ja']);
  assert.deepEqual(pick('mp3', DUBBED).ids, ['251-ja']);
});

test('the any-codec preset still prefers the original track', () => {
  assert.deepEqual(pick('best', DUBBED).ids, ['401', '251-ja']);
});

test('compatible preset degrades instead of failing', () => {
  // a site with one muxed file and no codec information
  const unknown = [{ format_id: 'http', url: 'https://x.test/v.mp4', ext: 'mp4', protocol: 'https' }];
  assert.deepEqual(pick('compatible', unknown).ids, ['http']);
  // a site with nothing but VP9/Opus
  const webmOnly = [video('v', 'vp9', 1080, 'webm', 2000), audio('a', 'opus', 'webm', 128)];
  assert.deepEqual(pick('compatible', webmOnly).ids, ['v', 'a']);
});

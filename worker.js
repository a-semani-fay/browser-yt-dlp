// Runs yt-dlp (Pyodide) and ffmpeg (ffmpeg.wasm) side by side in one worker.
//
// yt-dlp is synchronous Python, so everything it calls has to be synchronous
// too: network I/O is a sync XHR, ffmpeg runs in this same thread, and the
// YouTube challenge solver is evaluated right here. That is also why this
// lives in a worker - none of it may block the page.

import { loadPyodide } from './vendor/pyodide/pyodide.mjs';
import createFFmpegCore from './vendor/ffmpeg/ffmpeg-core.js';

const post = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer);

let pyodide;
let ffmpeg = null;
let api;

function mkdirTree(FS, dir) {
  let cur = '';
  for (const part of dir.split('/').filter(Boolean)) {
    cur += '/' + part;
    try {
      FS.mkdir(cur);
    } catch {
      // already there
    }
  }
}

const dirname = (path) => path.slice(0, path.lastIndexOf('/')) || '/';

// Everything Python needs from the outside world. See py/browser_ytdlp.py.
const bridge = {
  fetchSync(url, method, headersJson, body, timeoutMs) {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, false);
    xhr.responseType = 'arraybuffer';
    try {
      xhr.timeout = timeoutMs;
    } catch {
      // not every engine allows a timeout on sync XHR
    }
    for (const [name, value] of Object.entries(JSON.parse(headersJson))) {
      try {
        xhr.setRequestHeader(name, value);
      } catch {
        // header the browser will not let scripts set
      }
    }
    xhr.send(body ?? null);
    if (xhr.status === 0) throw new Error('network error');
    // Raised by sw.js when the companion extension could not be reached
    if (xhr.getResponseHeader('x-bridge-error')) throw new Error(new TextDecoder().decode(xhr.response));

    const headers = [];
    for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
      const idx = line.indexOf(':');
      if (idx > 0) headers.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
    }
    return {
      status: xhr.status,
      headers: JSON.stringify(headers),
      body: new Uint8Array(xhr.response ?? new ArrayBuffer(0)),
    };
  },

  hasFfmpeg: () => ffmpeg !== null,

  runFfmpeg(prog, argsJson, cwd, inputsJson, candidatesJson) {
    const args = JSON.parse(argsJson);
    const inputs = JSON.parse(inputsJson);
    const candidates = JSON.parse(candidatesJson);
    const logs = [];

    mkdirTree(ffmpeg.FS, cwd);
    ffmpeg.FS.chdir(cwd);
    for (const path of [...inputs, ...candidates]) mkdirTree(ffmpeg.FS, dirname(path));
    for (const path of inputs) ffmpeg.FS.writeFile(path, pyodide.FS.readFile(path));

    ffmpeg.setLogger(({ type, message }) => logs.push([type, message]));
    ffmpeg.setTimeout(-1);
    let code;
    try {
      if (prog === 'ffprobe') {
        code = ffmpeg.ffprobe(...args);
        // ffprobe never reports success: it leaves the "not finished" marker behind
        if (code === -1) code = 0;
      } else {
        ffmpeg.exec(...args);
        code = ffmpeg.ret;
      }
    } finally {
      ffmpeg.reset();
      for (const path of candidates) {
        try {
          const data = ffmpeg.FS.readFile(path);
          ffmpeg.FS.unlink(path);
          pyodide.FS.writeFile(path, data);
        } catch {
          // ffmpeg did not produce this one
        }
      }
      for (const path of inputs) {
        try {
          ffmpeg.FS.unlink(path);
        } catch {
          // already gone
        }
      }
    }
    return { code, logs: JSON.stringify(logs) };
  },

  // Stands in for `deno run -`: the script prints its answer with console.log.
  runJs(code) {
    const out = [];
    const sink = () => {};
    const fakeConsole = {
      log: (...parts) => out.push(parts.join(' ')),
      error: sink,
      warn: sink,
      info: sink,
      debug: sink,
    };
    new Function('console', code)(fakeConsole);
    return out.join('\n');
  },

  jsEngine() {
    const ua = self.navigator?.userAgent ?? 'unknown';
    const match = ua.match(/(Firefox|Edg|Chrome|Version)\/[\d.]+/);
    return match ? match[0].replace('Version', 'Safari') : ua;
  },

  emit(type, payloadJson) {
    post(type, JSON.parse(payloadJson));
  },
};
self.__ytdlpBridge = bridge;

async function loadFfmpeg() {
  const coreURL = new URL('./vendor/ffmpeg/ffmpeg-core.js', import.meta.url).href;
  const wasmURL = new URL('./vendor/ffmpeg/ffmpeg-core.wasm', import.meta.url).href;
  // ffmpeg-core finds its .wasm through this hash, the same way @ffmpeg/ffmpeg passes it
  return createFFmpegCore({
    mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL, workerURL: '' }))}`,
  });
}

async function loadYtDlp() {
  const base = new URL('./vendor/', import.meta.url);
  const manifest = await (await fetch(new URL('manifest.json', base))).json();

  post('status', { stage: 'python', message: 'Starting Python (Pyodide)…' });
  pyodide = await loadPyodide({ indexURL: new URL('pyodide/', base).href });

  post('status', { stage: 'yt-dlp', message: 'Unpacking yt-dlp…' });
  await Promise.all(
    manifest.wheels.map(async (name) => {
      const res = await fetch(new URL(`wheels/${name}`, base));
      if (!res.ok) throw new Error(`Could not fetch ${name}: HTTP ${res.status}`);
      pyodide.unpackArchive(new Uint8Array(await res.arrayBuffer()), 'wheel');
    }),
  );

  const shim = await (await fetch(new URL('./py/browser_ytdlp.py', import.meta.url))).text();
  pyodide.FS.writeFile('/home/pyodide/browser_ytdlp.py', shim);
  api = pyodide.pyimport('browser_ytdlp');
}

async function init() {
  const ffmpegReady = loadFfmpeg().then(
    (core) => {
      ffmpeg = core;
    },
    (err) => {
      // yt-dlp still works for single-file formats; it will warn about merging itself
      post('log', { level: 'warning', message: `ffmpeg.wasm failed to load: ${err.message ?? err}` });
    },
  );
  await loadYtDlp();
  post('status', { stage: 'ffmpeg', message: 'Loading ffmpeg.wasm…' });
  await ffmpegReady;
  post('ready', { versions: { ...JSON.parse(api.versions()), ffmpeg: ffmpeg !== null } });
}

const ready = init().catch((err) => {
  post('fatal', { message: String(err?.message ?? err) });
  throw err;
});

self.onmessage = async ({ data }) => {
  const { id, cmd, url, options } = data;
  try {
    await ready;
  } catch {
    return;
  }
  try {
    if (cmd === 'extract') {
      post('result', { id, ...JSON.parse(api.extract(url, JSON.stringify(options))) });
    } else if (cmd === 'download') {
      const result = JSON.parse(api.download(url, JSON.stringify(options)));
      if (result.ok) {
        for (const path of result.files) {
          const bytes = pyodide.FS.readFile(path);
          pyodide.FS.unlink(path);
          post('file', { id, name: path.slice(path.lastIndexOf('/') + 1), buffer: bytes.buffer }, [
            bytes.buffer,
          ]);
        }
      }
      const { files, ...summary } = result;
      post('result', { id, ...summary });
    }
  } catch (err) {
    post('result', { id, ok: false, error: String(err?.message ?? err) });
  }
};

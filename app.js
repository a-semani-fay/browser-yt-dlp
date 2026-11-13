const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  statusText: $('status-text'),
  form: $('form'),
  url: $('url'),
  downloadBtn: $('download-btn'),
  preset: $('preset'),
  custom: $('custom'),
  proxy: $('proxy'),
  mode: $('mode'),
  proxyWrap: $('proxy-wrap'),
  extStatus: $('ext-status'),
  extInstall: $('ext-install'),
  extLink: $('ext-link'),
  extSteps: $('ext-steps'),
  extOther: $('ext-other'),
  verbose: $('verbose'),
  info: $('info'),
  thumb: $('thumb'),
  title: $('title'),
  meta: $('meta'),
  media: $('media'),
  videoFormats: $('video-formats'),
  audioFormats: $('audio-formats'),
  pickerNotice: $('picker-notice'),
  pickedBtn: $('picked-btn'),
  progress: $('progress'),
  progressLabel: $('progress-label'),
  bar: $('bar'),
  cancelBtn: $('cancel-btn'),
  results: $('results'),
  files: $('files'),
  log: $('log'),
  clearBtn: $('clear-btn'),
  versions: $('versions'),
};

// ---------------------------------------------------------------- settings

const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // private mode etc. - the setting just will not stick
    }
  },
};

// The dev server ships a proxy on the same origin; anywhere else the user supplies one.
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
els.proxy.value = store.get('proxy') ?? (isLocal ? `${location.origin}/proxy` : '');
els.proxy.addEventListener('change', () => store.set('proxy', els.proxy.value.trim()));

// ------------------------------------------------------ companion extension

// The extension's content script answers these; nobody answers if it is absent.
let extSeq = 0;
const extWaiting = new Map();

// Messages to and from the extension are JSON text, with binary bodies as
// base64. Firefox does not let the extension's content script touch objects
// that belong to this page, so nothing structured may cross.
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.toBase64) return bytes.toBase64();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(text).buffer;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'browser-yt-dlp-extension') return;
  const reply = JSON.parse(event.data.json);
  if (reply.bodyB64 !== undefined) {
    reply.body = fromBase64(reply.bodyB64);
    delete reply.bodyB64;
  }
  extWaiting.get(reply.id)?.(reply);
  extWaiting.delete(reply.id);
});

function askExtension(type, request, timeoutMs) {
  return new Promise((resolve) => {
    const id = ++extSeq;
    extWaiting.set(id, resolve);
    const wire = request && { ...request, body: request.body ? toBase64(request.body) : null };
    window.postMessage(
      { source: 'browser-yt-dlp-page', json: JSON.stringify({ id, type, request: wire }) },
      location.origin,
    );
    setTimeout(() => {
      if (extWaiting.delete(id)) resolve(null);
    }, timeoutMs);
  });
}

// sw.js parks the worker's blocking request here while the extension works on it
navigator.serviceWorker?.addEventListener('message', async (event) => {
  if (event.data?.type !== 'bridge-fetch') return;
  const reply = (await askExtension('fetch', event.data.request, 180_000)) ?? {
    error: 'The companion extension did not answer',
  };
  event.ports[0].postMessage(reply, reply.body ? [reply.body] : []);
});

const bridgeUrl = new URL('./__bridge/fetch', location.href).href;
let extension = null;

// ---- installing the extension --------------------------------------------
// The site carries its own copy of the extension. Browsers decide how far a
// page may go: Firefox installs a signed .xpi straight from a link, everything
// else has to be unzipped and loaded by hand.

const isFirefox = navigator.userAgent.includes('Firefox/');
const STEPS = {
  chrome: [
    'Unzip the download into a folder you will keep.',
    'Open chrome://extensions (or edge://extensions) and switch on Developer mode.',
    'Choose "Load unpacked" and select the unzipped folder.',
    'Come back to this tab, click the extension\'s toolbar button so its badge says ON, then reload.',
  ],
  firefox: [
    'Unzip the download.',
    'Open about:debugging#/runtime/this-firefox and choose "Load Temporary Add-on…".',
    'Select manifest.json in the unzipped folder. Firefox removes temporary add-ons when it closes.',
    'Come back to this tab, click the extension\'s toolbar button so its badge says ON, then reload.',
  ],
  firefoxSigned: [
    'Approve the installation when Firefox asks.',
    'Click the extension\'s toolbar button on this tab so its badge says ON, then reload.',
  ],
};

let downloads;
async function showInstall() {
  try {
    downloads ??= await (await fetch(new URL('./downloads/downloads.json', location.href))).json();
  } catch {
    return; // nothing to offer
  }
  const kind = isFirefox ? (downloads.firefoxSigned ? 'firefoxSigned' : 'firefox') : 'chrome';
  const otherKind = isFirefox ? 'chrome' : 'firefox';
  els.extLink.href = `./downloads/${downloads[kind]}`;
  els.extLink.textContent =
    kind === 'firefoxSigned' ? 'Install the extension' : `Download the extension for ${isFirefox ? 'Firefox' : 'Chrome / Edge'}`;
  // A plain navigation is what makes Firefox offer to install an .xpi
  els.extLink.toggleAttribute('download', kind !== 'firefoxSigned');
  els.extSteps.replaceChildren(
    ...STEPS[kind].map((text) => Object.assign(document.createElement('li'), { textContent: text })),
  );
  els.extOther.href = `./downloads/${downloads[otherKind]}`;
  els.extOther.textContent = `Download for ${isFirefox ? 'Chrome / Edge' : 'Firefox'} instead`;
  els.extOther.setAttribute('download', '');
  els.extInstall.hidden = false;
}

async function refreshExtension() {
  extension = await askExtension('ping', undefined, 400);
  els.proxyWrap.hidden = els.mode.value !== 'proxy';
  els.extStatus.hidden = els.mode.value !== 'extension';
  els.extInstall.hidden = true;
  if (els.mode.value === 'extension' && !extension) showInstall();
  if (!navigator.serviceWorker) {
    els.extStatus.textContent = 'This browser or context has no service workers, which extension mode needs.';
  } else if (!extension) {
    els.extStatus.textContent = 'Extension not detected in this browser.';
  } else if (!extension.allowed) {
    els.extStatus.textContent =
      'Extension found, but this site is not enabled. Click the extension\'s toolbar button on this tab.';
  } else {
    els.extStatus.textContent = `Extension ${extension.version} connected. Requests are made by your own browser.`;
  }
  return extension;
}

els.mode.addEventListener('change', () => {
  store.set('mode', els.mode.value);
  refreshExtension();
});
window.addEventListener('focus', refreshExtension);

async function initNetworkMode() {
  await refreshExtension();
  const usable = extension?.allowed && navigator.serviceWorker;
  els.mode.value = store.get('mode') ?? (usable || !els.proxy.value ? 'extension' : 'proxy');
  await refreshExtension();
  if (els.mode.value === 'extension' ? !usable : els.mode.value === 'proxy' && !els.proxy.value) {
    $('settings').open = true;
  }
}


// --------------------------------------------------------------------- log

function log(message, level = 'info') {
  const line = document.createElement('span');
  line.className = level;
  line.textContent = message + '\n';
  const pinned = els.log.scrollTop + els.log.clientHeight >= els.log.scrollHeight - 8;
  els.log.append(line);
  if (pinned) els.log.scrollTop = els.log.scrollHeight;
}

els.clearBtn.addEventListener('click', () => els.log.replaceChildren());

// ------------------------------------------------------------------ worker

let worker;
let ready = false;
let busy = false;
let nextId = 1;
const pending = new Map();

function setStatus(state, text) {
  els.status.dataset.state = state;
  els.statusText.textContent = text;
}

function refreshButtons() {
  els.downloadBtn.disabled = !ready || busy;
  els.pickedBtn.disabled = !ready || busy || !els.custom.value.trim();
}

function startWorker() {
  ready = false;
  refreshButtons();
  setStatus('loading', 'Loading runtimes…');
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => handlers[data.type]?.(data);
  worker.onerror = (event) => {
    setStatus('error', 'The worker crashed');
    log(event.message || 'Worker error', 'error');
  };
}

const handlers = {
  status: ({ message }) => setStatus('loading', message),
  ready({ versions }) {
    ready = true;
    refreshButtons();
    setStatus('ready', 'Ready');
    els.versions.textContent =
      `yt-dlp ${versions['yt-dlp']} · yt-dlp-ejs ${versions['yt-dlp-ejs'] ?? 'missing'} · ` +
      `ffmpeg.wasm ${versions.ffmpeg ? 'loaded' : 'unavailable'}`;
  },
  fatal({ message }) {
    setStatus('error', 'Failed to start');
    log(message, 'error');
  },
  log: ({ level, message }) => log(message, level),
  progress: showProgress,
  postprocess({ status, postprocessor }) {
    if (status === 'started') {
      els.progressLabel.textContent = `Post-processing (${postprocessor})…`;
      els.bar.removeAttribute('value');
    }
  },
  file({ name, buffer }) {
    const url = URL.createObjectURL(new Blob([buffer]));
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.textContent = name;
    const size = document.createElement('span');
    size.className = 'muted';
    size.textContent = formatBytes(buffer.byteLength);
    item.append(link, size);
    els.files.prepend(item);
    els.results.hidden = false;
    link.click(); // hand it to the browser's download manager right away
  },
  result(data) {
    pending.get(data.id)?.(data);
    pending.delete(data.id);
  },
};

function call(cmd, url, options) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, cmd, url, options });
  });
}

// ---------------------------------------------------------------- helpers

function formatBytes(n) {
  if (!n) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function showProgress(p) {
  const total = p.total_bytes ?? p.total_bytes_estimate;
  const parts = [p.format_id ? `Format ${p.format_id}` : 'Downloading'];
  if (p.status === 'finished') {
    els.bar.value = 100;
    parts.push('done');
  } else if (total) {
    const pct = (100 * p.downloaded_bytes) / total;
    els.bar.value = pct;
    parts.push(`${pct.toFixed(1)}% of ${formatBytes(total)}`);
  } else if (p.fragment_count) {
    els.bar.value = (100 * (p.fragment_index ?? 0)) / p.fragment_count;
    parts.push(`fragment ${p.fragment_index ?? 0}/${p.fragment_count}`);
  } else {
    els.bar.removeAttribute('value');
    parts.push(formatBytes(p.downloaded_bytes));
  }
  if (p.speed) parts.push(`${formatBytes(p.speed)}/s`);
  els.progressLabel.textContent = parts.filter(Boolean).join(' · ');
}

function baseOptions() {
  const proxies = { extension: bridgeUrl, proxy: els.proxy.value.trim(), direct: '' };
  return { cors_proxy: proxies[els.mode.value], verbose: els.verbose.checked };
}

// H.264 video and AAC audio in MP4 play practically everywhere; VP9, AV1 and
// Opus do not (older phones, TVs, editors, car stereos). The compatible presets
// therefore only accept those two codecs. "?" lets a format through when a site
// does not say what its codec is. When nothing qualifies the user is shown the
// formats that do exist and chooses (`ask_if_unavailable`), rather than
// receiving a substitute they did not ask for.
//
// Dubbed audio needs no extra filter: yt-dlp ranks the original-language track
// above every other one before it looks at quality, so "ba" is the original.
const H264 = "[vcodec~=?'^(avc|h264)']";
const AAC = "[acodec~=?'^(mp4a|aac)']";
const compatible = (limit = '') => `bv*${H264}${limit}+ba${AAC}/b${H264}${AAC}${limit}`;

const PRESETS = {
  compatible: {
    format: compatible(),
    merge_output_format: 'mp4',
    ask_if_unavailable: true,
    hint: 'H.264 video and AAC audio in an MP4, which nearly every device and player can open. On YouTube this tops out at 1080p. Dubbed videos download with their original audio. If a video has no such formats you are shown what it does have.',
  },
  compatible720: {
    format: compatible('[height<=720]'),
    merge_output_format: 'mp4',
    ask_if_unavailable: true,
    hint: 'As above, limited to 720p for smaller files.',
  },
  best: {
    format: 'bv*+ba/b',
    hint: 'The highest resolution and bitrate on offer. Above 1080p this is usually VP9 or AV1 with Opus audio, which some devices and editors cannot play.',
  },
  audio: {
    format: `ba${AAC}`,
    ask_if_unavailable: true,
    hint: 'The original audio track as AAC in an M4A file, without re-encoding.',
  },
  mp3: {
    format: 'ba/b',
    postprocessors: [{ key: 'FFmpegExtractAudio', preferredcodec: 'mp3', preferredquality: '192' }],
    hint: 'The original audio track, re-encoded to a 192 kbit/s MP3 in your browser.',
  },
  advanced: {
    hint: 'Lists every format the video has and lets you choose exactly which video and audio streams to download.',
  },
};

function showPreset() {
  $('preset-hint').textContent = PRESETS[els.preset.value].hint;
  els.downloadBtn.textContent = els.preset.value === 'advanced' ? 'Show formats' : 'Download';
}
els.preset.addEventListener('change', showPreset);
showPreset();

function presetOptions() {
  const { hint, ...preset } = PRESETS[els.preset.value];
  return { ...baseOptions(), ...preset };
}

async function run(label, task) {
  if (els.mode.value === 'extension' && !(await refreshExtension())?.allowed) {
    $('settings').open = true;
    log(`ERROR: ${els.extStatus.textContent}`, 'error');
    return { ok: false };
  }
  busy = true;
  refreshButtons();
  els.progress.hidden = false;
  els.progressLabel.textContent = label;
  els.bar.removeAttribute('value');
  try {
    const result = await task();
    if (!result.ok && result.error) log(`ERROR: ${result.error}`, 'error');
    return result;
  } finally {
    busy = false;
    refreshButtons();
    els.progress.hidden = true;
  }
}

// ----------------------------------------------------------- format picker

const isCompatibleVideo = (f) => /^(avc|h264)/.test(f.vcodec ?? '');
const isCompatibleAudio = (f) => /^(mp4a|aac)/.test(f.acodec ?? '');
const hasVideo = (f) => f.vcodec && f.vcodec !== 'none';
const hasAudio = (f) => f.acodec && f.acodec !== 'none';
const kbps = (n) => (n ? `${Math.round(n)} kbit/s` : '');

// The URL whose formats are on screen, and whether they came from a full
// extraction that the download can reuse.
let picker = { url: null, reusable: false };

function formatRow(f, kind) {
  const row = document.createElement('tr');
  row.dataset.id = f.format_id;
  row.dataset.kind = kind;
  row.dataset.muxed = String(hasVideo(f) && hasAudio(f));
  const compatibleRow =
    kind === 'video' ? isCompatibleVideo(f) && (!hasAudio(f) || isCompatibleAudio(f)) : isCompatibleAudio(f);
  const cells =
    kind === 'video'
      ? [
          f.format_id,
          [f.resolution, f.fps ? `${Math.round(f.fps)} fps` : '', f.dynamic_range === 'SDR' ? '' : f.dynamic_range].filter(Boolean).join(' · '),
          hasAudio(f) ? `${f.vcodec} + ${f.acodec}` : f.vcodec,
          f.ext,
          kbps(f.tbr ?? f.vbr),
          formatBytes(f.filesize ?? f.filesize_approx),
        ]
      : [f.format_id, f.language, f.acodec, f.ext, kbps(f.abr ?? f.tbr), formatBytes(f.filesize ?? f.filesize_approx)];
  for (const value of cells) {
    row.append(Object.assign(document.createElement('td'), { textContent: value ?? '' }));
  }
  const note = document.createElement('td');
  const notes = [f.format_note, hasVideo(f) && hasAudio(f) ? 'includes audio' : ''].filter(Boolean).join(' · ');
  if (compatibleRow) note.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: 'compatible' }), ' ');
  note.append(notes);
  row.append(note);
  return row;
}

function emptyRow(text) {
  const row = document.createElement('tr');
  row.append(Object.assign(document.createElement('td'), { colSpan: 7, className: 'empty', textContent: text }));
  return row;
}

function syncSelector() {
  const ids = ['video', 'audio']
    .map((kind) => $(`${kind}-formats`).querySelector('tr[aria-selected="true"]')?.dataset.id)
    .filter(Boolean);
  els.custom.value = ids.join('+');
  refreshButtons();
}

function selectRow(row) {
  for (const other of row.parentElement.querySelectorAll('tr[aria-selected="true"]')) {
    if (other !== row) other.removeAttribute('aria-selected');
  }
  row.toggleAttribute('aria-selected');
  if (row.hasAttribute('aria-selected')) {
    row.setAttribute('aria-selected', 'true');
    // A format that already contains audio is a whole file; do not add a second track to it
    const clash =
      row.dataset.kind === 'audio'
        ? els.videoFormats.querySelector('tr[aria-selected="true"][data-muxed="true"]')
        : row.dataset.muxed === 'true' && els.audioFormats.querySelector('tr[aria-selected="true"]');
    if (clash) clash.removeAttribute('aria-selected');
  }
  syncSelector();
}

for (const body of [els.videoFormats, els.audioFormats]) {
  body.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-id]');
    if (row) selectRow(row);
  });
}
els.custom.addEventListener('input', refreshButtons);

// `info` is either a full extraction result or just {formats} (when a preset
// found nothing suitable and yt-dlp handed back what exists).
function showPicker(url, info, { notice = '', reusable = false } = {}) {
  // A playlist has no formats of its own; show the first entry's
  const item = info.formats?.length ? info : (info.entries?.[0] ?? info);
  picker = { url, reusable: reusable && !info.entries };

  els.media.hidden = !info.title;
  els.title.textContent = info.title ?? '';
  els.meta.textContent = [
    info.uploader ?? info.channel,
    info.duration_string,
    info.extractor_key,
    info.entries ? `${info.entries.length} entries; the choice below applies to each` : null,
  ].filter(Boolean).join(' · ');
  els.thumb.hidden = !item.thumbnail;
  if (item.thumbnail) els.thumb.src = item.thumbnail;
  els.pickerNotice.hidden = !notice;
  els.pickerNotice.textContent = notice;

  // yt-dlp lists formats worst first; show the best at the top
  const formats = [...(item.formats ?? [])].reverse().filter((f) => hasVideo(f) || hasAudio(f));
  const videos = formats.filter(hasVideo);
  const audios = formats.filter((f) => !hasVideo(f));
  els.videoFormats.replaceChildren(...(videos.length ? videos.map((f) => formatRow(f, 'video')) : [emptyRow('No video formats')]));
  els.audioFormats.replaceChildren(...(audios.length ? audios.map((f) => formatRow(f, 'audio')) : [emptyRow('No separate audio formats')]));

  // Start from the closest thing to the compatible preset. Formats are already
  // ordered by yt-dlp's preference, which puts the original audio track first.
  const video = videos.find(isCompatibleVideo) ?? videos[0];
  const audio = audios.find(isCompatibleAudio) ?? audios[0];
  const rowFor = (f) => f && document.querySelector(`#info tr[data-id="${CSS.escape(f.format_id)}"]`);
  if (video) selectRow(rowFor(video));
  if (audio && !(video && hasAudio(video))) selectRow(rowFor(audio));
  syncSelector();

  els.preset.value = 'advanced';
  showPreset();
  els.info.hidden = false;
  els.info.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ----------------------------------------------------------------- actions

async function loadFormats(url) {
  const result = await run('Looking up formats…', () => call('extract', url, baseOptions()));
  if (result.ok) showPicker(url, result.info, { reusable: true });
}

async function download(url, options) {
  const result = await run('Extracting…', () => call('download', url, options));
  if (result.needs_choice) {
    log('Nothing matches the selected preset; choose from the available formats.', 'warning');
    showPicker(url, { formats: result.formats }, {
      notice: 'This video has no format that fits the selected preset. Choose what to download instead.',
    });
  }
}

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!ready || busy) return;
  const url = els.url.value.trim();
  if (els.preset.value === 'advanced') await loadFormats(url);
  else await download(url, presetOptions());
});

els.pickedBtn.addEventListener('click', async () => {
  if (!ready || busy) return;
  // The table belongs to the URL it was loaded for, even if the box was edited since
  await download(picker.url, {
    ...baseOptions(),
    format: els.custom.value.trim(),
    reuse_info: picker.reusable,
  });
});

// yt-dlp blocks its worker while it runs, so the only way to stop it is to
// throw the worker away and boot a fresh one.
els.cancelBtn.addEventListener('click', () => {
  worker.terminate();
  for (const resolve of pending.values()) resolve({ ok: false, error: 'Cancelled' });
  pending.clear();
  startWorker();
});

async function start() {
  // The worker's requests only pass through sw.js if the page was already
  // controlled when the worker was created.
  if (navigator.serviceWorker) {
    try {
      await navigator.serviceWorker.register('./sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
          setTimeout(resolve, 3000);
        });
      }
    } catch (err) {
      log(`Service worker unavailable (${err.message}); extension mode will not work.`, 'warning');
    }
  }
  await initNetworkMode();
  startWorker();
}

start();

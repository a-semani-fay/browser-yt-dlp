const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  statusText: $('status-text'),
  form: $('form'),
  url: $('url'),
  infoBtn: $('info-btn'),
  downloadBtn: $('download-btn'),
  preset: $('preset'),
  customWrap: $('custom-wrap'),
  custom: $('custom'),
  proxy: $('proxy'),
  mode: $('mode'),
  proxyWrap: $('proxy-wrap'),
  extStatus: $('ext-status'),
  verbose: $('verbose'),
  info: $('info'),
  thumb: $('thumb'),
  title: $('title'),
  meta: $('meta'),
  formats: $('formats'),
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

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'browser-yt-dlp-extension') return;
  extWaiting.get(event.data.id)?.(event.data);
  extWaiting.delete(event.data.id);
});

function askExtension(type, request, timeoutMs) {
  return new Promise((resolve) => {
    const id = ++extSeq;
    extWaiting.set(id, resolve);
    window.postMessage({ source: 'browser-yt-dlp-page', id, type, request }, location.origin);
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

async function refreshExtension() {
  extension = await askExtension('ping', undefined, 400);
  els.proxyWrap.hidden = els.mode.value !== 'proxy';
  els.extStatus.hidden = els.mode.value !== 'extension';
  if (!navigator.serviceWorker) {
    els.extStatus.textContent = 'This browser or context has no service workers, which extension mode needs.';
  } else if (!extension) {
    els.extStatus.textContent =
      'Extension not detected. Load the extension/ folder from the repository as an unpacked extension, then reload this page.';
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

els.preset.addEventListener('change', () => {
  els.customWrap.hidden = els.preset.value !== 'custom';
});

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
  els.infoBtn.disabled = els.downloadBtn.disabled = !ready || busy;
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

function downloadOptions() {
  const options = baseOptions();
  const preset = els.preset.value;
  if (preset === 'mp3') {
    options.format = 'ba/b';
    options.postprocessors = [{ key: 'FFmpegExtractAudio', preferredcodec: 'mp3', preferredquality: '192' }];
  } else if (preset === 'custom') {
    options.format = els.custom.value.trim() || 'bv*+ba/b';
  } else {
    options.format = preset;
  }
  return options;
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

// ----------------------------------------------------------------- actions

function renderInfo(info) {
  // A playlist has no formats of its own; show the first entry's
  const item = info.formats.length ? info : (info.entries?.[0] ?? info);
  els.title.textContent = info.title ?? info.id ?? 'Untitled';
  els.meta.textContent = [
    info.uploader ?? info.channel,
    info.duration_string,
    info.extractor_key,
    info.entries ? `${info.entries.length} entries` : null,
  ].filter(Boolean).join(' · ');
  els.thumb.hidden = !item.thumbnail;
  if (item.thumbnail) els.thumb.src = item.thumbnail;

  els.formats.replaceChildren(
    ...item.formats.map((f) => {
      const row = document.createElement('tr');
      row.dataset.id = f.format_id;
      row.dataset.kind = f.vcodec && f.vcodec !== 'none' ? 'video' : 'audio';
      const cells = [
        f.format_id,
        f.ext,
        f.resolution,
        f.vcodec === 'none' ? '' : f.vcodec,
        f.acodec === 'none' ? '' : f.acodec,
        formatBytes(f.filesize ?? f.filesize_approx),
        f.format_note,
      ];
      for (const value of cells) {
        const cell = document.createElement('td');
        cell.textContent = value ?? '';
        row.append(cell);
      }
      return row;
    }),
  );
  els.info.hidden = false;
}

els.formats.addEventListener('click', (event) => {
  const row = event.target.closest('tr');
  if (!row) return;
  const selected = row.getAttribute('aria-selected') === 'true';
  // One video and one audio format at most, like "137+140"
  for (const other of els.formats.querySelectorAll(`tr[data-kind="${row.dataset.kind}"]`)) {
    other.removeAttribute('aria-selected');
  }
  if (!selected) row.setAttribute('aria-selected', 'true');

  const picked = [...els.formats.querySelectorAll('tr[aria-selected="true"]')];
  picked.sort((a) => (a.dataset.kind === 'video' ? -1 : 1));
  els.preset.value = 'custom';
  els.customWrap.hidden = false;
  els.custom.value = picked.map((r) => r.dataset.id).join('+');
});

els.infoBtn.addEventListener('click', async () => {
  if (!els.form.reportValidity()) return;
  const result = await run('Extracting…', () => call('extract', els.url.value.trim(), baseOptions()));
  if (result.ok) renderInfo(result.info);
});

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!ready || busy) return;
  await run('Extracting…', () => call('download', els.url.value.trim(), downloadOptions()));
});

// yt-dlp blocks its worker while it runs, so the only way to stop it is to
// throw the worker away and boot a fresh one.
els.cancelBtn.addEventListener('click', () => {
  worker.terminate();
  for (const resolve of pending.values()) resolve({ ok: false, error: 'Cancelled' });
  pending.clear();
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

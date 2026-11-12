// Does the HTTP requests a web page is not allowed to do itself.
//
// An extension with host permissions is exempt from CORS, so this is the same
// job as proxy/worker.mjs, only it runs in the user's own browser. The reply
// uses the same x-proxy-* convention, so the page cannot tell the difference.
//
// Only origins the user has switched on (toolbar button) are served.

const DEFAULT_ORIGINS = ['http://localhost:8000', 'http://127.0.0.1:8000'];
const RULE_ID = 1;
const SELF = `chrome-extension://${chrome.runtime.id}`;

// Headers fetch() refuses to set. They are applied with a short-lived
// declarativeNetRequest rule instead.
const VIA_RULE = /^(cookie|origin|referer|user-agent|sec-.*|dnt)$/;
const NEVER = /^(host|connection|content-length|accept-encoding|transfer-encoding|keep-alive|upgrade|te|trailer|via|expect|date|proxy-.*|access-control-.*)$/;
const DROP_RESPONSE = /^(set-cookie|location|connection|keep-alive|transfer-encoding|access-control-.*)$/;

async function allowedOrigins() {
  const { origins } = await chrome.storage.local.get('origins');
  return origins ?? DEFAULT_ORIGINS;
}

// fetch() hides Set-Cookie and the target of an unfollowed redirect; the
// webRequest observer sees both.
let observed = null;
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (observed && details.initiator === SELF) {
      observed.status = details.statusCode;
      observed.headers = details.responseHeaders ?? [];
    }
  },
  { urls: ['<all_urls>'], tabId: -1 },
  ['responseHeaders', 'extraHeaders'],
);

function toBase64(bytes) {
  if (bytes.toBase64) return bytes.toBase64();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function relay({ url, method, headers, body }) {
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Only http(s) URLs are supported');

  const direct = {};
  const viaRule = [];
  let hasOrigin = false;
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (NEVER.test(lower)) continue;
    if (VIA_RULE.test(lower)) {
      viaRule.push({ header: lower, operation: 'set', value: String(value) });
      hasOrigin ||= lower === 'origin';
    } else {
      direct[name] = String(value);
    }
  }
  // Otherwise the request would announce "Origin: chrome-extension://..."
  if (!hasOrigin) viaRule.push({ header: 'origin', operation: 'remove' });

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [{
      id: RULE_ID,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: viaRule },
      condition: { initiatorDomains: [chrome.runtime.id], tabIds: [-1], resourceTypes: ['xmlhttprequest', 'other'] },
    }],
  });

  observed = {};
  try {
    const response = await fetch(target, {
      method,
      headers: direct,
      body: body ? fromBase64(body) : undefined,
      redirect: 'manual', // yt-dlp follows redirects itself so cookies apply per hop
      credentials: 'omit', // yt-dlp's cookie jar is the only one in play
      cache: 'no-store',
    });
    const bytes = new Uint8Array(await response.arrayBuffer());

    const status = observed.status ?? response.status;
    const raw = observed.headers ?? [...response.headers].map(([name, value]) => ({ name, value }));
    const find = (wanted) => raw.filter((h) => h.name.toLowerCase() === wanted).map((h) => h.value ?? '');
    // fetch() already decoded the body
    const decoded = find('content-encoding').length > 0;

    const out = [];
    for (const { name, value } of raw) {
      const lower = name.toLowerCase();
      if (DROP_RESPONSE.test(lower)) continue;
      if (decoded && (lower === 'content-encoding' || lower === 'content-length')) continue;
      out.push([name, value ?? '']);
    }
    out.push(['x-proxy-status', String(status)]);
    const cookies = find('set-cookie');
    if (cookies.length) out.push(['x-proxy-set-cookie', encodeURIComponent(JSON.stringify(cookies))]);

    const [location] = find('location');
    if (status >= 300 && status < 400 && location) {
      out.push(['x-proxy-location', location]);
      return { status: 200, headers: out, bodyB64: '' };
    }
    return { status, headers: out, bodyB64: toBase64(bytes) };
  } finally {
    observed = null;
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID] });
  }
}

// One request at a time: the header rule and the observer are shared state
let queue = Promise.resolve();
const enqueue = (task) => {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const origin = sender.origin ?? new URL(sender.url).origin;
    const allowed = (await allowedOrigins()).includes(origin);
    if (message.type === 'ping') return { installed: true, allowed, version: chrome.runtime.getManifest().version };
    if (!allowed) return { error: 'This site is not enabled in the browser-yt-dlp extension. Click its toolbar button.' };
    if (message.type === 'fetch') return enqueue(() => relay(message.request));
    return { error: `Unknown request: ${message.type}` };
  })().then(sendResponse, (err) => sendResponse({ error: String(err?.message ?? err) }));
  return true; // answer asynchronously
});

// ---- toolbar button: switch the current site on or off ---------------------

async function showState(tabId, url) {
  let on = false;
  try {
    on = (await allowedOrigins()).includes(new URL(url).origin);
  } catch {
    // not a web page
  }
  await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#1a7f4b' });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !/^https?:/.test(tab.url)) return;
  const origin = new URL(tab.url).origin;
  const origins = await allowedOrigins();
  const next = origins.includes(origin) ? origins.filter((o) => o !== origin) : [...origins, origin];
  await chrome.storage.local.set({ origins: next });
  await showState(tab.id, tab.url);
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === 'complete' && tab.url) showState(tabId, tab.url);
});

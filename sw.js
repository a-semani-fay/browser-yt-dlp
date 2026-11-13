// Turns the worker's blocking XHR into something that can wait for the
// companion extension.
//
// yt-dlp runs synchronously in a Web Worker, and the only blocking call a
// worker has is a synchronous XHR. Talking to an extension is asynchronous.
// A service worker sits exactly between the two: the XHR to
// <site>/__bridge/fetch stays open while we ask a page to pass the request to
// the extension, and completes when the answer comes back.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.endsWith('/__bridge/fetch')) {
    event.respondWith(bridge(event.request, url));
  }
});

const fail = (message) => new Response(message, { status: 502, headers: { 'x-bridge-error': '1' } });

async function bridge(request, url) {
  try {
    const pages = await self.clients.matchAll({ type: 'window' });
    const page = pages.find((client) => client.focused) ?? pages[0];
    if (!page) return fail('No open browser-yt-dlp page to reach the extension through');

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const message = {
      type: 'bridge-fetch',
      request: {
        url: url.searchParams.get('url'),
        headers: JSON.parse(url.searchParams.get('h') || '{}'),
        method: request.method,
        body: hasBody ? await request.arrayBuffer() : null,
      },
    };
    const reply = await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data);
      page.postMessage(message, [channel.port2]);
    });
    if (reply.error) return fail(reply.error);

    const headers = new Headers();
    for (const [name, value] of reply.headers) {
      try {
        headers.append(name, value);
      } catch {
        // a name or value the Headers class rejects
      }
    }
    const status = reply.status >= 200 && reply.status <= 599 ? reply.status : 502;
    const noBody = request.method === 'HEAD' || [204, 205, 304].includes(status);
    return new Response(noBody ? null : reply.body, { status, headers });
  } catch (err) {
    return fail(String(err?.message ?? err));
  }
}

// CORS proxy for browser-yt-dlp.
//
// A static page cannot read responses from sites that do not opt in with CORS
// headers (YouTube and nearly every other video site), and it cannot set
// headers such as User-Agent, Cookie or Referer. This tiny relay does both.
//
// It is written against the web-standard Request/Response API, so the same
// file is a Cloudflare Worker (`wrangler deploy`) and the `/proxy` route of
// the local dev server (scripts/dev-server.mjs).
//
//   GET|POST|HEAD  <proxy>?url=<target>&h=<JSON object of request headers>
//
// The reply carries the upstream body and headers, plus:
//   x-proxy-status      the real upstream status
//   x-proxy-location    Location of a redirect (redirects are not followed,
//                       so yt-dlp can apply cookies to every hop itself)
//   x-proxy-set-cookie  URI-encoded JSON array of the Set-Cookie headers

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, HEAD, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*',
  'access-control-max-age': '86400',
};

// Headers we never forward upstream, whatever the client asked for
const DROP_REQUEST = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding']);
// Headers we never copy back
const DROP_RESPONSE = new Set([
  'set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'location',
  'content-security-policy', 'content-security-policy-report-only', 'report-to', 'nel',
]);

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\..*|10\..*|192\.168\..*|169\.254\..*|172\.(1[6-9]|2\d|3[01])\..*|0\.0\.0\.0|\[.*\])$/i;

const fail = (status, message) =>
  new Response(message + '\n', { status, headers: { ...CORS, 'content-type': 'text/plain' } });

/**
 * @param {Request} request
 * @param {{allowedOrigins?: string, allowPrivateHosts?: boolean}} [config]
 */
export async function handleProxy(request, config = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const allowed = (config.allowedOrigins ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(request.headers.get('origin') ?? '')) {
    return fail(403, 'This origin is not allowed to use this proxy');
  }

  const params = new URL(request.url).searchParams;
  let target;
  try {
    target = new URL(params.get('url') ?? '');
  } catch {
    return fail(400, 'Usage: ?url=<http(s) URL>&h=<JSON request headers>');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return fail(400, 'Only http(s) URLs can be proxied');
  }
  if (!config.allowPrivateHosts && PRIVATE_HOST.test(target.hostname)) {
    return fail(403, 'Refusing to proxy to a private address');
  }

  const headers = new Headers();
  try {
    for (const [name, value] of Object.entries(JSON.parse(params.get('h') || '{}'))) {
      if (!DROP_REQUEST.has(name.toLowerCase())) headers.set(name, String(value));
    }
  } catch {
    return fail(400, 'h must be a JSON object');
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
    });
  } catch (err) {
    return fail(502, `Upstream request failed: ${err?.cause?.message ?? err?.message ?? err}`);
  }

  const out = new Headers(CORS);
  // fetch() already decoded the body, so the encoding headers no longer apply
  const decoded = upstream.headers.has('content-encoding');
  for (const [name, value] of upstream.headers) {
    if (DROP_RESPONSE.has(name) || name.startsWith('access-control-')) continue;
    if (decoded && (name === 'content-encoding' || name === 'content-length')) continue;
    out.set(name, value);
  }
  out.set('x-proxy-status', String(upstream.status));
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length) out.set('x-proxy-set-cookie', encodeURIComponent(JSON.stringify(cookies)));

  const location = upstream.headers.get('location');
  if (upstream.status >= 300 && upstream.status < 400 && location) {
    // Hand the redirect to the client as data; the browser must not follow it
    out.set('x-proxy-location', location);
    out.delete('content-length');
    return new Response(null, { status: 200, headers: out });
  }

  const nullBody = request.method === 'HEAD' || [101, 204, 205, 304].includes(upstream.status);
  return new Response(nullBody ? null : upstream.body, { status: upstream.status, headers: out });
}

// Cloudflare Workers entry point. Set ALLOWED_ORIGINS (comma separated, e.g.
// "https://you.github.io") so that only your site can use the relay.
export default {
  fetch: (request, env) => handleProxy(request, { allowedOrigins: env?.ALLOWED_ORIGINS }),
};

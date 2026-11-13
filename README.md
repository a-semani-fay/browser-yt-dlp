# browser-yt-dlp

[yt-dlp](https://github.com/yt-dlp/yt-dlp) running inside a static website. Extraction,
downloading, merging and conversion all happen in the visitor's browser tab; the site itself
is plain files that any static host can serve.

| yt-dlp needs | On a desktop | Here |
| --- | --- | --- |
| Python | CPython | [Pyodide](https://pyodide.org) (CPython compiled to WebAssembly) running the unmodified yt-dlp wheel |
| ffmpeg / ffprobe | native binaries | [ffmpeg.wasm](https://ffmpegwasm.netlify.app) core, called synchronously in the same worker |
| A JS runtime for YouTube (deno) | `deno` subprocess | the browser's own JS engine runs the same `yt-dlp-ejs` solver scripts |
| Sockets | urllib / requests | synchronous `XMLHttpRequest`, carried out by a companion browser extension or a CORS proxy |

Deno itself is not compiled to WebAssembly: its only job for yt-dlp is to execute JavaScript,
and a browser already is a JavaScript runtime.

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Open <http://localhost:8000/>. The dev server serves `dist/` and a same-origin CORS proxy at
`/proxy`, which the page uses automatically on localhost.

`npm run build` assembles the deployable site in `dist/` (about 45 MB, most of it
`ffmpeg-core.wasm`). Set `YTDLP_VERSION=2026.10.26` to pin yt-dlp; by default the build takes
the latest release from PyPI together with the `yt-dlp-ejs` version that release requires.
`npm test` runs the Python shim against the real yt-dlp under Pyodide in Node.

## Getting past CORS (read this before deploying)

The site is static, but one thing cannot be done from a static page: browsers do not let a
page read responses from another site unless that site opts in, and YouTube and almost every
other video site do not. Scripts also cannot set headers such as `User-Agent`, `Cookie` or
`Referer`.

This cannot be solved with more WebAssembly. WASM has no network access of its own; every
request it makes leaves through the browser's `fetch`/XHR, which is where the restriction is
enforced. A proxy compiled to WASM would be blocked exactly like the page. Something outside
the page has to make the requests, and there are two choices, selectable under **Settings →
Network access**.

### Option 1: companion extension (everything stays on the client)

Browser extensions are exempt from CORS for the hosts they are granted. `extension/` is a
small extension that makes the requests from the visitor's own browser, so no server is
involved and sites see the visitor's own IP address.

**Chrome, Edge and other Chromium browsers**

1. Open `chrome://extensions`, switch on **Developer mode**, choose **Load unpacked** and
   select the `extension/` folder.
2. Open the site and click the extension's toolbar button to enable it for that site (the
   badge shows **ON**). `http://localhost:8000` is enabled by default.
3. Reload the page. Settings should say "Extension connected".

**Firefox** (128 or later)

1. Build the Firefox variant, which differs only in its manifest:

   ```bash
   npm run build:firefox
   ```

2. Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…** and select
   `dist-extension/firefox/manifest.json`. A temporary add-on is removed when Firefox closes;
   a permanent install needs the folder signed through addons.mozilla.org.
3. Enable the site with the toolbar button and reload, as above. If the page still says the
   extension is not detected, open `about:addons`, select the extension, and under
   **Permissions** allow it to access all websites.

Both variants are Manifest V3 and share `background.js` and `content.js`. Chromium rewrites
request headers with `declarativeNetRequest` rules; Firefox uses blocking `webRequest`, which
it still supports. The Chromium variant has been tested end to end. **The Firefox variant
passes Mozilla's `web-ext lint` but has not been run in Firefox**, which was not available
where this was built.

The extension holds no yt-dlp logic and only serves origins you have enabled, because a
page it serves can make requests to any site, including ones on your local network. It asks
for access to all sites since yt-dlp supports thousands of them.

How a request travels: yt-dlp (blocking, in a worker) → synchronous XHR to
`<site>/__bridge/fetch` → the site's service worker (`sw.js`) holds that request open → page →
extension content script → extension background worker, which performs the real request and
sends the answer back along the same path. The service worker is what lets blocking Python
wait for an asynchronous extension without `SharedArrayBuffer`.

### Option 2: CORS proxy (nothing to install, needs a server)

`proxy/worker.mjs` is a small relay. It holds no logic about any video site; it forwards a
request with the headers yt-dlp asked for and adds CORS headers to the reply. Deploy it as a
Cloudflare Worker:

```bash
cd proxy && npx wrangler deploy
```

Set `ALLOWED_ORIGINS` in `proxy/wrangler.toml` to your site's origin so the relay is not open
to everyone, then choose **CORS proxy** in Settings and paste the worker URL (it is remembered
in `localStorage`). A third-party proxy can be used with a `{url}` placeholder, e.g.
`https://proxy.example/?url={url}`, but it will not forward request headers or cookies, which
many extractors need.

All traffic, including the media itself, passes through the relay, so its bandwidth limits and
its IP address reputation apply. Sites that block datacenter IPs (YouTube frequently does, with
"Sign in to confirm you're not a bot") will block a hosted relay too. The local dev server
includes this relay at `/proxy` and uses your own connection.

**Direct** mode uses neither and only works for sites that send CORS headers themselves.

## Deploying the site

`dist/` can be uploaded to any static host. For GitHub Pages, `.github/workflows/pages.yml`
builds and publishes it on every push to `main` and once a week (to pick up new yt-dlp
releases); enable it under **Settings → Pages → Source: GitHub Actions**. No special headers
(COOP/COEP) are required, because nothing here uses `SharedArrayBuffer`.

## How it works

```
index.html / app.js          UI; talks to the worker with postMessage
worker.js                    loads Pyodide + ffmpeg.wasm, exposes a "bridge" to Python
py/browser_ytdlp.py          registers the browser backends with yt-dlp
sw.js                        holds the worker's blocking requests open for the extension
extension/                   companion extension that makes the cross-origin requests
proxy/worker.mjs             CORS relay (Cloudflare Worker, also used by the dev server)
```

yt-dlp is synchronous code, so everything it calls must be synchronous too. It therefore runs
in a Web Worker where blocking is allowed, and `py/browser_ytdlp.py` plugs into yt-dlp's own
extension points rather than patching its source:

- **Network** – `BrowserRH`, a yt-dlp `RequestHandler`, sends each request as a synchronous
  XHR to the extension bridge or the proxy, which speak the same protocol. Redirects and cookies are handled in Python so cookies apply to every hop. Because a
  synchronous XHR returns its body in one piece, plain GETs are transparently fetched in 10 MB
  ranges as the caller reads, and downloads use `http_chunk_size`.
- **ffmpeg** – `Popen.run` is intercepted. `ffmpeg` and `ffprobe` commands are executed by
  ffmpeg.wasm; input files are copied from Pyodide's filesystem into ffmpeg's and outputs are
  copied back. Any other subprocess fails as "not found", which yt-dlp already handles.
- **JS runtime** – a `browser` runtime and `BrowserJCP` challenge provider are registered
  next to yt-dlp's deno/node/bun/quickjs ones and evaluate the solver script in the worker.
- **Output** – finished files are transferred to the page and offered as downloads.

## Limitations

- **Memory.** Files live in WebAssembly memory and are copied between the two runtimes while
  ffmpeg runs, so a download needs roughly three times its size in RAM. Expect trouble above a
  few hundred MB, earlier on phones.
- **Speed.** ffmpeg.wasm is single-threaded. Merging (`-c copy`) is fast; re-encoding video is
  slow. Converting audio to MP3 is fine.
- **No sandbox around the challenge solver.** Deno runs the solver with no permissions; here it
  runs in the page's worker. If you use a proxy, use one you trust, since it can alter the
  player script that the solver evaluates.
- **Extension mode moves media through message passing**, 10 MB at a time, which is slower
  than a direct connection.
- **Not available:** browser cookie import (`--cookies-from-browser`), external downloaders,
  impersonation (`curl_cffi`), websockets-based extractors, and concat-list ffmpeg operations.
- **Cancelling** terminates the worker and starts a new one, which takes a few seconds.

## Status

Verified in Chromium against a local test site, once through the companion extension and once
through the proxy: direct downloads (with redirects and cookies), DASH video + audio merged by
ffmpeg.wasm, and audio conversion to MP3. The YouTube
challenge path is verified up to the point where the real `yt-dlp-ejs` solver runs in the
browser engine; a full YouTube download has not been tested, because the environment this was
built in cannot reach YouTube.

Only download content you have the right to download.

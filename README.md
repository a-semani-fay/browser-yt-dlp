# browser-yt-dlp

[yt-dlp](https://github.com/yt-dlp/yt-dlp) running inside a static website. Extraction,
downloading, merging and conversion all happen in the visitor's browser tab; the site itself
is plain files that any static host can serve.

| yt-dlp needs | On a desktop | Here |
| --- | --- | --- |
| Python | CPython | [Pyodide](https://pyodide.org) (CPython compiled to WebAssembly) running the unmodified yt-dlp wheel |
| ffmpeg / ffprobe | native binaries | [ffmpeg.wasm](https://ffmpegwasm.netlify.app) core, called synchronously in the same worker |
| A JS runtime for YouTube (deno) | `deno` subprocess | the browser's own JS engine runs the same `yt-dlp-ejs` solver scripts |
| Sockets | urllib / requests | synchronous `XMLHttpRequest`, optionally through a CORS proxy |

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

## The CORS proxy (read this before deploying)

The site is static, but one thing cannot be done from a static page: browsers do not let a
page read responses from another site unless that site opts in, and YouTube and almost every
other video site do not. Scripts also cannot set headers such as `User-Agent`, `Cookie` or
`Referer`. There is no client-side way around either restriction.

So requests go through a small relay, `proxy/worker.mjs`. It holds no logic about any video
site; it forwards a request with the headers yt-dlp asked for and adds CORS headers to the
reply. Deploy it as a Cloudflare Worker:

```bash
cd proxy && npx wrangler deploy
```

Set `ALLOWED_ORIGINS` in `proxy/wrangler.toml` to your site's origin so the relay is not open
to everyone, then paste the worker URL into **Settings → CORS proxy** on the page (it is
remembered in `localStorage`). Leaving the field empty makes the page talk to sites directly,
which only works for sites that send CORS headers. A third-party proxy can be used with a
`{url}` placeholder, e.g. `https://proxy.example/?url={url}`, but it will not forward request
headers or cookies, which many extractors need.

All traffic, including the media itself, passes through the relay, so its bandwidth limits and
its IP address reputation apply. Sites that block datacenter IPs (YouTube frequently does, with
"Sign in to confirm you're not a bot") will block a hosted relay too; the local dev server
relays from your own connection instead.

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
proxy/worker.mjs             CORS relay (Cloudflare Worker, also used by the dev server)
```

yt-dlp is synchronous code, so everything it calls must be synchronous too. It therefore runs
in a Web Worker where blocking is allowed, and `py/browser_ytdlp.py` plugs into yt-dlp's own
extension points rather than patching its source:

- **Network** – `BrowserRH`, a yt-dlp `RequestHandler`, sends each request as a synchronous
  XHR. Redirects and cookies are handled in Python so cookies apply to every hop. Because a
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
  runs in the page's worker. Use a proxy you trust, since the proxy can alter the player script
  that the solver evaluates.
- **Not available:** browser cookie import (`--cookies-from-browser`), external downloaders,
  impersonation (`curl_cffi`), websockets-based extractors, and concat-list ffmpeg operations.
- **Cancelling** terminates the worker and starts a new one, which takes a few seconds.

## Status

Verified in headless Chromium against a local test site: direct downloads (with redirects and
cookies), DASH video + audio merged by ffmpeg.wasm, and audio conversion to MP3. The YouTube
challenge path is verified up to the point where the real `yt-dlp-ejs` solver runs in the
browser engine; a full YouTube download has not been tested, because the environment this was
built in cannot reach YouTube.

Only download content you have the right to download.

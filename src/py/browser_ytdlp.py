"""Glue that lets an unmodified yt-dlp run inside Pyodide in a Web Worker.

yt-dlp expects three things a browser tab does not have:

* sockets            -> BrowserRH sends every request with a synchronous XHR
                        (optionally through a CORS proxy)
* an ffmpeg binary   -> Popen.run is intercepted and handed to ffmpeg.wasm
* a JS runtime       -> the "browser" runtime runs yt-dlp-ejs in the JS
                        engine that is already hosting us, instead of deno

Everything browser-specific goes through ``js.__ytdlpBridge`` (see worker.js),
so this file can also be driven from Node with a mock bridge.
"""
from __future__ import annotations

import http.cookiejar
import io
import json
import os
import subprocess
import traceback
import urllib.parse
import urllib.request
from email.message import Message

import js
import yt_dlp
from pyodide.ffi import to_js
from yt_dlp.extractor.youtube.jsc._builtin.ejs import EJSBaseJCP
from yt_dlp.extractor.youtube.jsc.provider import (
    JsChallengeProviderError,
    register_preference as register_jcp_preference,
    register_provider,
)
from yt_dlp.extractor.youtube.pot._provider import BuiltinIEContentProvider
from yt_dlp.globals import supported_js_runtimes
from yt_dlp.networking.common import (
    RequestHandler,
    Response,
    register_preference as register_rh_preference,
    register_rh,
)
from yt_dlp.networking.exceptions import HTTPError, RequestError, TransportError
from yt_dlp.utils import Popen
from yt_dlp.utils._jsruntime import JsRuntime, JsRuntimeInfo

bridge = js.__ytdlpBridge
WORK_DIR = '/work'

# --------------------------------------------------------------------------
# Networking
# --------------------------------------------------------------------------

_config = {'proxy': ''}

# Without a proxy only CORS-safelisted-ish headers are worth sending: anything
# else is either forbidden for scripts or turns the request into a preflight
# that almost no media host answers.
_DIRECT_HEADERS = {'accept', 'accept-language', 'content-type', 'range'}
_MAX_REDIRECTS = 10
# A synchronous XHR hands over its body in one piece, so anything large has to
# be pulled in ranges or it would sit in memory whole (several times over).
_RANGE_CHUNK = 10 * 1024 * 1024


def _proxied_url(url, headers):
    proxy = _config['proxy']
    if not proxy:
        return url
    quoted = urllib.parse.quote(url, safe='')
    if '{url}' in proxy:  # third-party proxy with its own URL shape
        return proxy.replace('{url}', quoted)
    # Headers travel in the query string so the request stays "simple" and
    # the browser does not send a preflight for every single URL.
    sep = '&' if '?' in proxy else '?'
    return f'{proxy}{sep}url={quoted}&h={urllib.parse.quote(json.dumps(headers), safe="")}'


class _CookieResponse:
    """The slice of an HTTP response that http.cookiejar wants to see."""

    def __init__(self, set_cookies):
        self._msg = Message()
        for value in set_cookies:
            self._msg['Set-Cookie'] = value

    def info(self):
        return self._msg


class _RangedBody(io.RawIOBase):
    """Body of a plain GET, fetched lazily in ranges as the caller reads it."""

    def __init__(self, first, total, fetch_range):
        self._buf = memoryview(first)
        self._pos = len(first)
        self._total = total
        self._fetch_range = fetch_range

    def readable(self):
        return True

    def readinto(self, b):
        if not self._buf:
            if self._pos >= self._total:
                return 0
            end = min(self._pos + _RANGE_CHUNK, self._total) - 1
            status, body = self._fetch_range(self._pos, end)
            if status != 206 or not body:
                raise OSError(f'range request for bytes {self._pos}-{end} failed (HTTP {status})')
            self._buf = memoryview(body)
            self._pos += len(body)
        n = min(len(b), len(self._buf))
        b[:n] = self._buf[:n]
        self._buf = self._buf[n:]
        return n


@register_rh
class BrowserRH(RequestHandler):
    """Sends requests with synchronous XMLHttpRequest from the worker."""

    RH_NAME = 'browser'
    _SUPPORTED_URL_SCHEMES = ('http', 'https')
    _SUPPORTED_PROXY_SCHEMES = ()
    _SUPPORTED_FEATURES = ()

    def _check_extensions(self, extensions):
        super()._check_extensions(extensions)
        for name in ('cookiejar', 'timeout', 'legacy_ssl', 'keep_header_casing'):
            extensions.pop(name, None)

    def _fetch(self, url, method, headers, data, timeout):
        if _config['proxy']:
            send_headers = {}
        else:
            send_headers = {k: v for k, v in headers.items() if k.lower() in _DIRECT_HEADERS}
        try:
            raw = bridge.fetchSync(
                _proxied_url(url, headers), method, json.dumps(send_headers),
                to_js(data) if data else None, int(timeout * 1000))
        except Exception as e:
            hint = '' if _config['proxy'] else (
                ' (the site probably does not allow cross-origin requests; configure a CORS proxy)')
            raise TransportError(f'Browser request to {url} failed: {e}{hint}') from e

        res_headers = [(k, v) for k, v in json.loads(raw.headers)]
        body = raw.body.to_py().tobytes()
        status = raw.status

        # Our own proxy reports what the browser would otherwise hide from us
        set_cookies, location = [], None
        plain = []
        for name, value in res_headers:
            lname = name.lower()
            if lname == 'x-proxy-status':
                status = int(value)
            elif lname == 'x-proxy-set-cookie':
                set_cookies = json.loads(urllib.parse.unquote(value))
            elif lname == 'x-proxy-location':
                location = value
            elif not lname.startswith('access-control-'):
                plain.append((name, value))
        return status, plain, body, set_cookies, location

    def _send(self, request):
        headers = dict(self._get_headers(request))
        headers.pop('Accept-Encoding', None)  # the browser/proxy negotiates this
        cookiejar = self._get_cookiejar(request)
        timeout = self._calculate_timeout(request)
        url, method, data = request.url, request.method, request.data
        if data is not None and not isinstance(data, (bytes, bytearray)):
            data = bytes(data) if isinstance(data, memoryview) else b''.join(data)

        # Callers that did not ask for a range get one anyway (see _RangedBody)
        probe = method == 'GET' and data is None and not any(h.lower() == 'range' for h in headers)
        redirects = 0
        while redirects <= _MAX_REDIRECTS:
            hop_headers = dict(headers)
            cookie_req = urllib.request.Request(url, headers=hop_headers, method=method)
            if cookiejar is not None and 'Cookie' not in hop_headers:
                cookiejar.add_cookie_header(cookie_req)
                if cookie_req.has_header('Cookie'):
                    hop_headers['Cookie'] = cookie_req.get_header('Cookie')
            if probe:
                hop_headers['Range'] = f'bytes=0-{_RANGE_CHUNK - 1}'

            status, res_headers, body, set_cookies, location = self._fetch(
                url, method, hop_headers, data, timeout)

            if cookiejar is not None and set_cookies:
                cookiejar.extract_cookies(_CookieResponse(set_cookies), cookie_req)

            if status == 416 and probe:  # e.g. an empty resource; ask again plainly
                probe = False
                continue

            if status in (301, 302, 303, 307, 308) and location:
                redirects += 1
                url = urllib.parse.urljoin(url, location)
                if status == 303 or (status in (301, 302) and method == 'POST'):
                    if method != 'HEAD':
                        method = 'GET'
                    data = None
                    for name in [h for h in headers if h.lower() in ('content-type', 'content-length')]:
                        del headers[name]
                continue

            fp = io.BytesIO(body)
            if status == 206 and probe:
                # Present our own ranging as the ordinary 200 the caller expects
                content_range = next((v for k, v in res_headers if k.lower() == 'content-range'), '')
                total = content_range.rpartition('/')[2]
                total = int(total) if total.isdigit() else len(body)
                if total > len(body):
                    def fetch_range(start, end, url=url, hop_headers=hop_headers):
                        status, _, body, _, _ = self._fetch(
                            url, 'GET', {**hop_headers, 'Range': f'bytes={start}-{end}'}, None, timeout)
                        return status, body
                    fp = io.BufferedReader(_RangedBody(body, total, fetch_range))
                status = 200
                res_headers = [
                    (k, v) for k, v in res_headers if k.lower() not in ('content-range', 'content-length')
                ] + [('Content-Length', str(total))]

            message = Message()
            for name, value in res_headers:
                message[name] = value
            response = Response(fp, url, message, status=status)
            if not 200 <= status < 300:
                raise HTTPError(response)
            return response

        raise HTTPError(
            Response(io.BytesIO(b''), url, {}, status=status), redirect_loop=True)


@register_rh_preference(BrowserRH)
def _browser_rh_preference(handler, request):
    return 1000


# --------------------------------------------------------------------------
# ffmpeg / ffprobe
# --------------------------------------------------------------------------

def _strip_file_prefix(arg):
    return arg[5:] if arg.startswith('file:') else arg


def _run_ffmpeg(prog, args, stderr_to_stdout):
    """Run ffmpeg.wasm on files living in Pyodide's filesystem.

    The two WASM modules have separate filesystems, so inputs are copied in
    before the run and anything new is copied back out afterwards.
    """
    inputs, candidates = [], []
    for arg in args:
        if not arg or arg.startswith('-'):
            continue
        path = os.path.abspath(_strip_file_prefix(arg))
        if os.path.isfile(path):
            inputs.append(path)
        elif os.path.isdir(os.path.dirname(path)) and os.path.splitext(path)[1]:
            candidates.append(path)

    # ffmpeg resolves relative names against its own cwd, which mirrors ours
    result = bridge.runFfmpeg(
        prog, json.dumps([str(a) for a in args]), os.getcwd(),
        json.dumps(inputs), json.dumps(candidates))
    # ffmpeg.wasm reports nearly everything as "stdout", so there is no telling
    # the two streams apart; callers that parse one of them get both.
    output = '\n'.join(msg for _, msg in json.loads(result.logs) if msg != 'Aborted()') + '\n'
    return output, ('' if stderr_to_stdout else output), result.code


def _popen_run(cls, args, *remaining, timeout=None, input=None, **kwargs):
    prog = os.path.splitext(os.path.basename(str(args[0])))[0] if args else ''
    if prog in ('ffmpeg', 'ffprobe') and bridge.hasFfmpeg():
        return _run_ffmpeg(prog, list(args[1:]), kwargs.get('stderr') == subprocess.STDOUT)
    raise FileNotFoundError(f'{prog or args!r}: there are no subprocesses in a browser')


Popen.run = classmethod(_popen_run)


# --------------------------------------------------------------------------
# JavaScript runtime (replaces deno/node/bun/quickjs)
# --------------------------------------------------------------------------

class BrowserJsRuntime(JsRuntime):
    def _info(self):
        return JsRuntimeInfo(
            name='browser', path='browser', version=str(bridge.jsEngine()),
            version_tuple=(1,), supported=True)


supported_js_runtimes.value['browser'] = BrowserJsRuntime


@register_provider
class BrowserJCP(EJSBaseJCP, BuiltinIEContentProvider):
    """Solves YouTube's signature / n challenges in the host JS engine."""

    PROVIDER_NAME = 'browser'
    JS_RUNTIME_NAME = 'browser'

    def _run_js_runtime(self, stdin, /):
        try:
            return str(bridge.runJs(stdin))
        except Exception as e:
            raise JsChallengeProviderError(f'Error running challenge solver in the browser: {e}') from e


@register_jcp_preference(BrowserJCP)
def _browser_jcp_preference(provider, requests):
    return 2000


# --------------------------------------------------------------------------
# Entry points called from worker.js
# --------------------------------------------------------------------------

class _Logger:
    def debug(self, msg):
        # yt-dlp routes both debug and normal screen output through debug()
        _emit('log', level='debug' if msg.startswith('[debug] ') else 'info', message=msg)

    def info(self, msg):
        _emit('log', level='info', message=msg)

    def warning(self, msg):
        _emit('log', level='warning', message=msg)

    def error(self, msg):
        _emit('log', level='error', message=msg)


def _emit(kind, **payload):
    bridge.emit(kind, json.dumps(payload, default=str))


_PROGRESS_KEYS = (
    'status', 'filename', 'downloaded_bytes', 'total_bytes', 'total_bytes_estimate',
    'speed', 'eta', 'elapsed', 'fragment_index', 'fragment_count')


def _progress_hook(d):
    info = d.get('info_dict') or {}
    _emit('progress', format_id=info.get('format_id'), **{k: d.get(k) for k in _PROGRESS_KEYS})


def _postprocessor_hook(d):
    _emit('postprocess', status=d.get('status'), postprocessor=d.get('postprocessor'))


def _base_options(options):
    os.makedirs(WORK_DIR, exist_ok=True)
    os.chdir(WORK_DIR)
    _config['proxy'] = (options.pop('cors_proxy', None) or '').strip()
    opts = {
        'logger': _Logger(),
        'noprogress': True,
        'color': 'never',
        'js_runtimes': {'browser': {}},
        'cachedir': False,
        'cookiefile': None,
        # Each request is buffered whole in memory, so keep downloads chunked
        'http_chunk_size': 10 * 1024 * 1024,
        'outtmpl': {'default': '%(title).150B [%(id)s].%(ext)s'},
        'restrictfilenames': False,
        'retries': 3,
        'fragment_retries': 3,
        'socket_timeout': 60,
    }
    opts.update(options)
    return opts


_INFO_KEYS = (
    'id', 'title', 'uploader', 'channel', 'duration', 'duration_string', 'thumbnail',
    'webpage_url', 'extractor_key', 'description', 'upload_date', 'view_count', '_type')
_FORMAT_KEYS = (
    'format_id', 'format_note', 'ext', 'resolution', 'width', 'height', 'fps', 'vcodec',
    'acodec', 'tbr', 'filesize', 'filesize_approx', 'protocol', 'language', 'format')


def _summarize(info):
    out = {k: info.get(k) for k in _INFO_KEYS}
    out['formats'] = [{k: f.get(k) for k in _FORMAT_KEYS} for f in info.get('formats') or []]
    if info.get('entries') is not None:
        out['entries'] = [_summarize(e) for e in info['entries'] if e]
    return out


def _fail(e):
    _emit('log', level='debug', message=traceback.format_exc())
    return json.dumps({'ok': False, 'error': str(e) or type(e).__name__})


def extract(url, options_json):
    """Resolve a URL to metadata + available formats, without downloading."""
    try:
        opts = _base_options(json.loads(options_json))
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.sanitize_info(ydl.extract_info(url, download=False))
        return json.dumps({'ok': True, 'info': _summarize(info)}, default=str)
    except Exception as e:
        return _fail(e)


def download(url, options_json):
    """Download a URL. Returns the paths of the finished files in WORK_DIR."""
    try:
        opts = _base_options(json.loads(options_json))
        opts['progress_hooks'] = [_progress_hook]
        opts['postprocessor_hooks'] = [_postprocessor_hook]
        for name in os.listdir(WORK_DIR):  # leftovers from an aborted run
            path = os.path.join(WORK_DIR, name)
            if os.path.isfile(path):
                os.remove(path)
        with yt_dlp.YoutubeDL(opts) as ydl:
            code = ydl.download([url])
        files = sorted(
            os.path.join(WORK_DIR, name) for name in os.listdir(WORK_DIR)
            if os.path.isfile(os.path.join(WORK_DIR, name))
            and not name.endswith(('.part', '.ytdl')))
        if not files:
            return json.dumps({'ok': False, 'error': 'yt-dlp finished without producing a file'})
        return json.dumps({'ok': True, 'files': files, 'code': code})
    except Exception as e:
        return _fail(e)


def versions():
    info = {'yt-dlp': yt_dlp.version.__version__}
    try:
        import yt_dlp_ejs
        info['yt-dlp-ejs'] = yt_dlp_ejs.version
    except Exception:
        pass
    return json.dumps(info)

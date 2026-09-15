"""Zero-dependency HTTP server.

Sockets, headers, Server-Sent Events, static files and the same-origin check.
The routes themselves live in `routes.py`; this file has no idea what any of
them do.

Analysis endpoints stream Server-Sent Events so Claude's reply appears a token
at a time rather than landing as a wall of text after a silent wait.
"""

from __future__ import annotations

import json
import mimetypes
import os
import posixpath
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .routes import Routes
from .session import Session

WEB_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")


# Any host name that can only mean this machine.
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


class Handler(Routes, BaseHTTPRequestHandler):
    server_version = "steinsgit"
    protocol_version = "HTTP/1.1"
    session: Session  # injected on the server instance

    def _local_request(self) -> bool:
        """Reject anything a page on another site could have caused.

        This server answers on localhost with no login, and several of its
        endpoints create branches or spend money on model calls. Two attacks
        are worth closing: a web page that quietly fetches these URLs in the
        background, and DNS rebinding, where a hostile domain is pointed at
        127.0.0.1 so the browser treats it as same-origin.
        """
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        if host and host not in LOCAL_HOSTS:
            return False
        origin = self.headers.get("Origin")
        if origin:
            where = urlparse(origin).hostname or ""
            if where.strip("[]") not in LOCAL_HOSTS:
                return False
        # Browsers label sub-resource loads from other sites; only our own page
        # and a direct address-bar visit are acceptable.
        site = self.headers.get("Sec-Fetch-Site")
        if site and site not in ("same-origin", "none"):
            return False
        return True

    # ----------------------------------------------------------------- utils

    def log_message(self, fmt, *args):  # noqa: A003 - quieter console
        if self.server.verbose:  # type: ignore[attr-defined]
            super().log_message(fmt, *args)

    @property
    def sess(self) -> Session:
        return self.server.session  # type: ignore[attr-defined]

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, payload, code: int = 200) -> None:
        self._send(code, json.dumps(payload).encode("utf-8"), "application/json; charset=utf-8")

    def _error(self, message: str, code: int = 400) -> None:
        self._json({"error": message}, code)

    def _query(self) -> dict:
        raw = parse_qs(urlparse(self.path).query)
        return {k: v[0] for k, v in raw.items()}

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    # ------------------------------------------------------------------- SSE

    def _sse_open(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "close")
        self.end_headers()
        # SSE responses have no known length, so the connection must close.
        self.close_connection = True

    def _sse(self, payload: dict) -> bool:
        try:
            self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode("utf-8"))
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError, ValueError):
            return False  # browser navigated away mid-stream

    # ---------------------------------------------------------------- static

    def _static(self, route: str) -> None:
        if route.startswith("/exports/"):
            return self._serve_export(route[len("/exports/"):])
        if route in ("/", ""):
            route = "/index.html"
        # Normalise away any ../ before touching the filesystem.
        clean = posixpath.normpath(route).lstrip("/")
        full = os.path.join(WEB_ROOT, clean)
        if not os.path.abspath(full).startswith(WEB_ROOT + os.sep) or not os.path.isfile(full):
            return self._send(404, b"not found", "text/plain; charset=utf-8")
        ctype, _ = mimetypes.guess_type(full)
        with open(full, "rb") as fh:
            data = fh.read()
        self._send(200, data, ctype or "application/octet-stream")


    def _serve_export(self, name: str) -> None:
        # Only ever serve a plain filename out of our own export directory.
        if "/" in name or "\\" in name or name.startswith("."):
            return self._send(404, b"not found", "text/plain; charset=utf-8")
        path = os.path.join(self.sess.repo.path, ".steinsgit", "exports", name)
        if not os.path.isfile(path):
            return self._send(404, b"not found", "text/plain; charset=utf-8")
        with open(path, "rb") as fh:
            data = fh.read()
        self._send(200, data, "text/html; charset=utf-8",
                   {"Content-Disposition": f'attachment; filename="{name}"'})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, session: Session, verbose: bool = False):
        super().__init__(addr, Handler)
        self.session = session
        self.verbose = verbose


def serve(session: Session, host: str = "127.0.0.1", port: int = 8787,
          verbose: bool = False) -> Server:
    return Server((host, port), session, verbose)

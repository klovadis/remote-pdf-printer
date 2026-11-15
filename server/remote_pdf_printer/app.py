"""HTTP(S) API."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import logging
import threading
import time
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

from . import __version__
from .classify import InvalidPdf, analyze_pdf, classify
from .config import Config
from .printing import PrintError, print_pdf
from .storage import build_filename, store_pdf

log = logging.getLogger(__name__)

DEDUPE_SECONDS = 20
# Browser extensions may call the API cross-origin (e.g. Chrome before the host permission is
# granted). Only extension origins are allowed; the API token is required regardless.
EXTENSION_ORIGIN_PREFIXES = ("chrome-extension://", "moz-extension://", "safari-web-extension://")
CORS_ALLOW_HEADERS = "Authorization, Content-Type, X-Filename, X-Source-Url, X-Capture-Method"


@dataclass
class Processor:
    """Turns an uploaded PDF into a decision and performs store/print actions."""

    config: Config
    _recent: dict[str, tuple[float, dict]] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def process(self, data: bytes, filename: str, url: str, method: str, dry_run: bool = False) -> dict:
        digest = hashlib.sha256(data).hexdigest()
        now = time.monotonic()
        if not dry_run:
            with self._lock:
                self._recent = {k: v for k, v in self._recent.items() if now - v[0] < DEDUPE_SECONDS}
                if digest in self._recent:
                    log.info("Duplikat %s… innerhalb von %ss ignoriert", digest[:12], DEDUPE_SECONDS)
                    return {**self._recent[digest][1], "duplicate": True}
                # Reserve the hash right away so a parallel duplicate does not print twice.
                self._recent[digest] = (now, {"category": None, "browser": "suppress", "pending": True})

        try:
            result = self._process(data, digest, filename, url, method, dry_run)
        except Exception:
            if not dry_run:
                with self._lock:
                    self._recent.pop(digest, None)
            raise
        if not dry_run:
            with self._lock:
                self._recent[digest] = (now, result)
        return result

    def _process(self, data: bytes, digest: str, filename: str, url: str, method: str, dry_run: bool) -> dict:
        cfg = self.config
        info = analyze_pdf(data, cfg.text_pages)
        cat_name, rule_index = classify(cfg, info, filename, url)
        cat = cfg.categories[cat_name]
        result: dict = {
            "category": cat.name,
            "label": cat.label,
            "rule": rule_index,
            "browser": cat.browser,
            "pages": info.pages,
            "paper": info.paper_name,
            "sha256": digest,
            "stored": None,
            "printed": None,
            "errors": [],
            "dry_run": dry_run,
        }
        log.info(
            "PDF empfangen: %s (%s, %d S., %d kB, via %s) -> %s",
            filename or "?", info.paper_name, info.pages, len(data) // 1024, method or "?", cat.name,
        )
        if dry_run:
            return result

        stored_path = None
        if cat.folder is not None:
            try:
                name = build_filename(cfg.filename_template, cat.name, filename or "dokument")
                stored_path = store_pdf(data, cfg.storage_dir / cat.folder, name)
                result["stored"] = str(stored_path)
                log.info("Abgelegt: %s", stored_path)
            except OSError as exc:
                log.error("Ablegen fehlgeschlagen: %s", exc)
                result["errors"].append(f"Ablegen fehlgeschlagen: {exc}")

        if cat.print is not None:
            try:
                out = print_pdf(cfg.printing, cat.print, data, title=f"{cat.label}: {filename or 'Dokument'}", path=stored_path)
                result["printed"] = {"printer": cat.print.printer, "job": out}
            except PrintError as exc:
                log.error("Drucken auf %s fehlgeschlagen: %s", cat.print.printer, exc)
                result["errors"].append(f"Drucken auf {cat.print.printer} fehlgeschlagen: {exc}")

        if result["errors"]:
            # Never hide a document from the user if something went wrong.
            result["browser"] = "show"
        return result


def _parse_ip(value: str):
    try:
        return ipaddress.ip_address(value.strip().strip("[]"))
    except ValueError:
        return None


def resolve_client_ip(peer: str, forwarded_for: list[str], trusted_proxies) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """Return the client address.

    Only if the direct peer is a trusted proxy, X-Forwarded-For is evaluated from right to left,
    skipping further trusted proxies. A client cannot spoof its address this way, because Caddy
    appends the real peer address to the header.
    """
    addr = _parse_ip(peer)
    if addr is None or not any(addr in net for net in trusted_proxies):
        return addr
    hops = [h for line in forwarded_for for h in line.split(",") if h.strip()]
    for hop in reversed(hops):
        hop_addr = _parse_ip(hop)
        if hop_addr is None:
            return None  # malformed header: refuse rather than guess
        addr = hop_addr
        if not any(addr in net for net in trusted_proxies):
            break
    return addr


class Handler(BaseHTTPRequestHandler):
    server_version = f"remote-pdf-printer/{__version__}"
    processor: Processor  # set via subclass in make_server

    # --- helpers -----------------------------------------------------------------
    def log_message(self, fmt, *args):  # route http.server logging through logging
        log.debug("%s - %s", self.client_address[0], fmt % args)

    def _cors_headers(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin.startswith(EXTENSION_ORIGIN_PREFIXES):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def client_ip(self):
        """The real client address, taking X-Forwarded-For from trusted proxies (Caddy) into account."""
        return resolve_client_ip(
            self.client_address[0], self.headers.get_all("X-Forwarded-For") or [],
            self.processor.config.server.trusted_proxies,
        )

    def _authorized(self) -> bool:
        cfg = self.processor.config.server
        addr = self.client_ip()
        if cfg.allowed_clients:
            if addr is None or not any(addr in net for net in cfg.allowed_clients):
                log.warning("Anfrage von nicht erlaubter Adresse %s abgelehnt", addr)
                self._json(HTTPStatus.FORBIDDEN, {"error": "client not allowed"})
                return False
        auth = self.headers.get("Authorization", "")
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        ok = False
        for t in cfg.api_tokens:
            ok |= hmac.compare_digest(token.encode(), t.encode())
        if not ok:
            log.warning("Anfrage mit ungültigem Token von %s abgelehnt", addr)
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "invalid token"})
            return False
        return True

    # --- routes ------------------------------------------------------------------
    def do_OPTIONS(self):
        """CORS preflight (carries no token, so it is answered without authentication)."""
        path = urlsplit(self.path).path
        if path not in ("/api/health", "/api/documents") or not self.headers.get("Origin", "").startswith(EXTENSION_ORIGIN_PREFIXES):
            self.send_response(HTTPStatus.FORBIDDEN)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS)
        self.send_header("Access-Control-Max-Age", "600")
        if self.headers.get("Access-Control-Request-Private-Network") == "true":
            # Chrome "Private Network Access" for servers in the local network.
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path != "/api/health":
            return self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        if not self._authorized():
            return
        cfg = self.processor.config
        self._json(HTTPStatus.OK, {
            "ok": True,
            "version": __version__,
            "categories": [
                {"name": c.name, "label": c.label, "browser": c.browser,
                 "stores": c.folder is not None, "printer": c.print.printer if c.print else None}
                for c in cfg.categories.values()
            ],
        })

    def do_POST(self):
        parts = urlsplit(self.path)
        if parts.path != "/api/documents":
            return self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        if not self._authorized():
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self._json(HTTPStatus.LENGTH_REQUIRED, {"error": "Content-Length required"})
        limit = int(self.processor.config.server.max_upload_mb * 1024 * 1024)
        if length <= 0 or length > limit:
            return self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": f"body must be 1..{limit} bytes"})
        data = self.rfile.read(length)

        query = parse_qs(parts.query)
        dry_run = query.get("dry_run", ["0"])[0] in ("1", "true", "yes")
        filename = unquote(self.headers.get("X-Filename", ""))[:255]
        url = unquote(self.headers.get("X-Source-Url", ""))[:2000]
        method = self.headers.get("X-Capture-Method", "")[:50]
        try:
            result = self.processor.process(data, filename, url, method, dry_run=dry_run)
        except InvalidPdf as exc:
            return self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(exc), "browser": "show"})
        except Exception as exc:  # noqa: BLE001
            log.exception("Fehler bei der Verarbeitung")
            return self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc), "browser": "show"})
        self._json(HTTPStatus.OK, result)


def make_server(config: Config) -> ThreadingHTTPServer:
    processor = Processor(config)
    handler = type("BoundHandler", (Handler,), {"processor": processor})
    httpd = ThreadingHTTPServer((config.server.host, config.server.port), handler)
    httpd.daemon_threads = True
    return httpd

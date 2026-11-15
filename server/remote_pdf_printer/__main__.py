"""Command line entry point.

    remote-pdf-printer -c config.toml                 # Server starten
    remote-pdf-printer -c config.toml check           # Konfiguration prüfen
    remote-pdf-printer -c config.toml classify a.pdf  # Regeln an PDFs testen (druckt nichts)
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from . import __version__
from .classify import InvalidPdf, analyze_pdf, classify
from .config import ConfigError, load_config


def _cmd_check(cfg) -> int:
    print(f"Konfiguration OK. Ablageordner: {cfg.storage_dir}")
    for c in cfg.categories.values():
        actions = []
        if c.folder is not None:
            actions.append(f"ablegen in {cfg.storage_dir / c.folder}")
        if c.print:
            actions.append(f"drucken auf {c.print.printer} {c.print.options}")
        print(f"  {c.name:<12} {c.label:<28} Browser: {c.browser:<9} {', '.join(actions) or 'keine Aktion'}")
    print(f"  Standardkategorie: {cfg.default_category}, {len(cfg.rules)} Regel(n)")
    if not cfg.server.tls_cert:
        print("WARNUNG: kein TLS-Zertifikat konfiguriert – der Server startet nur mit --insecure.")
    return 0


def _cmd_classify(cfg, files: list[str]) -> int:
    rc = 0
    for f in files:
        try:
            info = analyze_pdf(Path(f).read_bytes(), cfg.text_pages)
        except (OSError, InvalidPdf) as exc:
            print(f"{f}: FEHLER {exc}")
            rc = 1
            continue
        cat, rule = classify(cfg, info, filename=Path(f).name)
        src = f"Regel {rule}" if rule is not None else "Standard"
        print(f"{f}: {cat} ({src}) – {info.paper_name}, {info.width_mm:.0f}x{info.height_mm:.0f} mm, {info.pages} Seite(n)")
    return rc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="remote-pdf-printer", description="PDF-Druckserver für die WebApp-Firefox-Erweiterung")
    ap.add_argument("-c", "--config", default="/etc/remote-pdf-printer/config.toml", help="Pfad zur config.toml")
    ap.add_argument("-v", "--verbose", action="store_true", help="ausführliches Logging")
    ap.add_argument("--insecure", action="store_true", help="ohne TLS starten (nur zum Testen!)")
    ap.add_argument("--version", action="version", version=__version__)
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("serve", help="Server starten (Standard)")
    sub.add_parser("check", help="Konfiguration prüfen und anzeigen")
    p_cls = sub.add_parser("classify", help="PDF-Dateien klassifizieren, ohne abzulegen oder zu drucken")
    p_cls.add_argument("files", nargs="+")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        cfg = load_config(args.config)
    except (OSError, ConfigError) as exc:
        print(f"Konfigurationsfehler: {exc}", file=sys.stderr)
        return 2

    if args.cmd == "check":
        return _cmd_check(cfg)
    if args.cmd == "classify":
        return _cmd_classify(cfg, args.files)

    if not cfg.server.tls_cert and not args.insecure:
        print("Kein TLS-Zertifikat konfiguriert (server.tls_cert). Zum Testen mit --insecure starten.", file=sys.stderr)
        return 2

    from .app import make_server

    httpd = make_server(cfg)
    scheme = "https" if cfg.server.tls_cert else "http"
    logging.getLogger(__name__).info("Lausche auf %s://%s:%d", scheme, cfg.server.host, cfg.server.port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

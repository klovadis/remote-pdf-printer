"""Command line entry point.

    remote-pdf-printer -c config.toml                 # Server starten
    remote-pdf-printer -c config.toml check           # Konfiguration prüfen
    remote-pdf-printer -c config.toml classify a.pdf  # Regeln an PDFs testen (druckt nichts)
    remote-pdf-printer -c config.toml printers        # installierte Drucker anzeigen
"""

from __future__ import annotations

import argparse
import ipaddress
import logging
import logging.handlers
import os
import sys
from pathlib import Path

from . import __version__
from .classify import InvalidPdf, analyze_pdf, classify
from .config import ConfigError, load_config
from .printing import PrintError, find_sumatra, list_printers

if os.name == "nt":
    DEFAULT_CONFIG = os.path.join(os.environ.get("PROGRAMDATA", r"C:\ProgramData"), "remote-pdf-printer", "config.toml")
else:
    DEFAULT_CONFIG = "/etc/remote-pdf-printer/config.toml"


def _is_loopback(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host == "localhost"


def _cmd_check(cfg) -> int:
    print(f"Konfiguration OK. Ablageordner: {cfg.storage_dir}")
    for c in cfg.categories.values():
        actions = []
        if c.folder is not None:
            actions.append(f"ablegen in {cfg.storage_dir / c.folder}")
        if c.print:
            pr = c.print
            details = [pr.paper or "Standardpapier", f"Skalierung {pr.scaling}"]
            if pr.orientation != "auto":
                details.append(pr.orientation)
            if pr.duplex:
                details.append(f"Duplex {pr.duplex}")
            if pr.copies > 1:
                details.append(f"{pr.copies} Kopien")
            actions.append(f"drucken auf {pr.printer} ({', '.join(details)})")
        print(f"  {c.name:<12} {c.label:<28} Browser: {c.browser:<9} {', '.join(actions) or 'keine Aktion'}")
    print(f"  Standardkategorie: {cfg.default_category}, {len(cfg.rules)} Regel(n)")
    print(f"  Lauscht auf http://{cfg.server.host}:{cfg.server.port}")
    if not _is_loopback(cfg.server.host):
        print("WARNUNG: server.host ist nicht 127.0.0.1 – der Server ist dann unverschlüsselt im Netz erreichbar.")

    rc = 0
    p = cfg.printing
    if p.backend == "sumatra":
        try:
            print(f"  Drucken mit SumatraPDF: {find_sumatra(p.sumatra_path)}")
        except PrintError as exc:
            print(f"FEHLER: {exc}")
            rc = 1
    else:
        print(f"  Drucken mit CUPS: {p.lp_command}")
    wanted = {c.print.printer for c in cfg.categories.values() if c.print}
    if wanted:
        try:
            installed = set(list_printers(p))
        except PrintError as exc:
            print(f"  (Druckernamen nicht geprüft – {exc})")
        else:
            for name in sorted(wanted - installed):
                print(f"FEHLER: Drucker {name!r} ist nicht installiert (siehe Befehl 'printers')")
                rc = 1
    return rc


def _cmd_printers(cfg) -> int:
    try:
        names = list_printers(cfg.printing)
    except PrintError as exc:
        print(f"FEHLER: {exc}", file=sys.stderr)
        return 1
    print("Installierte Drucker (Namen so in config.toml bei printer = \"...\" eintragen):")
    for n in names:
        print(f"  {n}")
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
    ap = argparse.ArgumentParser(prog="remote-pdf-printer", description="PDF-Druckserver für die Browser-Erweiterung Remote PDF Printer")
    ap.add_argument("-c", "--config", default=DEFAULT_CONFIG, help=f"Pfad zur config.toml (Standard: {DEFAULT_CONFIG})")
    ap.add_argument("-v", "--verbose", action="store_true", help="ausführliches Logging")
    ap.add_argument("--log-file", help="in diese Datei protokollieren statt auf die Konsole (z.B. unter Windows mit pythonw)")
    ap.add_argument("--version", action="version", version=__version__)
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("serve", help="Server starten (Standard)")
    sub.add_parser("check", help="Konfiguration prüfen und anzeigen")
    p_cls = sub.add_parser("classify", help="PDF-Dateien klassifizieren, ohne abzulegen oder zu drucken")
    p_cls.add_argument("files", nargs="+")
    sub.add_parser("printers", help="installierte Drucker anzeigen")
    args = ap.parse_args(argv)

    handlers = None
    if args.log_file:
        handlers = [logging.handlers.RotatingFileHandler(args.log_file, maxBytes=2_000_000, backupCount=3, encoding="utf-8")]
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
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
    if args.cmd == "printers":
        return _cmd_printers(cfg)

    log = logging.getLogger(__name__)
    if not _is_loopback(cfg.server.host):
        log.warning("server.host=%s: der Server ist ohne Reverse Proxy unverschlüsselt im Netz erreichbar", cfg.server.host)
    log.info("Druck-Backend: %s", cfg.printing.backend)

    from .app import make_server

    httpd = make_server(cfg)
    log.info("Lausche auf http://%s:%d", cfg.server.host, cfg.server.port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

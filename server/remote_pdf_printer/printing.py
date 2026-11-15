"""Printing via CUPS (lp)."""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from pathlib import Path

from .config import PrintSettings

log = logging.getLogger(__name__)


class PrintError(RuntimeError):
    pass


def build_lp_command(lp: str, settings: PrintSettings, path: Path, title: str) -> list[str]:
    cmd = [lp, "-d", settings.printer, "-n", str(settings.copies), "-t", title]
    for opt in settings.options:
        cmd += ["-o", opt]
    cmd += ["--", str(path)]
    return cmd


def print_pdf(lp: str, settings: PrintSettings, data: bytes, title: str, path: Path | None = None) -> str:
    """Send the PDF to CUPS. Uses `path` if the file is already stored, else a temp file.

    Returns the output of lp (e.g. "request id is Rezeptdrucker-42 (1 file(s))").
    """
    tmp = None
    if path is None:
        fd, tmp = tempfile.mkstemp(suffix=".pdf")
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        path = Path(tmp)
    try:
        cmd = build_lp_command(lp, settings, path, title)
        log.info("Drucke: %s", " ".join(cmd))
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        except FileNotFoundError as exc:
            raise PrintError(f"Druckbefehl {lp!r} nicht gefunden (cups-client installiert?)") from exc
        except subprocess.TimeoutExpired as exc:
            raise PrintError("Zeitüberschreitung beim Drucken") from exc
        if res.returncode != 0:
            raise PrintError((res.stderr or res.stdout or f"lp exit code {res.returncode}").strip())
        return res.stdout.strip()
    finally:
        # lp copies the file into the CUPS spool before returning, so deleting is safe.
        if tmp:
            os.unlink(tmp)

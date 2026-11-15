"""Printing via CUPS (Linux/macOS) or SumatraPDF (Windows)."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from .config import PRINT_PAPERS, PrintingSettings, PrintSettings

log = logging.getLogger(__name__)

# Hide console windows of child processes when running on Windows (e.g. under pythonw).
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class PrintError(RuntimeError):
    pass


# --- CUPS -------------------------------------------------------------------------------------

def cups_options(s: PrintSettings) -> list[str]:
    opts = []
    if s.paper:
        opts.append(f"media={PRINT_PAPERS[s.paper]}")
    opts += {"fit": ["fit-to-page", "print-scaling=fit"], "shrink": ["print-scaling=auto-fit"], "none": ["print-scaling=none"]}[s.scaling]
    if s.orientation == "portrait":
        opts.append("orientation-requested=3")
    elif s.orientation == "landscape":
        opts.append("orientation-requested=4")
    if s.duplex:
        opts.append("sides=" + {"none": "one-sided", "long": "two-sided-long-edge", "short": "two-sided-short-edge"}[s.duplex])
    return opts + s.options


def build_lp_command(lp: str, s: PrintSettings, path: Path, title: str) -> list[str]:
    cmd = [lp, "-d", s.printer, "-n", str(s.copies), "-t", title]
    for opt in cups_options(s):
        cmd += ["-o", opt]
    cmd += ["--", str(path)]
    return cmd


# --- SumatraPDF ---------------------------------------------------------------------------------

def sumatra_candidates() -> list[Path]:
    paths = []
    for var in ("LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"):
        base = os.environ.get(var)
        if base:
            paths.append(Path(base) / "SumatraPDF" / "SumatraPDF.exe")
    found = shutil.which("SumatraPDF")
    if found:
        paths.append(Path(found))
    return paths


def find_sumatra(configured: str | None) -> Path:
    if configured:
        p = Path(configured)
        if p.is_file():
            return p
        raise PrintError(f"SumatraPDF nicht gefunden unter {configured} (printing.sumatra_path)")
    for p in sumatra_candidates():
        if p.is_file():
            return p
    raise PrintError(
        "SumatraPDF nicht gefunden. Bitte von https://www.sumatrapdfreader.org installieren "
        "oder den Pfad in printing.sumatra_path eintragen."
    )


def sumatra_settings(s: PrintSettings) -> str:
    parts = [{"fit": "fit", "shrink": "shrink", "none": "noscale"}[s.scaling]]
    if s.paper:
        parts.append(f"paper={PRINT_PAPERS[s.paper]}")
    if s.orientation in ("portrait", "landscape"):
        parts.append(s.orientation)
    if s.duplex:
        parts.append({"none": "simplex", "long": "duplexlong", "short": "duplexshort"}[s.duplex])
    if s.copies > 1:
        parts.append(f"{s.copies}x")
    return ",".join(parts + s.sumatra_settings)


def build_sumatra_command(exe: Path, s: PrintSettings, path: Path) -> list[str]:
    return [str(exe), "-print-to", s.printer, "-print-settings", sumatra_settings(s), "-silent", str(path)]


# --- common -------------------------------------------------------------------------------------

def build_command(printing: PrintingSettings, s: PrintSettings, path: Path, title: str) -> list[str]:
    if printing.backend == "sumatra":
        return build_sumatra_command(find_sumatra(printing.sumatra_path), s, path)
    return build_lp_command(printing.lp_command, s, path, title)


def print_pdf(printing: PrintingSettings, s: PrintSettings, data: bytes, title: str, path: Path | None = None) -> str:
    """Print the PDF. Uses `path` if the file is already stored, else a temp file.

    Returns the output of the print command (for CUPS e.g. "request id is Rezeptdrucker-42").
    """
    tmp = None
    if path is None:
        fd, tmp = tempfile.mkstemp(suffix=".pdf")
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        path = Path(tmp)
    try:
        cmd = build_command(printing, s, path, title)
        log.info("Drucke: %s", subprocess.list2cmdline(cmd) if os.name == "nt" else " ".join(cmd))
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=120, creationflags=_NO_WINDOW)
        except FileNotFoundError as exc:
            hint = "cups-client installiert?" if printing.backend == "cups" else "Pfad zu SumatraPDF prüfen"
            raise PrintError(f"Druckbefehl {cmd[0]!r} nicht gefunden ({hint})") from exc
        except subprocess.TimeoutExpired as exc:
            raise PrintError("Zeitüberschreitung beim Drucken") from exc
        if res.returncode != 0:
            raise PrintError((res.stderr or res.stdout or f"Exit-Code {res.returncode}").strip())
        return res.stdout.strip() or "ok"
    finally:
        # lp copies the file into the spool before returning; SumatraPDF has finished
        # spooling when it exits. Deleting is therefore safe.
        if tmp:
            try:
                os.unlink(tmp)
            except OSError as exc:
                log.warning("Temporäre Datei %s konnte nicht gelöscht werden: %s", tmp, exc)


def list_printers(printing: PrintingSettings) -> list[str]:
    if printing.backend == "sumatra" or os.name == "nt":
        cmd = ["powershell", "-NoProfile", "-NonInteractive", "-Command", "Get-Printer | Select-Object -ExpandProperty Name"]
    else:
        cmd = ["lpstat", "-e"]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=30, creationflags=_NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PrintError(f"Drucker konnten nicht ermittelt werden: {exc}") from exc
    if res.returncode != 0:
        raise PrintError((res.stderr or res.stdout).strip() or f"Exit-Code {res.returncode}")
    return [line.strip() for line in res.stdout.splitlines() if line.strip()]

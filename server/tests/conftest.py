import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from remote_pdf_printer.config import load_config  # noqa: E402

EXAMPLE_CONFIG = Path(__file__).resolve().parents[1] / "config.example.toml"

MM = 72 / 25.4


def make_pdf(width_mm: float, height_mm: float, text: str = "", pages: int = 1) -> bytes:
    """Build a minimal valid PDF with Helvetica text on each page."""
    w, h = width_mm * MM, height_mm * MM
    esc = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = f"BT /F1 10 Tf 20 {h - 30:.1f} Td ({esc}) Tj ET".encode("latin-1")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        None,  # pages, filled below
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
    ]
    kids = []
    for _ in range(pages):
        objs.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w:.2f} {h:.2f}] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>".encode()
        )
        kids.append(f"{len(objs)} 0 R")
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {pages} >>".encode()

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


@pytest.fixture
def config(tmp_path):
    raw = EXAMPLE_CONFIG.read_text(encoding="utf-8")
    raw = raw.replace('dir = "/srv/remote-pdf"', f'dir = "{tmp_path / "docs"}"')
    raw = raw.replace('lp_command = "lp"', f'lp_command = "{tmp_path / "fake-lp"}"')
    raw = raw.replace('backend = "auto"', 'backend = "cups"')
    cfg_path = tmp_path / "config.toml"
    cfg_path.write_text(raw, encoding="utf-8")
    # Fake lp: records its arguments and prints a CUPS-like job id.
    lp = tmp_path / "fake-lp"
    lp.write_text(f'#!/bin/sh\necho "$@" >> "{tmp_path / "lp.log"}"\necho "request id is fake-1 (1 file(s))"\n')
    lp.chmod(0o755)
    return load_config(cfg_path)


@pytest.fixture(autouse=True)
def no_printer_lookup(monkeypatch, request):
    """Tests must not depend on printers installed on the developer machine."""
    if "real_printer_lookup" not in request.keywords:
        monkeypatch.setattr("remote_pdf_printer.printing.installed_printers", lambda printing: None)

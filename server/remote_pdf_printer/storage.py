"""Storing PDFs in per-category folders."""

from __future__ import annotations

import os
import re
import tempfile
import unicodedata
from datetime import datetime
from pathlib import Path

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_name(name: str, fallback: str = "dokument") -> str:
    """Turn an arbitrary file name into a short, safe file name stem (without .pdf)."""
    name = os.path.basename(name or "")
    if name.lower().endswith(".pdf"):
        name = name[:-4]
    for src, dst in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("Ä", "Ae"), ("Ö", "Oe"), ("Ü", "Ue"), ("ß", "ss")):
        name = name.replace(src, dst)
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    name = _UNSAFE.sub("_", name).strip("._-")
    return name[:80] or fallback


def build_filename(template: str, category: str, original: str, now: datetime | None = None) -> str:
    now = now or datetime.now()
    stem = template.format(
        date=now.strftime("%Y-%m-%d"),
        time=now.strftime("%H-%M-%S"),
        timestamp=now.strftime("%Y%m%d-%H%M%S"),
        category=category,
        name=safe_name(original),
    )
    return safe_name(stem, fallback=f"{category}_{now:%Y%m%d-%H%M%S}") + ".pdf"


def _publish(tmp: str, target: Path) -> None:
    """Move tmp to target; raise FileExistsError if target exists."""
    try:
        os.link(tmp, target)  # atomic and never overwrites
    except FileExistsError:
        raise
    except OSError:
        # Hard links unsupported (e.g. FAT/exFAT drives, some network shares).
        if os.name == "nt":
            os.rename(tmp, target)  # on Windows rename refuses to overwrite
        else:
            if target.exists():
                raise FileExistsError(target)
            os.rename(tmp, target)


def store_pdf(data: bytes, directory: Path, filename: str) -> Path:
    """Write atomically into directory; never overwrite an existing file."""
    directory.mkdir(parents=True, exist_ok=True)
    stem, suffix = filename[:-4], ".pdf"
    target = directory / filename
    n = 1
    while target.exists():
        n += 1
        target = directory / f"{stem}_{n}{suffix}"
    # Write to a hidden temp file first so folder watchers never see half-written PDFs.
    fd, tmp = tempfile.mkstemp(prefix=".incoming-", suffix=".part", dir=directory)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o640)
        # Publish under the final name without ever overwriting: if the target appeared
        # meanwhile, retry with the next number.
        while True:
            try:
                _publish(tmp, target)
                break
            except FileExistsError:
                n += 1
                target = directory / f"{stem}_{n}{suffix}"
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return target

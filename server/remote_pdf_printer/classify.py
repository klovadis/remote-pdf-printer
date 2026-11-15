"""PDF analysis and rule based classification."""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass

from pypdf import PdfReader

from .config import PAPER_SIZES_MM, Config, Rule

log = logging.getLogger(__name__)

PT_TO_MM = 25.4 / 72.0


class InvalidPdf(ValueError):
    pass


@dataclass
class PdfInfo:
    pages: int
    width_mm: float  # first page
    height_mm: float
    text: str

    @property
    def size_short_long(self) -> tuple[float, float]:
        return (min(self.width_mm, self.height_mm), max(self.width_mm, self.height_mm))

    @property
    def paper_name(self) -> str:
        short, long_ = self.size_short_long
        for name, (s, l) in PAPER_SIZES_MM.items():
            if abs(short - s) <= 6 and abs(long_ - l) <= 6:
                return name
        return f"{self.width_mm:.0f}x{self.height_mm:.0f}mm"


def analyze_pdf(data: bytes, text_pages: int = 3) -> PdfInfo:
    if not data.lstrip()[:5].startswith(b"%PDF"):
        raise InvalidPdf("Die Daten sind kein PDF (fehlender %PDF-Header)")
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception:  # noqa: BLE001 - pypdf raises various errors here
                pass
        n = len(reader.pages)
        if n == 0:
            raise InvalidPdf("PDF enthält keine Seiten")
        box = reader.pages[0].mediabox
        width = float(box.width) * PT_TO_MM
        height = float(box.height) * PT_TO_MM
        texts = []
        for page in reader.pages[: max(text_pages, 0)]:
            try:
                texts.append(page.extract_text() or "")
            except Exception as exc:  # noqa: BLE001
                log.warning("Textextraktion fehlgeschlagen: %s", exc)
        return PdfInfo(pages=n, width_mm=width, height_mm=height, text="\n".join(texts))
    except InvalidPdf:
        raise
    except Exception as exc:  # noqa: BLE001
        raise InvalidPdf(f"PDF konnte nicht gelesen werden: {exc}") from exc


def rule_matches(rule: Rule, info: PdfInfo, filename: str, url: str) -> bool:
    if rule.page_size is not None:
        short, long_ = info.size_short_long
        s, l = rule.page_size
        if abs(short - s) > rule.size_tolerance_mm or abs(long_ - l) > rule.size_tolerance_mm:
            return False
    if rule.min_pages is not None and info.pages < rule.min_pages:
        return False
    if rule.max_pages is not None and info.pages > rule.max_pages:
        return False
    if rule.text_any and not any(p.search(info.text) for p in rule.text_any):
        return False
    if rule.text_all and not all(p.search(info.text) for p in rule.text_all):
        return False
    if rule.text_none and any(p.search(info.text) for p in rule.text_none):
        return False
    if rule.filename is not None and not rule.filename.search(filename or ""):
        return False
    if rule.url is not None and not rule.url.search(url or ""):
        return False
    return True


def classify(config: Config, info: PdfInfo, filename: str = "", url: str = "") -> tuple[str, int | None]:
    """Return (category name, index of matching rule or None for the default)."""
    for i, rule in enumerate(config.rules):
        if rule_matches(rule, info, filename, url):
            return rule.category, i
    return config.default_category, None

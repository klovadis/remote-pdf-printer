"""Loading and validating the TOML configuration."""

from __future__ import annotations

import ipaddress
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

# Paper sizes in millimetres (short side, long side).
PAPER_SIZES_MM: dict[str, tuple[float, float]] = {
    "A3": (297.0, 420.0),
    "A4": (210.0, 297.0),
    "A5": (148.0, 210.0),
    "A6": (105.0, 148.0),
    "LETTER": (215.9, 279.4),
}

BROWSER_ACTIONS = ("show", "suppress")


class ConfigError(ValueError):
    pass


@dataclass
class PrintSettings:
    printer: str
    options: list[str] = field(default_factory=list)
    copies: int = 1


@dataclass
class Category:
    name: str
    label: str
    folder: str | None  # relative to storage_dir; None = do not store
    browser: str  # "show" | "suppress"
    print: PrintSettings | None


@dataclass
class Rule:
    category: str
    page_size: tuple[float, float] | None = None  # (short, long) in mm
    page_size_name: str | None = None
    size_tolerance_mm: float = 6.0
    text_any: list[re.Pattern] = field(default_factory=list)
    text_all: list[re.Pattern] = field(default_factory=list)
    text_none: list[re.Pattern] = field(default_factory=list)
    filename: re.Pattern | None = None
    url: re.Pattern | None = None
    max_pages: int | None = None
    min_pages: int | None = None


@dataclass
class ServerSettings:
    host: str = "127.0.0.1"
    port: int = 8080
    api_tokens: list[str] = field(default_factory=list)
    allowed_clients: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = field(default_factory=list)
    # Reverse proxies (e.g. Caddy) whose X-Forwarded-For header is trusted.
    trusted_proxies: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = field(default_factory=list)
    max_upload_mb: float = 50.0


@dataclass
class Config:
    server: ServerSettings
    storage_dir: Path
    filename_template: str
    text_pages: int
    lp_command: str
    categories: dict[str, Category]
    rules: list[Rule]
    default_category: str


def _compile(patterns, where: str) -> list[re.Pattern]:
    if patterns is None:
        return []
    if isinstance(patterns, str):
        patterns = [patterns]
    try:
        return [re.compile(p, re.IGNORECASE) for p in patterns]
    except re.error as exc:
        raise ConfigError(f"{where}: ungültiger regulärer Ausdruck: {exc}") from exc


def _parse_page_size(value, where: str) -> tuple[tuple[float, float], str]:
    if isinstance(value, str):
        key = value.upper()
        if key not in PAPER_SIZES_MM:
            raise ConfigError(f"{where}: unbekanntes Papierformat {value!r} (bekannt: {', '.join(PAPER_SIZES_MM)})")
        return PAPER_SIZES_MM[key], key
    if isinstance(value, list) and len(value) == 2:
        a, b = float(value[0]), float(value[1])
        return (min(a, b), max(a, b)), f"{a:g}x{b:g}mm"
    raise ConfigError(f"{where}: page_size muss z.B. \"A6\" oder [105, 148] sein")


def _parse_category(name: str, raw: dict) -> Category:
    where = f"categories.{name}"
    browser = raw.get("browser", "show")
    if browser not in BROWSER_ACTIONS:
        raise ConfigError(f"{where}.browser muss einer von {BROWSER_ACTIONS} sein")
    folder = raw.get("folder")
    if folder is not None:
        if Path(folder).is_absolute() or ".." in Path(folder).parts:
            raise ConfigError(f"{where}.folder muss ein relativer Pfad ohne '..' sein")
    print_settings = None
    if raw.get("print"):
        p = raw["print"]
        if not p.get("printer"):
            raise ConfigError(f"{where}.print.printer fehlt")
        copies = int(p.get("copies", 1))
        if copies < 1:
            raise ConfigError(f"{where}.print.copies muss >= 1 sein")
        print_settings = PrintSettings(printer=str(p["printer"]), options=[str(o) for o in p.get("options", [])], copies=copies)
    return Category(name=name, label=raw.get("label", name), folder=folder, browser=browser, print=print_settings)


def _parse_rule(i: int, raw: dict, categories: dict[str, Category]) -> Rule:
    where = f"rules[{i}]"
    cat = raw.get("category")
    if cat not in categories:
        raise ConfigError(f"{where}.category {cat!r} ist nicht unter [categories] definiert")
    rule = Rule(category=cat)
    if "page_size" in raw:
        rule.page_size, rule.page_size_name = _parse_page_size(raw["page_size"], where)
    rule.size_tolerance_mm = float(raw.get("size_tolerance_mm", rule.size_tolerance_mm))
    rule.text_any = _compile(raw.get("text_any"), where)
    rule.text_all = _compile(raw.get("text_all"), where)
    rule.text_none = _compile(raw.get("text_none"), where)
    if raw.get("filename"):
        rule.filename = _compile(raw["filename"], where)[0]
    if raw.get("url"):
        rule.url = _compile(raw["url"], where)[0]
    rule.max_pages = raw.get("max_pages")
    rule.min_pages = raw.get("min_pages")
    known = {"category", "page_size", "size_tolerance_mm", "text_any", "text_all", "text_none", "filename", "url", "max_pages", "min_pages"}
    unknown = set(raw) - known
    if unknown:
        raise ConfigError(f"{where}: unbekannte Schlüssel {sorted(unknown)}")
    return rule


def parse_config(raw: dict, base_dir: Path | None = None) -> Config:
    base_dir = base_dir or Path.cwd()
    s = raw.get("server", {})
    tokens = s.get("api_tokens") or ([s["api_token"]] if s.get("api_token") else [])
    tokens = [t for t in tokens if t]
    if not tokens:
        raise ConfigError("server.api_token fehlt (mindestens ein Token ist Pflicht)")
    if any(len(t) < 16 for t in tokens):
        raise ConfigError("server.api_token muss mindestens 16 Zeichen lang sein")
    if "tls_cert" in s or "tls_key" in s:
        raise ConfigError(
            "server.tls_cert/tls_key werden nicht mehr unterstützt: HTTPS übernimmt der Reverse Proxy (Caddy). "
            "Bitte die beiden Zeilen entfernen."
        )

    def networks(key, default=()):
        try:
            return [ipaddress.ip_network(c, strict=False) for c in s.get(key, default)]
        except ValueError as exc:
            raise ConfigError(f"server.{key}: {exc}") from exc

    server = ServerSettings(
        host=s.get("host", "127.0.0.1"),
        port=int(s.get("port", 8080)),
        api_tokens=tokens,
        allowed_clients=networks("allowed_clients"),
        trusted_proxies=networks("trusted_proxies", ["127.0.0.1", "::1"]),
        max_upload_mb=float(s.get("max_upload_mb", 50)),
    )

    raw_cats = raw.get("categories", {})
    if not raw_cats:
        raise ConfigError("Es ist keine Kategorie unter [categories] definiert")
    categories = {name: _parse_category(name, c) for name, c in raw_cats.items()}
    rules = [_parse_rule(i, r, categories) for i, r in enumerate(raw.get("rules", []))]

    c = raw.get("classification", {})
    default = c.get("default_category")
    if default not in categories:
        raise ConfigError(f"classification.default_category {default!r} ist nicht unter [categories] definiert")

    st = raw.get("storage", {})
    storage_dir = Path(st.get("dir", "documents"))
    if not storage_dir.is_absolute():
        storage_dir = base_dir / storage_dir

    return Config(
        server=server,
        storage_dir=storage_dir,
        filename_template=st.get("filename_template", "{date}_{time}_{category}_{name}"),
        text_pages=int(c.get("text_pages", 3)),
        lp_command=raw.get("printing", {}).get("lp_command", "lp"),
        categories=categories,
        rules=rules,
        default_category=default,
    )


def load_config(path: str | Path) -> Config:
    path = Path(path)
    with path.open("rb") as fh:
        try:
            raw = tomllib.load(fh)
        except tomllib.TOMLDecodeError as exc:
            raise ConfigError(f"{path}: {exc}") from exc
    return parse_config(raw, base_dir=path.resolve().parent)

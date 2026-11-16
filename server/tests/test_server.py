import json
import threading
import urllib.error
import urllib.request

import pytest
from conftest import make_pdf

import ipaddress

from remote_pdf_printer.app import Processor, make_server
from remote_pdf_printer.classify import InvalidPdf, analyze_pdf, classify
from remote_pdf_printer.config import ConfigError, parse_config
from remote_pdf_printer.storage import build_filename, safe_name, store_pdf

TOKEN = "BITTE-AENDERN-mindestens-16-zeichen"


# --- analysis & classification -------------------------------------------------------

def test_analyze_detects_size_and_text():
    info = analyze_pdf(make_pdf(148, 105, "Hallo Welt"))
    assert info.paper_name == "A6"
    assert info.pages == 1
    assert "Hallo Welt" in info.text


def test_analyze_rejects_non_pdf():
    with pytest.raises(InvalidPdf):
        analyze_pdf(b"<html>nope</html>")


@pytest.mark.parametrize(
    "size,text,expected",
    [
        ((148, 105), "Muster 16 Kassenrezept", "rezept"),  # A6 landscape
        ((105, 148), "", "rezept"),  # A6 portrait
        ((210, 297), "Privatrechnung Rechnungsnummer 2026-001", "rechnung"),
        ((210, 297), "Arztbrief an Kollegen", "befund"),
        ((210, 297), "Überweisungsschein", "a4"),
        ((148, 210), "irgendwas", "a4"),  # A5 -> default
    ],
)
def test_classify(config, size, text, expected):
    info = analyze_pdf(make_pdf(*size, text))
    assert classify(config, info)[0] == expected


def test_rule_order_and_text_none(config):
    raw = {
        "server": {"api_token": TOKEN},
        "classification": {"default_category": "x"},
        "categories": {"x": {}, "y": {}},
        "rules": [{"category": "y", "text_any": ["foo"], "text_none": ["bar"], "max_pages": 1}],
    }
    cfg = parse_config(raw)
    assert classify(cfg, analyze_pdf(make_pdf(210, 297, "foo")))[0] == "y"
    assert classify(cfg, analyze_pdf(make_pdf(210, 297, "foo bar")))[0] == "x"
    assert classify(cfg, analyze_pdf(make_pdf(210, 297, "foo", pages=2)))[0] == "x"


@pytest.mark.parametrize(
    "raw",
    [
        {"server": {}, "classification": {"default_category": "x"}, "categories": {"x": {}}},
        {"server": {"api_token": "short"}, "classification": {"default_category": "x"}, "categories": {"x": {}}},
        {"server": {"api_token": TOKEN}, "classification": {"default_category": "nope"}, "categories": {"x": {}}},
        {"server": {"api_token": TOKEN}, "classification": {"default_category": "x"}, "categories": {"x": {"folder": "../etc"}}},
        {"server": {"api_token": TOKEN}, "classification": {"default_category": "x"}, "categories": {"x": {"browser": "hide"}}},
        {"server": {"api_token": TOKEN}, "classification": {"default_category": "x"}, "categories": {"x": {}},
         "rules": [{"category": "x", "page_size": "B5"}]},
        {"server": {"api_token": TOKEN}, "classification": {"default_category": "x"}, "categories": {"x": {}},
         "rules": [{"category": "x", "txt_any": ["typo"]}]},
        {"server": {"api_token": TOKEN}, "classification": {"default_category": "x"},
         "categories": {"x": {"print": {"printer": "p", "paper": "B5"}}}},
        {"server": {"api_token": TOKEN}, "classification": {"default_category": "x"},
         "categories": {"x": {"print": {"printer": "p", "duplex": "yes"}}}},
        {"server": {"api_token": TOKEN}, "classification": {"default_category": "x"},
         "categories": {"x": {"print": {"printer": "p", "papre": "A4"}}}},
        {"server": {"api_token": TOKEN}, "classification": {"default_category": "x"}, "categories": {"x": {}},
         "printing": {"backend": "windows"}},
    ],
)
def test_invalid_configs(raw):
    with pytest.raises(ConfigError):
        parse_config(raw)


# --- storage ---------------------------------------------------------------------------

def test_safe_name():
    assert safe_name("../../Rezept Müller (1).pdf") == "Rezept_Mueller_1"
    assert safe_name("") == "dokument"


def test_store_never_overwrites(tmp_path):
    a = store_pdf(b"%PDF-a", tmp_path, "x.pdf")
    b = store_pdf(b"%PDF-b", tmp_path, "x.pdf")
    assert a.name == "x.pdf" and b.name == "x_2.pdf"
    assert a.read_bytes() == b"%PDF-a"
    assert not list(tmp_path.glob(".incoming-*"))


def test_build_filename():
    name = build_filename("{date}_{category}_{name}", "rezept", "Rezept.pdf")
    assert name.endswith("_rezept_Rezept.pdf")


# --- processing --------------------------------------------------------------------------

def test_process_rezept_stores_and_prints(config, tmp_path):
    res = Processor(config).process(make_pdf(148, 105, "Rezept"), "Rezept Müller.pdf", "https://app.example.org/x", "test")
    assert res["category"] == "rezept"
    assert res["browser"] == "suppress"
    assert res["printed"]["printer"] == "Rezeptdrucker"
    assert res["stored"].startswith(str(tmp_path / "docs" / "rezepte"))
    log = (tmp_path / "lp.log").read_text()
    assert "-d Rezeptdrucker" in log and "-o media=A6" in log


def test_process_befund_is_shown_not_printed(config, tmp_path):
    res = Processor(config).process(make_pdf(210, 297, "Arztbrief"), "brief.pdf", "", "test")
    assert res["browser"] == "show" and res["printed"] is None and res["stored"]
    assert not (tmp_path / "lp.log").exists()


def test_print_failure_falls_back_to_show(config, tmp_path):
    (tmp_path / "fake-lp").write_text("#!/bin/sh\necho 'lp: printer not found' >&2\nexit 1\n")
    res = Processor(config).process(make_pdf(105, 148), "r.pdf", "", "test")
    assert res["browser"] == "show"
    assert "printer not found" in res["errors"][0]


def test_duplicates_are_printed_once(config, tmp_path):
    p = Processor(config)
    pdf = make_pdf(105, 148, "dup")
    first = p.process(pdf, "r.pdf", "", "a")
    second = p.process(pdf, "r.pdf", "", "b")
    assert second["duplicate"] is True and second["category"] == first["category"]
    assert len((tmp_path / "lp.log").read_text().splitlines()) == 1


def test_dry_run_has_no_side_effects(config, tmp_path):
    res = Processor(config).process(make_pdf(105, 148), "r.pdf", "", "a", dry_run=True)
    assert res["category"] == "rezept" and res["stored"] is None
    assert not (tmp_path / "lp.log").exists()


# --- HTTP ---------------------------------------------------------------------------------

@pytest.fixture
def http_server(config):
    config.server.host, config.server.port = "127.0.0.1", 0
    httpd = make_server(config)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


def _req(url, data=None, token=TOKEN, headers=None):
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as exc:
        return exc.code, json.load(exc)


def test_http_requires_token(http_server):
    assert _req(http_server + "/api/health", token=None)[0] == 401
    assert _req(http_server + "/api/health", token="wrong-token-wrong-token")[0] == 401
    status, body = _req(http_server + "/api/health")
    assert status == 200 and body["ok"] and {c["name"] for c in body["categories"]} == {"rezept", "rechnung", "befund", "a4"}


def test_http_upload(http_server):
    status, body = _req(
        http_server + "/api/documents",
        data=make_pdf(210, 297, "Rechnungsnummer 1"),
        headers={"Content-Type": "application/pdf", "X-Filename": "Rechnung%20M%C3%BCller.pdf", "X-Capture-Method": "test"},
    )
    assert status == 200
    assert body["category"] == "rechnung" and body["browser"] == "suppress"
    assert body["stored"].endswith("_rechnung_Rechnung_Mueller.pdf")


def test_http_rejects_garbage(http_server):
    status, body = _req(http_server + "/api/documents", data=b"not a pdf")
    assert status == 422 and body["browser"] == "show"


# --- allowed clients ---------------------------------------------------------------------------

def test_http_allowed_clients_use_real_peer(config, http_server):
    # The test client connects from 127.0.0.1; a forged X-Forwarded-For header must not matter.
    config.server.allowed_clients = [ipaddress.ip_network("192.168.0.0/16")]
    assert _req(http_server + "/api/health", headers={"X-Forwarded-For": "192.168.1.5"})[0] == 403
    config.server.allowed_clients = [ipaddress.ip_network("127.0.0.1/32")]
    assert _req(http_server + "/api/health")[0] == 200


# --- print backends ------------------------------------------------------------------------------

from remote_pdf_printer.config import PrintingSettings, PrintSettings  # noqa: E402
from remote_pdf_printer.printing import (  # noqa: E402
    PrintError, build_lp_command, build_sumatra_command, find_sumatra, print_pdf,
)


def test_cups_command_mapping(tmp_path):
    s = PrintSettings(printer="Rezept", paper="A6", scaling="fit", orientation="landscape", duplex="none",
                      copies=2, options=["InputSlot=Tray2"])
    cmd = build_lp_command("lp", s, tmp_path / "a.pdf", "t")
    assert cmd[:4] == ["lp", "-d", "Rezept", "-n"] and cmd[4] == "2"
    opts = [cmd[i + 1] for i, c in enumerate(cmd) if c == "-o"]
    assert opts == ["media=A6", "fit-to-page", "print-scaling=fit", "orientation-requested=4", "sides=one-sided", "InputSlot=Tray2"]


def test_sumatra_command_mapping(tmp_path):
    s = PrintSettings(printer="HP LaserJet (Fach 2)", paper="A4", scaling="shrink", duplex="long", copies=3,
                      sumatra_settings=["bin=2"])
    cmd = build_sumatra_command(tmp_path / "SumatraPDF.exe", s, tmp_path / "a.pdf")
    assert cmd[1:5] == ["-print-to", "HP LaserJet (Fach 2)", "-print-settings", "shrink,paper=A4,duplexlong,3x,bin=2"]
    assert cmd[5:] == ["-silent", str(tmp_path / "a.pdf")]
    default = build_sumatra_command(tmp_path / "s.exe", PrintSettings(printer="p"), tmp_path / "a.pdf")
    assert default[4] == "fit"


def test_print_with_fake_sumatra(tmp_path):
    exe = tmp_path / "SumatraPDF.exe"
    exe.write_text(f'#!/bin/sh\necho "$@" > "{tmp_path / "sumatra.log"}"\n')
    exe.chmod(0o755)
    out = print_pdf(PrintingSettings(backend="sumatra", sumatra_path=str(exe)), PrintSettings(printer="Rezept", paper="A6"),
                    make_pdf(105, 148), "Rezept")
    assert out == "ok"
    logged = (tmp_path / "sumatra.log").read_text()
    assert logged.startswith("-print-to Rezept -print-settings fit,paper=A6 -silent ")


def test_sumatra_missing(tmp_path, monkeypatch):
    with pytest.raises(PrintError, match="sumatra_path"):
        find_sumatra(str(tmp_path / "nope.exe"))
    for var in ("LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("PATH", str(tmp_path))
    with pytest.raises(PrintError, match="nicht gefunden"):
        find_sumatra(None)


def test_backend_auto(monkeypatch):
    raw = {"server": {"api_token": TOKEN}, "classification": {"default_category": "x"}, "categories": {"x": {}}}
    monkeypatch.setattr("remote_pdf_printer.config._is_windows", lambda: True)
    assert parse_config(raw).printing.backend == "sumatra"
    monkeypatch.setattr("remote_pdf_printer.config._is_windows", lambda: False)
    assert parse_config(raw).printing.backend == "cups"


def test_store_without_hardlinks(tmp_path, monkeypatch):
    def no_link(*a):
        raise OSError("hard links not supported")
    monkeypatch.setattr("remote_pdf_printer.storage.os.link", no_link)
    a = store_pdf(b"%PDF-a", tmp_path, "x.pdf")
    b = store_pdf(b"%PDF-b", tmp_path, "x.pdf")
    assert (a.name, b.name) == ("x.pdf", "x_2.pdf")
    assert a.read_bytes() == b"%PDF-a" and b.read_bytes() == b"%PDF-b"
    assert not list(tmp_path.glob(".incoming-*"))


def test_sumatra_error_is_explained(tmp_path):
    exe = tmp_path / "SumatraPDF.exe"
    exe.write_text("#!/bin/sh\necho \"ParseFlags: argName: '-print-to', arg: 33\"\necho \"ParseFlags: argName: '-silent', arg: 1\"\nexit 1\n")
    exe.chmod(0o755)
    with pytest.raises(PrintError) as info:
        print_pdf(PrintingSettings(backend="sumatra", sumatra_path=str(exe)), PrintSettings(printer="HP", paper="A6"),
                  make_pdf(105, 148), "Rezept")
    msg = str(info.value)
    assert "Exit-Code 1" in msg and "ParseFlags" not in msg
    assert "ohne -silent" in msg and "-print-to HP -print-settings fit,paper=A6 /" in msg


@pytest.mark.real_printer_lookup
def test_unknown_printer_is_reported(monkeypatch, tmp_path):
    import remote_pdf_printer.printing as printing_mod
    monkeypatch.setattr(printing_mod, "_printer_cache", None)
    monkeypatch.setattr(printing_mod, "list_printers", lambda p: ["HP75B446 (HP Smart Tank 7300)", "Microsoft Print to PDF"])
    lp = tmp_path / "lp"
    lp.write_text("#!/bin/sh\nexit 0\n")
    lp.chmod(0o755)
    with pytest.raises(PrintError) as info:
        print_pdf(PrintingSettings(backend="cups", lp_command=str(lp)), PrintSettings(printer="HP75B446"), make_pdf(105, 148), "x")
    msg = str(info.value)
    assert "'HP75B446' ist nicht installiert" in msg and "Meinten Sie 'HP75B446 (HP Smart Tank 7300)'" in msg
    # correct name prints
    assert print_pdf(PrintingSettings(backend="cups", lp_command=str(lp)),
                     PrintSettings(printer="HP75B446 (HP Smart Tank 7300)"), make_pdf(105, 148), "x") == "ok"


def _raw(url, method, headers):
    req = urllib.request.Request(url, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, dict(resp.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers)


def test_cors_preflight_for_extensions(http_server):
    status, h = _raw(http_server + "/api/health", "OPTIONS", {
        "Origin": "chrome-extension://abcdef", "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization", "Access-Control-Request-Private-Network": "true"})
    assert status == 204
    assert h["Access-Control-Allow-Origin"] == "chrome-extension://abcdef"
    assert "Authorization" in h["Access-Control-Allow-Headers"]
    assert h["Access-Control-Allow-Private-Network"] == "true"
    # websites are not allowed
    status, h = _raw(http_server + "/api/documents", "OPTIONS", {"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert status == 403 and "Access-Control-Allow-Origin" not in h


def test_cors_header_on_responses(http_server):
    status, h = _raw(http_server + "/api/health", "GET", {"Origin": "moz-extension://x", "Authorization": f"Bearer {TOKEN}"})
    assert status == 200 and h["Access-Control-Allow-Origin"] == "moz-extension://x"
    status, h = _raw(http_server + "/api/health", "GET", {"Origin": "https://evil.example", "Authorization": f"Bearer {TOKEN}"})
    assert status == 200 and "Access-Control-Allow-Origin" not in h

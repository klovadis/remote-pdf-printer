import json
import threading
import urllib.error
import urllib.request

import pytest
from conftest import make_pdf

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

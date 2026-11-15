// End-to-end test of the Chrome version:
//   real Chromium + built extension + fake web application on "app.example.test" (HTTPS, local)
//   + real print server.
//
//   cd extension && npm run test:chrome
//
// Needs: Node 22+, Playwright with Chromium, openssl, and a Python with the server installed
// (set PYTHON=/path/to/venv/bin/python if "python3" does not have it).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildChrome } from "../build.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const work = mkdtempSync(join(tmpdir(), "dpp-chrome-"));
const TOKEN = "test-token-0123456789abcdef";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- minimal PDF generator (same idea as server/tests/conftest.py) ------------------------
function makePdf(widthMm, heightMm, text) {
  const MM = 72 / 25.4;
  const w = widthMm * MM;
  const h = heightMm * MM;
  const stream = `BT /F1 10 Tf 20 ${(h - 30).toFixed(1)} Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w.toFixed(2)} ${h.toFixed(2)}] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const PDFS = {
  "rezept.pdf": makePdf(148, 105, "Kassenrezept Muster 16"),
  "befund.pdf": makePdf(210, 297, "Arztbrief an Kollegen"),
  "ueberweisung.pdf": makePdf(210, 297, "Ueberweisungsschein"),
  "rechnung.pdf": makePdf(210, 297, "Privatrechnung Rechnungsnummer 2026-17"),
};

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// --- fake web application (HTTPS) ---------------------------------------------------------
async function startWebApp() {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=app.example.test",
    "-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem")], { stdio: "ignore" });
  const port = await freePort();
  const server = https.createServer({ key: readFileSync(join(work, "key.pem")), cert: readFileSync(join(work, "cert.pem")) }, (req, res) => {
    const name = req.url.split("?")[0].slice(1);
    if (PDFS[name]) {
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}"` });
      return res.end(PDFS[name]);
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Web-App (Test)</title><body>Test</body>");
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { server, origin: `https://app.example.test:${port}`, otherOrigin: `https://other.example.test:${port}` };
}

// --- real print server ----------------------------------------------------------------------
async function startPrintServer() {
  const port = await freePort();
  const lp = join(work, "fake-lp");
  writeFileSync(lp, `#!/bin/sh\necho "$@" >> "${join(work, "lp.log")}"\necho "request id is fake-1"\n`);
  chmodSync(lp, 0o755);
  let cfg = readFileSync(join(repo, "server", "config.example.toml"), "utf8")
    .replace("BITTE-AENDERN-mindestens-16-zeichen", TOKEN)
    .replace("port = 8080", `port = ${port}`)
    .replace('dir = "/srv/remote-pdf"', `dir = "${join(work, "docs")}"`)
    .replace('backend = "auto"', 'backend = "cups"')
    .replace('lp_command = "lp"', `lp_command = "${lp}"`);
  writeFileSync(join(work, "config.toml"), cfg);
  const python = process.env.PYTHON || "python3";
  const proc = spawn(python, ["-m", "remote_pdf_printer", "-c", join(work, "config.toml")], {
    cwd: join(repo, "server"),
    stdio: ["ignore", "inherit", "pipe"],
  });
  let log = "";
  proc.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 50 && !log.includes("Lausche auf"); i++) await sleep(100);
  assert.ok(log.includes("Lausche auf"), "Druckserver startet nicht:\n" + log);
  return { proc, url: `http://127.0.0.1:${port}`, log: () => log };
}

const lpLog = () => (existsSync(join(work, "lp.log")) ? readFileSync(join(work, "lp.log"), "utf8") : "");
const stored = (folder) => (existsSync(join(work, "docs", folder)) ? readdirSync(join(work, "docs", folder)) : []);

// --- main -----------------------------------------------------------------------------------
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(["OK  ", name]);
  } catch (err) {
    results.push(["FAIL", name + "\n      " + err.message.split("\n").join("\n      ")]);
  }
}

const webapp = await startWebApp();
const printer = await startPrintServer();
const { outDir } = buildChrome(join(work, "ext"));
// Test only: grant the local server origin up front (normally requested on the options page).
const manifestPath = join(outDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = ["http://127.0.0.1/*", "*://app.example.test/*", "*://other.example.test/*"];
writeFileSync(manifestPath, JSON.stringify(manifest));

const context = await chromium.launchPersistentContext(join(work, "profile"), {
  channel: "chromium",
  headless: true,
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${outDir}`,
    `--load-extension=${outDir}`,
    "--host-resolver-rules=MAP *.example.test 127.0.0.1",
    "--ignore-certificate-errors",
    "--no-proxy-server", // talk to the local test servers directly
  ],
});
const consoleLines = [];
try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker", { timeout: 10000 });
  worker.on("console", (m) => consoleLines.push("[sw] " + m.text()));
  await worker.evaluate(
    ([serverUrl, token]) =>
      chrome.storage.local.set({ serverUrl, token, domains: ["app.example.test"], enabled: true, debug: true, notify: "none" }),
    [printer.url, TOKEN]
  );
  // The background registers the content scripts for the configured domain.
  let registered = [];
  for (let i = 0; i < 50 && registered.length < 2; i++) {
    await sleep(100);
    registered = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  }
  assert.deepEqual(registered.map((r) => r.matches).flat(), ["*://app.example.test/*", "*://app.example.test/*"]);

  await check("Einstellungsseite: Verbindungstest erreicht den Server", async () => {
    const id = new URL(worker.url()).host;
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${id}/options/options.html`);
    await opt.fill("#serverUrl", printer.url);
    await opt.fill("#token", TOKEN);
    await opt.click("#test");
    await opt.waitForFunction(() => !/^Teste/.test(document.getElementById("status").textContent), null, { timeout: 10000 });
    const text = await opt.textContent("#status");
    assert.match(text, /Verbunden mit Server .*Rezept \(A6\): druckt auf Rezeptdrucker/s, text);
    await opt.close();
  });

  const page = await context.newPage();
  page.on("console", (m) => consoleLines.push("[page] " + m.text()));
  await page.goto(webapp.origin + "/praxis");
  await sleep(300);

  const popups = [];
  context.on("page", (p) => popups.push(p.url()));

  // Like the real web application: fetch PDF, make a blob URL, window.open it.
  const openBlob = (name) =>
    page.evaluate(async (n) => {
      const blob = await (await fetch("/" + n + "?inline")).blob();
      const w = window.open(URL.createObjectURL(new Blob([blob], { type: "application/pdf" })));
      return w !== null;
    }, name);

  await check("Rezept (Blob + window.open) wird gedruckt und nicht angezeigt", async () => {
    await openBlob("rezept.pdf");
    await sleep(1500);
    assert.match(lpLog(), /-d Rezeptdrucker .*-o media=A6/);
    assert.equal(stored("rezepte").length, 1);
    assert.equal(popups.length, 0, "es wurde trotzdem ein Fenster geöffnet: " + popups);
  });

  await check("Befund (Blob + window.open) wird abgelegt und normal geöffnet", async () => {
    await openBlob("befund.pdf");
    await sleep(1500);
    assert.equal(stored("befunde").length, 1);
    assert.equal(popups.length, 1, "Fenster wurde nicht geöffnet");
    assert.ok(popups[0].startsWith("blob:"), popups[0]);
  });

  await check("A4-Dokument im versteckten iframe + print() wird gedruckt, print() ignoriert", async () => {
    const printed = await page.evaluate(async () => {
      let calls = 0;
      const blob = await (await fetch("/ueberweisung.pdf?inline")).blob();
      const f = document.createElement("iframe");
      f.style.display = "none";
      document.body.append(f);
      f.src = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
      await new Promise((r) => setTimeout(r, 1500));
      const w = f.contentWindow;
      const orig = w.print;
      try { w.print = () => calls++; } catch {}
      w.print();
      return { src: f.getAttribute("src"), calls, stub: w.print === orig };
    });
    assert.equal(printed.src, null, "iframe hat das PDF trotzdem geladen");
    assert.match(lpLog(), /-d A4-Drucker /);
    assert.equal(stored("a4").length, 1);
  });

  // Like common print helpers: create iframe, set src, append, print in onload.
  const printViaIframe = (name, extra) =>
    page.evaluate(
      async ([n, x]) => {
        const blob = await (await fetch("/" + n + "?inline")).blob();
        const f = document.createElement("iframe");
        f.style.display = "none";
        const events = [];
        f.onload = () => {
          const w = f.contentWindow;
          let href;
          try {
            href = w.location ? w.location.href : "(stub)";
          } catch {
            href = "(cross-origin)";
          }
          events.push(href);
          w.print = w.print; // touch like real code would
        };
        f.src = URL.createObjectURL(new Blob([blob, x], { type: "application/pdf" }));
        document.body.append(f); // inserting fires a load event for about:blank
        await new Promise((r) => setTimeout(r, 2000));
        return events;
      },
      [name, extra]
    );

  await check("Rechnung im iframe (Druckhilfe-Muster): kein load/print auf about:blank", async () => {
    const events = await printViaIframe("rechnung.pdf", "   ");
    assert.deepEqual(events, [], "Seite hat load-Ereignisse gesehen und würde drucken: " + JSON.stringify(events));
    assert.equal(stored("rechnungen").length, 1);
  });

  await check("Befund im iframe (Druckhilfe-Muster): load erst mit dem echten PDF", async () => {
    const events = await printViaIframe("befund.pdf", "    ");
    assert.equal(events.length, 1, "erwartet genau ein load-Ereignis: " + JSON.stringify(events));
    assert.ok(events[0].startsWith("blob:"), "load kam von " + events[0]);
  });

  await check("Rechnung als echter Download wird abgelegt und der Download entfernt", async () => {
    const downloads = [];
    page.on("download", (d) => downloads.push(d));
    await page.evaluate(() => {
      const a = document.createElement("a");
      a.href = "/rechnung.pdf";
      document.body.append(a);
      a.click();
    });
    await sleep(2500);
    assert.equal(stored("rechnungen").length, 2, "Rechnung nicht abgelegt");
    const list = await worker.evaluate(() => chrome.downloads.search({}));
    assert.equal(list.filter((d) => d.url.includes("rechnung.pdf")).length, 0, "Download ist noch in der Liste: " + JSON.stringify(list));
  });

  await check("Nicht eingetragene Domain: Erweiterung bleibt inaktiv", async () => {
    const other = await context.newPage();
    await other.goto(webapp.otherOrigin + "/praxis");
    const before = popups.length;
    const lpBefore = lpLog();
    const hooked = await other.evaluate(() => Boolean(window[Symbol.for("__remotePdfPrinter")]));
    await other.evaluate(async () => {
      const blob = await (await fetch("/rezept.pdf?inline")).blob();
      window.open(URL.createObjectURL(new Blob([blob, "  "], { type: "application/pdf" })));
    });
    await sleep(1000);
    assert.equal(hooked, false, "Hooks sind auf der nicht eingetragenen Domain aktiv");
    assert.equal(popups.length, before + 1, "PDF-Fenster wurde nicht geöffnet");
    assert.equal(lpLog(), lpBefore, "es wurde trotzdem gedruckt");
    await other.close();
  });

  await check("Server nicht erreichbar: Dokument wird normal geöffnet, Grund im Protokoll", async () => {
    await worker.evaluate(() => chrome.storage.local.set({ serverUrl: "http://127.0.0.1:9" }));
    await sleep(200);
    const before = popups.length;
    await page.evaluate(async () => {
      const blob = await (await fetch("/rezept.pdf?inline")).blob();
      // different bytes than before, so it is not treated as duplicate
      window.open(URL.createObjectURL(new Blob([blob, " "], { type: "application/pdf" })));
    });
    await sleep(1500);
    assert.equal(popups.length, before + 1, "Fenster wurde nicht geöffnet");
    assert.ok(consoleLines.some((l) => l.includes("Server nicht erreichbar (http://127.0.0.1:9")), "Grund fehlt im Protokoll");
  });
} finally {
  await context.close();
  webapp.server.close();
  printer.proc.kill();
}

for (const [status, name] of results) console.log(`${status} ${name}`);
if (results.some(([s]) => s === "FAIL")) {
  console.log("\nKonsole:\n  " + consoleLines.join("\n  "));
  console.log("\nServer-Log:\n" + printer.log());
  process.exit(1);
}

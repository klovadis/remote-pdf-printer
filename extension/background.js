/* Remote PDF Printer – background script.
 * Firefox: MV3 event page. Chrome: MV3 service worker. Same file for both.
 *
 * Capture paths that end up in sendPdf():
 *  1. PDF blobs / data: URLs created inside a configured web page, reported by content/bridge.js (both browsers).
 *  2. Firefox: HTTP responses that are PDFs (new tab, iframe, download) via webRequest.filterResponseData.
 *     Chrome:  PDF downloads via the downloads API (paused, re-fetched, then resumed or cancelled).
 *     Chrome cannot intercept PDFs opened directly in a tab/frame; these are only logged.
 * The server answers with a decision; "show" lets the browser behave as usual, "suppress" hides the PDF.
 */
"use strict";

const ext = globalThis.browser ?? globalThis.chrome;
// Firefox only: read and hold back HTTP responses.
const CAN_FILTER_RESPONSES = typeof ext.webRequest?.filterResponseData === "function";

// Chrome service worker: load the shared helper (Firefox lists it in manifest background.scripts).
if (typeof importScripts === "function" && typeof parseDomainList === "undefined") importScripts("common/domains.js");

const DEFAULTS = {
  domains: [], // hosts on which the extension is active, see common/domains.js
  serverUrl: "",
  token: "",
  enabled: true,
  notify: "all", // all | errors | none
  debug: false,
  captureForeign: false,
};
const DEDUPE_MS = 15000;
const REQUEST_TIMEOUT_MS = 30000;
const LOG_SIZE = 30;

let settings = null;
let activeDomains = [];
const settingsReady = ext.storage.local.get(DEFAULTS).then((s) => {
  settings = s;
  activeDomains = parseDomainList(s.domains).domains;
});
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !settings) return;
  for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue ?? DEFAULTS[k];
  if ("domains" in changes) {
    activeDomains = parseDomainList(settings.domains).domains;
    syncContentScripts();
  }
});

function debug(...args) {
  if (settings?.debug) console.log("[Remote PDF Printer]", ...args);
}

// Problems are always logged (also without debug mode), visible in the browser console (Ctrl+Shift+J).
function warn(...args) {
  console.warn("[Remote PDF Printer]", ...args);
}

// ---------------------------------------------------------------------------------------
// Sending to the server
// ---------------------------------------------------------------------------------------

const recentHashes = new Map(); // sha256 -> {time, promise}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function looksLikePdf(bytes) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

async function sendPdf(bytes, meta) {
  await settingsReady;
  if (!settings.enabled) return { browser: "show", skipped: "disabled", reason: "Erweiterung ist ausgeschaltet" };
  if (!settings.serverUrl || !settings.token) {
    const reason = "Server-Adresse oder Token fehlt in den Einstellungen der Erweiterung";
    warn(reason);
    notify("error", "Nicht eingerichtet", "Bitte Server-Adresse und Token in den Einstellungen der Erweiterung eintragen.");
    return { browser: "show", error: "not configured", reason };
  }
  const hash = await sha256Hex(bytes);
  const now = Date.now();
  for (const [h, v] of recentHashes) if (now - v.time > DEDUPE_MS) recentHashes.delete(h);
  const hit = recentHashes.get(hash);
  if (hit) {
    debug("Duplikat, nutze vorherige Entscheidung", meta);
    return hit.promise.then((d) => ({ ...d, reason: "Duplikat – " + d.reason }));
  }
  const promise = postToServer(bytes, meta);
  recentHashes.set(hash, { time: now, promise });
  return promise;
}

class ServerError extends Error {}

async function postToServer(bytes, meta) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const entry = { time: Date.now(), filename: meta.filename || "", method: meta.method };
  const url = settings.serverUrl.replace(/\/+$/, "") + "/api/documents";
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + settings.token,
        "Content-Type": "application/pdf",
        "X-Filename": encodeURIComponent(meta.filename || ""),
        "X-Source-Url": encodeURIComponent(meta.url || ""),
        "X-Capture-Method": meta.method,
      },
      body: bytes,
      credentials: "omit",
      cache: "no-store",
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const hint = { 401: " – Token in der Erweiterung stimmt nicht mit api_token überein", 403: " – Adresse nicht in allowed_clients (Server) bzw. vom Proxy gesperrt" }[res.status] || "";
      throw new ServerError(`Server lehnt ab: HTTP ${res.status}${body.error ? " " + body.error : ""}${hint}`);
    }
    const decision = body.browser === "suppress" ? "suppress" : "show";
    Object.assign(entry, {
      label: body.label || body.category,
      browser: decision,
      printed: body.printed?.printer || null,
      stored: !!body.stored,
      error: (body.errors || []).join("; ") || null,
      duplicate: !!body.duplicate,
    });
    const ms = Math.round(performance.now() - started);
    const actions = [body.printed && `gedruckt auf ${body.printed.printer}`, body.stored && "abgelegt"].filter(Boolean).join(", ");
    const reason = entry.error
      ? `Server meldet Fehler (${entry.label}): ${entry.error}`
      : `Server: ${entry.label} → ${actions || "keine Aktion"} (${ms} ms)`;
    if (entry.error) warn(reason, meta);
    else debug(reason, meta, body);
    if (!body.duplicate) {
      if (entry.error) notify("error", `${entry.label}: Problem`, entry.error + "\nDas PDF wird normal angezeigt.");
      else {
        const what = [entry.printed && `gedruckt auf ${entry.printed}`, entry.stored && "abgelegt"].filter(Boolean).join(", ");
        notify("info", entry.label, (what || "an Server gesendet") + (meta.filename ? `\n${meta.filename}` : ""));
      }
    }
    return { ...body, browser: decision, reason };
  } catch (err) {
    let reason;
    if (err instanceof ServerError) reason = err.message;
    else if (err.name === "AbortError") reason = `Server nicht erreichbar: keine Antwort nach ${REQUEST_TIMEOUT_MS / 1000} s (${url})`;
    else
      reason =
        `Server nicht erreichbar (${url}): ${err.message} – läuft der Server, stimmt die Adresse` +
        (url.startsWith("https:") ? ", vertraut der Browser dem Zertifikat?" : "?");
    warn(reason, meta);
    Object.assign(entry, { browser: "show", error: reason });
    const title = err instanceof ServerError ? "Druckserver lehnt ab" : "Druckserver nicht erreichbar";
    notify("error", title, `${reason}\nDas PDF wird normal angezeigt.`);
    return { browser: "show", error: reason, reason };
  } finally {
    clearTimeout(timer);
    addLogEntry(entry);
  }
}

function notify(kind, title, message) {
  if (!settings || settings.notify === "none" || (settings.notify === "errors" && kind !== "error")) return;
  ext.notifications.create({
    type: "basic",
    iconUrl: ext.runtime.getURL("icons/icon-128.png"),
    title: "Remote PDF Printer: " + title,
    message,
  });
}

async function addLogEntry(entry) {
  const { log = [] } = await ext.storage.session.get("log");
  log.unshift(entry);
  await ext.storage.session.set({ log: log.slice(0, LOG_SIZE) });
}

// ---------------------------------------------------------------------------------------
// Helpers for HTTP responses and downloads
// ---------------------------------------------------------------------------------------

function header(details, name) {
  const h = details.responseHeaders?.find((x) => x.name.toLowerCase() === name);
  return h ? h.value || "" : "";
}

function filenameFromDisposition(cd) {
  let m = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd || "");
  if (m) {
    try {
      return decodeURIComponent(m[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through */
    }
  }
  m = /filename\s*=\s*"?([^";]+)"?/i.exec(cd || "");
  return m ? m[1].trim() : "";
}

function filenameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split("/").pop();
    return decodeURIComponent(last || "");
  } catch {
    return "";
  }
}

function basename(path) {
  return (path || "").split(/[\\/]/).pop();
}

function isPdfContentType(ct, filename) {
  ct = (ct || "").toLowerCase();
  if (ct.includes("application/pdf") || ct.includes("application/x-pdf")) return true;
  const generic = !ct || /octet-stream|binary|force-download|download/.test(ct);
  return generic && /\.pdf$/i.test(filename || "");
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function anyConfigured(...urls) {
  return urls.some((u) => u && urlMatchesDomains(u, activeDomains));
}

const RESOURCE_TYPES = ["main_frame", "sub_frame", "object"];

// ---------------------------------------------------------------------------------------
// Firefox: hold back PDF HTTP responses until the server has decided
// ---------------------------------------------------------------------------------------

const pendingByUrl = new Map(); // url -> Promise<decision>, consulted by the downloads listener

async function onHeadersReceived(details) {
  await settingsReady;
  if (!settings.enabled || details.tabId < 0) return {};
  if (details.statusCode < 200 || details.statusCode >= 300) return {};
  // Requests to other hosts are only visible at all if "<all_urls>" was granted (option captureForeign).
  if (!anyConfigured(details.url, details.documentUrl, details.originUrl)) return {};
  const cd = header(details, "content-disposition");
  const filename = filenameFromDisposition(cd) || filenameFromUrl(details.url);
  if (!isPdfContentType(header(details, "content-type"), filename)) return {};

  const isAttachment = /^\s*attachment/i.test(cd);
  debug("PDF-Antwort erkannt", details.type, details.url, { filename, isAttachment });

  let resolveDecision;
  const decisionPromise = new Promise((r) => (resolveDecision = r));
  pendingByUrl.set(details.url, decisionPromise);
  setTimeout(() => pendingByUrl.delete(details.url), 120000);

  const filter = ext.webRequest.filterResponseData(details.requestId);
  const chunks = [];
  filter.ondata = (e) => chunks.push(new Uint8Array(e.data));
  filter.onerror = () => {
    warn("Fehler beim Mitlesen der PDF-Antwort", details.url, filter.error);
    resolveDecision({ browser: "show", reason: "Filterfehler: " + filter.error });
  };
  filter.onstop = async () => {
    const size = chunks.reduce((n, c) => n + c.length, 0);
    const bytes = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.length;
    }
    let decision = { browser: "show", reason: "Antwort enthält keine PDF-Daten" };
    try {
      if (looksLikePdf(bytes)) {
        decision = await sendPdf(bytes, { filename, url: details.url, method: "http:" + details.type, tabId: details.tabId });
      }
    } catch (err) {
      warn("Unerwarteter Fehler", err);
      decision = { browser: "show", reason: "Unerwarteter Fehler: " + err };
    }
    debug("Entscheidung", "http:" + details.type, decision.browser, "–", decision.reason, details.url);
    resolveDecision(decision);
    if (decision.browser !== "suppress") {
      filter.write(bytes);
      filter.close();
      return;
    }
    if (details.type !== "main_frame") {
      // Tell the embedding page so it cannot print the (now empty) frame.
      await ext.tabs
        .sendMessage(details.tabId, { type: "suppressedUrl", url: details.url }, { frameId: details.parentFrameId ?? 0 })
        .catch(() => {});
    }
    filter.close();
    if (details.type === "main_frame" && !isAttachment) closeOrGoBack(details.tabId);
  };
  return {};
}

async function closeOrGoBack(tabId) {
  try {
    const tab = await ext.tabs.get(tabId);
    if (tab.openerTabId != null) {
      await ext.tabs.update(tab.openerTabId, { active: true }).catch(() => {});
      await ext.tabs.remove(tabId);
    } else {
      await ext.tabs.goBack(tabId);
    }
  } catch (err) {
    debug("Tab konnte nicht geschlossen werden", err);
  }
}

async function removeDownload(item) {
  try {
    await ext.downloads.cancel(item.id).catch(() => {});
    const [current] = await ext.downloads.search({ id: item.id });
    if (current?.state === "complete") await ext.downloads.removeFile(item.id).catch(() => {});
    await ext.downloads.erase({ id: item.id });
  } catch (err) {
    warn("Download konnte nicht entfernt werden", err);
  }
}

// Firefox: downloads of suppressed PDFs would otherwise end up as empty files.
async function onDownloadCreatedFirefox(item) {
  const pending = pendingByUrl.get(item.url);
  if (!pending) return;
  const decision = await pending;
  if (decision.browser !== "suppress") return;
  debug("Download unterdrückt", item.url);
  await removeDownload(item);
}

// ---------------------------------------------------------------------------------------
// Chrome: PDF downloads are paused, fetched again by the extension and then resumed or removed
// ---------------------------------------------------------------------------------------

const handledDownloads = new Set();

async function onDownloadCreatedChrome(item) {
  await settingsReady;
  if (!settings.enabled || handledDownloads.has(item.id)) return;
  const url = item.finalUrl || item.url;
  // blob:/data: downloads were already decided by the page hooks before the download started.
  if (!/^https?:/i.test(url)) return;
  if (!anyConfigured(url) && !(settings.captureForeign && anyConfigured(item.referrer))) return;
  if (!isPdfContentType(item.mime, basename(item.filename) || filenameFromUrl(url))) return;
  handledDownloads.add(item.id);

  debug("PDF-Download erkannt", url);
  await ext.downloads.pause(item.id).catch(() => {}); // may already be complete for small files
  let decision;
  try {
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const filename =
      basename(item.filename) || filenameFromDisposition(res.headers.get("content-disposition")) || filenameFromUrl(url);
    decision = looksLikePdf(bytes)
      ? await sendPdf(bytes, { filename, url, method: "download", tabId: item.tabId })
      : { browser: "show", reason: "Download enthält keine PDF-Daten" };
  } catch (err) {
    decision = { browser: "show", reason: `PDF konnte nicht nachgeladen werden: ${err.message}` };
    warn(decision.reason, url);
  }
  debug("Entscheidung", "download", decision.browser, "–", decision.reason, url);
  if (decision.browser === "suppress") await removeDownload(item);
  else await ext.downloads.resume(item.id).catch(() => {});
}

// Chrome: PDFs opened directly in a tab or frame cannot be held back – log it so it is visible.
function onHeadersReceivedChrome(details) {
  if (!settings?.enabled || details.statusCode < 200 || details.statusCode >= 300) return;
  if (!anyConfigured(details.url, details.initiator)) return;
  const cd = header(details, "content-disposition");
  if (/^\s*attachment/i.test(cd)) return; // handled as download
  const filename = filenameFromDisposition(cd) || filenameFromUrl(details.url);
  if (!isPdfContentType(header(details, "content-type"), filename)) return;
  warn(
    `PDF wird direkt im ${details.type === "main_frame" ? "Tab" : "Rahmen"} geöffnet – das kann die Chrome-Version ` +
      "nicht abfangen (nur Firefox). Bitte diese Meldung melden.",
    details.url
  );
}

// ---------------------------------------------------------------------------------------
// Listener registration (synchronous, so the background wakes up for these events)
// ---------------------------------------------------------------------------------------

if (CAN_FILTER_RESPONSES) {
  ext.webRequest.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls: ["<all_urls>"], types: RESOURCE_TYPES },
    ["blocking", "responseHeaders"]
  );
  ext.downloads.onCreated.addListener(onDownloadCreatedFirefox);
} else {
  ext.downloads.onCreated.addListener(onDownloadCreatedChrome);
  // Only present when loaded from the shared source folder; the Chrome build omits webRequest.
  ext.webRequest?.onHeadersReceived.addListener(
    onHeadersReceivedChrome,
    { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
    ["responseHeaders"]
  );
}

// ---------------------------------------------------------------------------------------
// Content scripts: registered at runtime for the configured (and permitted) domains
// ---------------------------------------------------------------------------------------

const SCRIPT_IDS = ["rpp-bridge", "rpp-main-world"];
let syncing = Promise.resolve();

function syncContentScripts() {
  syncing = syncing
    .then(doSyncContentScripts)
    .catch((err) => warn("Inhaltsskripte konnten nicht registriert werden:", err));
  return syncing;
}

async function doSyncContentScripts() {
  await settingsReady;
  const permitted = [];
  const missing = [];
  for (const d of activeDomains) {
    ((await ext.permissions.contains({ origins: [d.pattern] })) ? permitted : missing).push(d.pattern);
  }
  if (missing.length) warn("Keine Berechtigung für", missing.join(", "), "– bitte in den Einstellungen speichern und erlauben");

  const registered = await ext.scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS }).catch(() => []);
  if (registered.length) await ext.scripting.unregisterContentScripts({ ids: registered.map((r) => r.id) });
  if (!permitted.length) {
    debug("Keine Domains aktiv");
    return;
  }
  const common = { matches: permitted, runAt: "document_start", allFrames: true, persistAcrossSessions: true };
  const scripts = [
    { id: SCRIPT_IDS[0], js: ["content/bridge.js"], ...common },
    { id: SCRIPT_IDS[1], js: ["content/main-world.js"], world: "MAIN", ...common },
  ];
  try {
    // Also run in about:blank / blob: frames created by these pages.
    await ext.scripting.registerContentScripts(scripts.map((x) => ({ ...x, matchOriginAsFallback: true })));
  } catch (err) {
    debug("matchOriginAsFallback nicht unterstützt, registriere ohne", err);
    await ext.scripting.registerContentScripts(scripts);
  }
  debug("Aktiv auf", permitted.join(", "));
}

ext.runtime.onInstalled.addListener(() => syncContentScripts());
ext.runtime.onStartup.addListener(() => syncContentScripts());
ext.permissions.onAdded.addListener(() => syncContentScripts());
ext.permissions.onRemoved.addListener(() => syncContentScripts());

// ---------------------------------------------------------------------------------------
// Messages from content scripts, popup and options page
// ---------------------------------------------------------------------------------------

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function handleMessage(msg, sender) {
  switch (msg?.type) {
    case "pdf": {
      // Firefox passes an ArrayBuffer, Chrome (JSON messaging) a base64 string.
      const bytes = msg.base64 != null ? base64ToBytes(msg.base64) : new Uint8Array(msg.bytes);
      if (!looksLikePdf(bytes)) {
        return Promise.resolve({ browser: "show", notPdf: true, reason: "keine PDF-Daten (Kennung %PDF fehlt)" });
      }
      return sendPdf(bytes, {
        filename: msg.filename,
        url: msg.pageUrl || sender.url,
        method: msg.method,
        tabId: sender.tab?.id,
      });
    }
    case "log":
      // Debug messages from the page hooks.
      debug("[Seite]", ...(msg.args || []));
      return null;
    case "getSettings":
      return settingsReady.then(() => ({ enabled: settings.enabled, debug: settings.debug }));
    case "syncContentScripts":
      return syncContentScripts().then(() => ({ ok: true }));
    case "health":
      return checkHealth(msg.serverUrl, msg.token);
    default:
      return null;
  }
}

// sendResponse + "return true" works in both Firefox and Chrome.
ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const result = handleMessage(msg, sender);
  if (!result) return false;
  result.then(sendResponse, (err) => {
    warn("Fehler bei der Verarbeitung", err);
    sendResponse({ browser: "show", reason: `Fehler in der Erweiterung: ${err}` });
  });
  return true;
});

async function checkHealth(serverUrl, token) {
  await settingsReady;
  serverUrl = serverUrl ?? settings.serverUrl;
  token = token ?? settings.token;
  if (!serverUrl) return { ok: false, error: "Keine Server-Adresse eingetragen" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(serverUrl.replace(/\/+$/, "") + "/api/health", {
      headers: { Authorization: "Bearer " + token },
      credentials: "omit",
      cache: "no-store",
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
    return body;
  } catch (err) {
    const msg = err.name === "AbortError" ? "Zeitüberschreitung" : err.message;
    return {
      ok: false,
      error: `${msg} – laufen Caddy und der Server, vertraut der Browser dem Zertifikat und ist die Berechtigung erteilt?`,
    };
  } finally {
    clearTimeout(timer);
  }
}

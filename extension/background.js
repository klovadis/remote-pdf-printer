/* Remote PDF Printer – background script (Firefox, MV3 event page).
 *
 * Two capture paths end up in sendPdf():
 *  1. HTTP responses that are PDFs (new tab, iframe, download) via webRequest.filterResponseData.
 *  2. PDF blobs / data: URLs created inside the WebApp page, reported by content/bridge.js.
 * The server answers with a decision; "show" lets Firefox behave as usual, "suppress" hides the PDF.
 */
"use strict";

const WEBAPP_PATTERNS = ["*://*.example.de/*", "*://*.example.com/*", "*://*.example.net/*"];
const WEBAPP_HOST = /(^|\.)example\.(de|com|net)$/i;
const DEFAULTS = {
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
const settingsReady = browser.storage.local.get(DEFAULTS).then((s) => (settings = s));
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !settings) return;
  for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue ?? DEFAULTS[k];
  if ("captureForeign" in changes) registerForeignListener();
});

function debug(...args) {
  if (settings?.debug) console.log("[PDF-Drucker]", ...args);
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
  if (!settings.enabled) return { browser: "show", skipped: "disabled" };
  if (!settings.serverUrl || !settings.token) {
    notify("error", "Nicht eingerichtet", "Bitte Server-Adresse und Token in den Einstellungen der Erweiterung eintragen.");
    return { browser: "show", error: "not configured" };
  }
  const hash = await sha256Hex(bytes);
  const now = Date.now();
  for (const [h, v] of recentHashes) if (now - v.time > DEDUPE_MS) recentHashes.delete(h);
  const hit = recentHashes.get(hash);
  if (hit) {
    debug("Duplikat, nutze vorherige Entscheidung", meta);
    return hit.promise;
  }
  const promise = postToServer(bytes, meta);
  recentHashes.set(hash, { time: now, promise });
  return promise;
}

async function postToServer(bytes, meta) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const entry = { time: Date.now(), filename: meta.filename || "", method: meta.method };
  try {
    const res = await fetch(settings.serverUrl.replace(/\/+$/, "") + "/api/documents", {
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
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    const decision = body.browser === "suppress" ? "suppress" : "show";
    Object.assign(entry, {
      label: body.label || body.category,
      browser: decision,
      printed: body.printed?.printer || null,
      stored: !!body.stored,
      error: (body.errors || []).join("; ") || null,
      duplicate: !!body.duplicate,
    });
    debug("Server-Entscheidung", meta, body);
    if (!body.duplicate) {
      if (entry.error) notify("error", `${entry.label}: Problem`, entry.error + "\nDas PDF wird normal angezeigt.");
      else {
        const what = [entry.printed && `gedruckt auf ${entry.printed}`, entry.stored && "abgelegt"].filter(Boolean).join(", ");
        notify("info", entry.label, (what || "an Server gesendet") + (meta.filename ? `\n${meta.filename}` : ""));
      }
    }
    return { ...body, browser: decision };
  } catch (err) {
    const msg = err.name === "AbortError" ? "Zeitüberschreitung" : err.message;
    Object.assign(entry, { browser: "show", error: `Server nicht erreichbar: ${msg}` });
    notify("error", "Druckserver nicht erreichbar", `${msg}\nDas PDF wird normal angezeigt.`);
    return { browser: "show", error: msg };
  } finally {
    clearTimeout(timer);
    addLogEntry(entry);
  }
}

function notify(kind, title, message) {
  if (!settings || settings.notify === "none" || (settings.notify === "errors" && kind !== "error")) return;
  browser.notifications.create({
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/icon.svg"),
    title: "PDF-Drucker: " + title,
    message,
  });
}

async function addLogEntry(entry) {
  const { log = [] } = await browser.storage.session.get("log");
  log.unshift(entry);
  await browser.storage.session.set({ log: log.slice(0, LOG_SIZE) });
}

// ---------------------------------------------------------------------------------------
// Path 1: PDF HTTP responses
// ---------------------------------------------------------------------------------------

const pendingByUrl = new Map(); // url -> Promise<decision>, consulted by the downloads listener

function header(details, name) {
  const h = details.responseHeaders?.find((x) => x.name.toLowerCase() === name);
  return h ? h.value || "" : "";
}

function filenameFromDisposition(cd) {
  let m = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
  if (m) {
    try {
      return decodeURIComponent(m[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through */
    }
  }
  m = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
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

function isPdfResponse(details, filename) {
  const ct = header(details, "content-type").toLowerCase();
  if (ct.includes("application/pdf") || ct.includes("application/x-pdf")) return true;
  const generic = !ct || /octet-stream|binary|force-download|download/.test(ct);
  return generic && /\.pdf$/i.test(filename);
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isFromWebApp(details) {
  return [details.url, details.documentUrl, details.originUrl].some((u) => u && WEBAPP_HOST.test(hostOf(u)));
}

async function onHeadersReceived(details) {
  await settingsReady;
  if (!settings.enabled || details.tabId < 0) return {};
  if (details.statusCode < 200 || details.statusCode >= 300) return {};
  if (!isFromWebApp(details)) return {};
  const cd = header(details, "content-disposition");
  const filename = filenameFromDisposition(cd) || filenameFromUrl(details.url);
  if (!isPdfResponse(details, filename)) return {};

  const isAttachment = /^\s*attachment/i.test(cd);
  debug("PDF-Antwort erkannt", details.type, details.url, { filename, isAttachment });

  let resolveDecision;
  const decisionPromise = new Promise((r) => (resolveDecision = r));
  pendingByUrl.set(details.url, decisionPromise);
  setTimeout(() => pendingByUrl.delete(details.url), 120000);

  const filter = browser.webRequest.filterResponseData(details.requestId);
  const chunks = [];
  filter.ondata = (e) => chunks.push(new Uint8Array(e.data));
  filter.onerror = () => {
    debug("Filterfehler", filter.error);
    resolveDecision({ browser: "show" });
  };
  filter.onstop = async () => {
    const size = chunks.reduce((n, c) => n + c.length, 0);
    const bytes = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.length;
    }
    let decision = { browser: "show" };
    try {
      if (looksLikePdf(bytes)) {
        decision = await sendPdf(bytes, { filename, url: details.url, method: "http:" + details.type, tabId: details.tabId });
      }
    } catch (err) {
      console.error("[PDF-Drucker]", err);
    }
    resolveDecision(decision);
    if (decision.browser !== "suppress") {
      filter.write(bytes);
      filter.close();
      return;
    }
    if (details.type !== "main_frame") {
      // Tell the embedding page so it cannot print the (now empty) frame.
      await browser.tabs
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
    const tab = await browser.tabs.get(tabId);
    if (tab.openerTabId != null) {
      await browser.tabs.update(tab.openerTabId, { active: true }).catch(() => {});
      await browser.tabs.remove(tabId);
    } else {
      await browser.tabs.goBack(tabId);
    }
  } catch (err) {
    debug("Tab konnte nicht geschlossen werden", err);
  }
}

// Downloads of suppressed PDFs would otherwise end up as empty files.
browser.downloads.onCreated.addListener(async (item) => {
  const pending = pendingByUrl.get(item.url);
  if (!pending) return;
  const decision = await pending;
  if (decision.browser !== "suppress") return;
  debug("Download unterdrückt", item.url);
  try {
    await browser.downloads.cancel(item.id);
    await browser.downloads.erase({ id: item.id });
  } catch (err) {
    debug("Download konnte nicht abgebrochen werden", err);
  }
});

const RESOURCE_TYPES = ["main_frame", "sub_frame", "object"];

// Registered synchronously so the event page is woken up for WebApp requests.
browser.webRequest.onHeadersReceived.addListener(
  onHeadersReceived,
  { urls: WEBAPP_PATTERNS, types: RESOURCE_TYPES },
  ["blocking", "responseHeaders"]
);

// Optional: PDFs that WebApp loads from other hosts (e.g. cloud storage), needs <all_urls>.
function onForeignHeadersReceived(details) {
  if (WEBAPP_HOST.test(hostOf(details.url))) return {}; // handled by the main listener
  return onHeadersReceived(details);
}

async function registerForeignListener() {
  await settingsReady;
  browser.webRequest.onHeadersReceived.removeListener(onForeignHeadersReceived);
  const granted = await browser.permissions.contains({ origins: ["<all_urls>"] });
  if (settings.captureForeign && granted) {
    browser.webRequest.onHeadersReceived.addListener(
      onForeignHeadersReceived,
      { urls: ["<all_urls>"], types: RESOURCE_TYPES },
      ["blocking", "responseHeaders"]
    );
    debug("Fremd-Domains werden mit überwacht");
  }
}
registerForeignListener();
browser.permissions.onAdded.addListener(registerForeignListener);
browser.permissions.onRemoved.addListener(registerForeignListener);

// ---------------------------------------------------------------------------------------
// Path 2 + UI messages
// ---------------------------------------------------------------------------------------

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg?.type) {
    case "pdf":
      return (async () => {
        const bytes = new Uint8Array(msg.bytes);
        if (!looksLikePdf(bytes)) return { browser: "show", notPdf: true };
        return sendPdf(bytes, {
          filename: msg.filename,
          url: msg.pageUrl || sender.url,
          method: msg.method,
          tabId: sender.tab?.id,
        });
      })();
    case "log":
      // Debug messages from the page hooks.
      debug("[Seite]", ...(msg.args || []));
      return undefined;
    case "getSettings":
      return settingsReady.then(() => ({ enabled: settings.enabled, debug: settings.debug }));
    case "health":
      return checkHealth(msg.serverUrl, msg.token);
    default:
      return undefined;
  }
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
      error: `${msg} – laufen Caddy und der Server, vertraut Firefox dem Zertifikat und ist die Berechtigung erteilt?`,
    };
  } finally {
    clearTimeout(timer);
  }
}

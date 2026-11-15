"use strict";

const ext = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = { serverUrl: "", token: "", enabled: true, notify: "all", debug: false, captureForeign: false };
const $ = (id) => document.getElementById(id);
const status = $("status");

function show(text, ok) {
  status.hidden = false;
  status.textContent = text;
  status.className = "status " + (ok ? "ok" : "err");
}

function readForm() {
  return {
    serverUrl: $("serverUrl").value.trim().replace(/\/+$/, ""),
    token: $("token").value.trim(),
    enabled: $("enabled").checked,
    notify: $("notify").value,
    debug: $("debug").checked,
    captureForeign: $("captureForeign").checked,
  };
}

function originPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

function describeHealth(res) {
  if (!res.ok) return [`Fehler: ${res.error}`, false];
  const lines = res.categories.map((c) => {
    const actions = [c.printer && `druckt auf ${c.printer}`, c.stores && "legt ab", c.browser === "suppress" ? "Firefox: ausblenden" : "Firefox: anzeigen"];
    return `  • ${c.label}: ${actions.filter(Boolean).join(", ")}`;
  });
  return [`Verbunden mit Server ${res.version}. Kategorien:\n${lines.join("\n")}`, true];
}

ext.storage.local.get(DEFAULTS).then((s) => {
  for (const [k, v] of Object.entries(s)) {
    const el = $(k);
    if (el.type === "checkbox") el.checked = v;
    else el.value = v;
  }
});

$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  const s = readForm();
  let origins;
  try {
    if (!/^https?:$/.test(new URL(s.serverUrl).protocol)) throw new Error();
    origins = [originPattern(s.serverUrl)];
  } catch {
    return show("Ungültige Server-Adresse.", false);
  }
  if (s.captureForeign) origins.push("<all_urls>");
  // permissions.request must be called directly in the click handler.
  ext.permissions.request({ origins }).then(async (granted) => {
    if (!granted) return show("Ohne Berechtigung für die Server-Adresse kann die Erweiterung nichts senden.", false);
    if (!s.captureForeign) await ext.permissions.remove({ origins: ["<all_urls>"] }).catch(() => {});
    await ext.storage.local.set(s);
    show("Gespeichert. Teste Verbindung …", true);
    const [text, ok] = describeHealth(await ext.runtime.sendMessage({ type: "health" }));
    show("Gespeichert.\n" + text, ok);
  });
});

$("test").addEventListener("click", async () => {
  const s = readForm();
  show("Teste …", true);
  const [text, ok] = describeHealth(await ext.runtime.sendMessage({ type: "health", serverUrl: s.serverUrl, token: s.token }));
  show(text, ok);
});

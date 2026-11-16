"use strict";

const ext = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = { serverUrl: "", token: "", domains: [], enabled: true, notify: "all", debug: false, captureForeign: false };
const $ = (id) => document.getElementById(id);
const status = $("status");

function show(text, ok) {
  status.hidden = false;
  status.textContent = text;
  status.className = "status " + (ok ? "ok" : "err");
}

// Never hang: if the background script does not answer, say so.
async function send(msg) {
  try {
    const res = await ext.runtime.sendMessage(msg);
    if (res === undefined) throw new Error("keine Antwort");
    return res;
  } catch (err) {
    return {
      ok: false,
      error:
        `Der Hintergrunddienst der Erweiterung antwortet nicht (${err.message}). ` +
        "Erweiterung neu laden (Chrome: chrome://extensions, Firefox: about:debugging) und dort auf Fehler prüfen.",
    };
  }
}

function readForm() {
  return {
    serverUrl: $("serverUrl").value.trim().replace(/\/+$/, ""),
    token: $("token").value.trim(),
    enabled: $("enabled").checked,
    notify: $("notify").value,
    debug: $("debug").checked,
    captureForeign: $("captureForeign").checked,
    domainsText: $("domains").value,
  };
}

function originPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

function describeHealth(res) {
  if (!res.ok) return [`Fehler: ${res.error}`, false];
  const lines = (Array.isArray(res.categories) ? res.categories : []).map((c) => {
    const actions = [c.printer && `druckt auf ${c.printer}`, c.stores && "legt ab", c.browser === "suppress" ? "Browser: ausblenden" : "Browser: anzeigen"];
    return `  • ${c.label || c.name}: ${actions.filter(Boolean).join(", ")}`;
  });
  const version = res.version ? ` ${res.version}` : "";
  return [`Verbunden mit Server${version}.` + (lines.length ? ` Kategorien:\n${lines.join("\n")}` : ""), true];
}

ext.storage.local.get(DEFAULTS).then((s) => {
  for (const [k, v] of Object.entries(s)) {
    const el = $(k);
    if (k === "domains") el.value = v.join("\n");
    else if (el.type === "checkbox") el.checked = v;
    else el.value = v;
  }
});

$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  const { domainsText, ...s } = readForm();
  let serverOrigin;
  try {
    if (!/^https?:$/.test(new URL(s.serverUrl).protocol)) throw new Error();
    serverOrigin = originPattern(s.serverUrl);
  } catch {
    return show("Ungültige Server-Adresse.", false);
  }
  const { domains, errors } = parseDomainList(domainsText);
  if (errors.length) return show(errors.join("\n"), false);
  if (!domains.length) return show("Bitte mindestens eine Website (Domain) eintragen, auf der die Erweiterung aktiv sein soll.", false);
  s.domains = domains.map((d) => (d.wildcard ? "*." : "") + d.host);
  const origins = [serverOrigin, ...domains.map((d) => d.pattern)];
  if (s.captureForeign) origins.push("<all_urls>");

  // permissions.request must be called directly in the click handler (before any await).
  ext.permissions.request({ origins }).then(async (granted) => {
    if (!granted) return show("Ohne diese Berechtigungen kann die Erweiterung nicht arbeiten. Bitte erneut speichern und erlauben.", false);
    // Give up permissions that are no longer needed.
    const keep = new Set(origins);
    const { origins: current = [] } = await ext.permissions.getAll();
    const obsolete = current.filter((o) => !keep.has(o));
    if (obsolete.length) await ext.permissions.remove({ origins: obsolete }).catch(() => {});
    await ext.storage.local.set(s);
    $("domains").value = s.domains.join("\n");
    await send({ type: "syncContentScripts" });
    show("Gespeichert. Teste Verbindung …", true);
    const [text, ok] = describeHealth(await send({ type: "health" }));
    show(`Gespeichert. Aktiv auf: ${s.domains.join(", ")}\nBereits geöffnete Seiten bitte neu laden.\n${text}`, ok);
  });
});

$("test").addEventListener("click", async () => {
  const s = readForm();
  try {
    // Ask for access to the server right away (must happen in the click handler). Not awaited:
    // the server also answers cross-origin requests from extensions, so the test works either way.
    ext.permissions.request({ origins: [originPattern(s.serverUrl)] }).catch(() => {});
  } catch {
    return show("Ungültige Server-Adresse.", false);
  }
  show("Teste …", true);
  const [text, ok] = describeHealth(await send({ type: "health", serverUrl: s.serverUrl, token: s.token }));
  show(text, ok);
});

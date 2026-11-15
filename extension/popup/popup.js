"use strict";

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function init() {
  const s = await browser.storage.local.get({ enabled: true, serverUrl: "" });
  $("enabled").checked = s.enabled;
  $("server").textContent = s.serverUrl || "Kein Server eingerichtet";

  if (s.serverUrl) {
    browser.runtime.sendMessage({ type: "health" }).then((res) => {
      $("dot").className = "dot " + (res.ok ? "ok" : "err");
      if (!res.ok) $("server").textContent = `${s.serverUrl}: ${res.error}`;
    });
  }

  const { log = [] } = await browser.storage.session.get("log");
  const list = $("log");
  if (!log.length) list.append(el("li", "meta", "Noch keine Dokumente in dieser Sitzung."));
  for (const e of log) {
    const li = el("li", e.error ? "error" : "");
    const what = e.error
      ? e.error
      : [e.label, e.printed && `→ ${e.printed}`, e.stored && "abgelegt", e.browser === "show" && "angezeigt"].filter(Boolean).join(" · ");
    li.append(el("div", "what", what));
    const time = new Date(e.time).toLocaleTimeString("de-DE");
    li.append(el("div", "meta", `${time} · ${e.filename || "ohne Namen"} · ${e.method}`));
    list.append(li);
  }
}

$("enabled").addEventListener("change", (e) => browser.storage.local.set({ enabled: e.target.checked }));
$("options").addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
});

init();

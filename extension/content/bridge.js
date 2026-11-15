/* Bridge between the page hooks (main-world.js, runs in the page context) and the
 * background script. Runs in the isolated content-script world. */
"use strict";

(() => {
  const TAG = "__remotePdfPrinter";

  function toPage(payload) {
    window.postMessage({ [TAG]: payload.kind, ...payload }, "*");
  }

  // Requests from the page hooks.
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    const kind = data[TAG];
    if (kind === "log") {
      browser.runtime.sendMessage({ type: "log", args: [String(data.text)] }).catch(() => {});
      return;
    }
    if (kind !== "req") return;
    const id = data.id;
    let decision = { browser: "show" };
    try {
      // The blob comes from the page; read it through the DOM API to get our own ArrayBuffer.
      const bytes = await data.blob.arrayBuffer();
      const res = await browser.runtime.sendMessage({
        type: "pdf",
        bytes,
        filename: String(data.filename || ""),
        pageUrl: location.href,
        method: String(data.method || "blob"),
      });
      if (res && res.browser === "suppress") decision = { browser: "suppress" };
    } catch (err) {
      console.warn("[PDF-Drucker]", err);
    }
    toPage({ kind: "res", id, decision });
  });

  // Notifications from the background script.
  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "suppressedUrl") {
      toPage({ kind: "suppressUrl", url: msg.url });
      return Promise.resolve(true);
    }
    return undefined;
  });

  function sendConfig(s) {
    toPage({ kind: "config", enabled: !!s.enabled, debug: !!s.debug });
  }
  browser.runtime.sendMessage({ type: "getSettings" }).then(sendConfig, () => {});
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ("enabled" in changes || "debug" in changes)) {
      browser.runtime.sendMessage({ type: "getSettings" }).then(sendConfig, () => {});
    }
  });
})();

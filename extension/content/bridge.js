/* Bridge between the page hooks (main-world.js, runs in the page context) and the
 * background script. Runs in the isolated content-script world. */
"use strict";

(() => {
  const TAG = "__remotePdfPrinter";
  const ext = globalThis.browser ?? globalThis.chrome;
  // Firefox can pass binary data in messages; Chrome serialises messages as JSON.
  const BINARY_MESSAGES = ext.runtime.getURL("").startsWith("moz-extension:");

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

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
      ext.runtime.sendMessage({ type: "log", args: [String(data.text)] }).catch(() => {});
      return;
    }
    if (kind !== "req") return;
    const id = data.id;
    let decision = { browser: "show", reason: "keine Antwort" };
    try {
      // The blob comes from the page; read it through the DOM API to get our own copy.
      const payload = BINARY_MESSAGES ? { bytes: await data.blob.arrayBuffer() } : { base64: await blobToBase64(data.blob) };
      const res = await ext.runtime.sendMessage({
        type: "pdf",
        ...payload,
        filename: String(data.filename || ""),
        pageUrl: location.href,
        method: String(data.method || "blob"),
      });
      decision = {
        browser: res && res.browser === "suppress" ? "suppress" : "show",
        reason: String((res && res.reason) || ""),
      };
    } catch (err) {
      console.warn("[PDF-Drucker]", err);
      decision = { browser: "show", reason: `Hintergrundskript nicht erreichbar: ${err}` };
    }
    toPage({ kind: "res", id, decision });
  });

  // Notifications from the background script.
  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "suppressedUrl") {
      toPage({ kind: "suppressUrl", url: msg.url });
      sendResponse(true);
    }
    return false;
  });

  function sendConfig(s) {
    toPage({ kind: "config", enabled: !!s.enabled, debug: !!s.debug });
  }
  ext.runtime.sendMessage({ type: "getSettings" }).then(sendConfig, () => {});
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ("enabled" in changes || "debug" in changes)) {
      ext.runtime.sendMessage({ type: "getSettings" }).then(sendConfig, () => {});
    }
  });
})();

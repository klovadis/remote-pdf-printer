/* Remote PDF Printer – hooks in the page context ("MAIN" world).
 *
 * Web applications may create PDFs in the browser (Blob / data: URLs) and then open them in a new
 * tab, load them into a (hidden) iframe and call print(), or trigger a download via <a>.
 * These hooks hold such a use until the print server has decided:
 *   show     -> the original action is performed (slightly delayed)
 *   suppress -> the action is dropped; print() calls on the affected window/frame are ignored
 */
(() => {
  "use strict";
  const TAG = "__remotePdfPrinter";
  const MARK = Symbol.for(TAG);
  if (window[MARK]) return;
  Object.defineProperty(window, MARK, { value: true });

  let enabled = true;
  let debug = false;
  const DECISION_TIMEOUT_MS = 35000;

  function log(...args) {
    if (!debug) return;
    const text = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    console.debug("[Remote PDF Printer]", text);
    window.postMessage({ [TAG]: "log", text }, "*");
  }

  // --- bookkeeping ------------------------------------------------------------------------
  const tracked = new Map(); // blob: URL -> {blob, decision?: Promise}
  const suppressedUrls = new Set(); // URLs the background blocked (http iframes)
  const suppressedFrames = new WeakSet(); // iframes/embeds whose PDF was suppressed
  // iframes/embeds whose PDF is held back while the server decides. Without a src they show
  // about:blank; their "load" events and print() calls must not reach the page, otherwise it
  // prints an empty about:blank page.
  const heldFrames = new WeakSet();
  const waiting = new Map(); // request id -> resolve
  let seq = 0;

  const PDF_TYPES = /pdf/i;
  const MAYBE_PDF_TYPES = /^(|application\/octet-stream|binary\/octet-stream|application\/force-download|application\/download)$/i;
  const DATA_PDF = /^data:application\/(pdf|x-pdf|octet-stream)[;,]/i;

  function isCandidate(url) {
    if (!enabled || !url) return false;
    return tracked.has(url) || DATA_PDF.test(url);
  }

  function dataUrlToBlob(url) {
    const comma = url.indexOf(",");
    const meta = url.slice(5, comma);
    const payload = url.slice(comma + 1);
    let bytes;
    if (/;base64/i.test(meta)) {
      const bin = atob(decodeURIComponent(payload));
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
    return new Blob([bytes], { type: "application/pdf" });
  }

  /** Ask the server (via bridge + background) what to do with this URL. Cached per URL. */
  function decide(url, method, filename) {
    let entry = tracked.get(url);
    if (!entry) {
      entry = { blob: DATA_PDF.test(url) ? dataUrlToBlob(url) : null };
      tracked.set(url, entry);
    }
    if (entry.decision) return entry.decision;
    entry.used = true;
    entry.decision = new Promise((resolve) => {
      if (!entry.blob) return resolve({ browser: "show", reason: "PDF-Daten nicht verfügbar" });
      const id = ++seq;
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve({ browser: "show", reason: `keine Antwort der Erweiterung nach ${DECISION_TIMEOUT_MS / 1000} s` });
      }, DECISION_TIMEOUT_MS);
      waiting.set(id, (d) => {
        clearTimeout(timer);
        resolve(d);
      });
      log("Sende PDF", { method, filename, size: entry.blob.size });
      window.postMessage({ [TAG]: "req", id, blob: entry.blob, method, filename: filename || "" }, "*");
    });
    entry.decision.then((d) => log("Entscheidung", method, d.browser + (d.reason ? " – " + d.reason : "")));
    return entry.decision;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || typeof event.data !== "object") return;
    const d = event.data;
    switch (d[TAG]) {
      case "res": {
        const resolve = waiting.get(d.id);
        if (resolve) {
          waiting.delete(d.id);
          const dec = d.decision || {};
          resolve({ browser: dec.browser === "suppress" ? "suppress" : "show", reason: String(dec.reason || "") });
        }
        break;
      }
      case "config":
        enabled = !!d.enabled;
        debug = !!d.debug;
        break;
      case "suppressUrl":
        suppressedUrls.add(String(d.url));
        log("Frame-URL unterdrückt", d.url);
        break;
    }
  });

  // --- URL.createObjectURL / revokeObjectURL ----------------------------------------------
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;

  URL.createObjectURL = function createObjectURL(obj) {
    const url = origCreate.call(this, obj);
    try {
      if (enabled && obj instanceof Blob && (PDF_TYPES.test(obj.type) || MAYBE_PDF_TYPES.test(obj.type))) {
        const entry = { blob: obj };
        tracked.set(url, entry);
        if (PDF_TYPES.test(obj.type)) {
          log("PDF-Blob erzeugt", url, obj.size);
          // Helps finding new mechanisms of the web application: report blobs that none of our hooks saw.
          setTimeout(() => {
            if (!entry.used) log("PDF-Blob wurde nicht über einen bekannten Weg verwendet", url);
          }, 5000);
        }
      }
    } catch (err) {
      /* never break the page */
    }
    return url;
  };

  URL.revokeObjectURL = function revokeObjectURL(url) {
    const entry = tracked.get(url);
    if (entry && entry.decision) {
      // The page may revoke right after handing the URL to us; keep it alive until we used it.
      entry.decision.then(() => setTimeout(() => {
        tracked.delete(url);
        origRevoke.call(URL, url);
      }, 60000));
      return;
    }
    tracked.delete(url);
    return origRevoke.call(this, url);
  };

  // --- window.open ---------------------------------------------------------------------------
  const origOpen = window.open;

  function makeWindowStub(url, decision) {
    // Returned instead of a real window while the decision is pending.
    let real = null;
    let wantsPrint = false;
    const onload = [];
    const stub = {
      closed: false,
      opener: window,
      location: { href: url },
      document: { write() {}, writeln() {}, close() {}, open() {}, title: "" },
      print() {
        if (real) return real.print();
        wantsPrint = true;
      },
      focus() {
        if (real) real.focus();
      },
      blur() {},
      close() {
        stub.closed = true;
        if (real) real.close();
      },
      addEventListener(type, fn) {
        if (type === "load" && typeof fn === "function") onload.push(fn);
      },
      removeEventListener() {},
      postMessage() {},
      set onload(fn) {
        if (typeof fn === "function") onload.push(fn);
      },
      get onload() {
        return null;
      },
    };
    decision.then((d) => {
      if (d.browser !== "show" || stub.closed) return;
      real = stub.__open();
      if (!real) return;
      for (const fn of onload) real.addEventListener("load", fn);
      if (wantsPrint) real.addEventListener("load", () => real.print());
    });
    return stub;
  }

  window.open = function open(url, target, features) {
    const u = url == null ? "" : String(url);
    if (!isCandidate(u)) return origOpen.apply(this, arguments);
    log("window.open abgefangen", u);
    const args = arguments;
    const decision = decide(u, "window.open", "");
    const stub = makeWindowStub(u, decision);
    stub.__open = () => origOpen.apply(window, args);
    return stub;
  };

  // --- iframes / embeds / objects --------------------------------------------------------------
  function holdFrame(el, url, apply, method) {
    log(method + " abgefangen", url);
    heldFrames.add(el);
    decide(url, method, el.getAttribute("title") || "").then((d) => {
      if (d.browser === "show") {
        heldFrames.delete(el);
        apply(); // the PDF loads now; its load event reaches the page as usual
      } else {
        suppressedFrames.add(el);
        heldFrames.delete(el);
      }
    });
  }

  function isBlockedFrame(el) {
    return heldFrames.has(el) || suppressedFrames.has(el) || (suppressedUrls.size > 0 && suppressedUrls.has(el.src));
  }

  // "load" does not bubble, but it passes the capture phase of the document (not the window –
  // load events of elements stop at the document) before it reaches the iframe. Stop it there
  // for held/suppressed frames, e.g. the about:blank load when the iframe is inserted.
  document.addEventListener(
    "load",
    (event) => {
      const t = event.target;
      if ((t instanceof HTMLIFrameElement || t instanceof HTMLEmbedElement || t instanceof HTMLObjectElement) && isBlockedFrame(t)) {
        event.stopImmediatePropagation();
        log("load-Ereignis eines zurückgehaltenen Frames blockiert");
      }
    },
    true
  );

  function hookUrlProperty(proto, prop, method) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    Object.defineProperty(proto, prop, {
      ...desc,
      set(value) {
        const u = String(value);
        if (isCandidate(u)) return holdFrame(this, u, () => desc.set.call(this, value), method);
        return desc.set.call(this, value);
      },
    });
  }
  hookUrlProperty(HTMLIFrameElement.prototype, "src", "iframe.src");
  hookUrlProperty(HTMLEmbedElement.prototype, "src", "embed.src");
  hookUrlProperty(HTMLObjectElement.prototype, "data", "object.data");

  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function setAttribute(name, value) {
    const n = String(name).toLowerCase();
    if (
      ((n === "src" && (this instanceof HTMLIFrameElement || this instanceof HTMLEmbedElement)) ||
        (n === "data" && this instanceof HTMLObjectElement)) &&
      isCandidate(String(value))
    ) {
      const args = arguments;
      return holdFrame(this, String(value), () => origSetAttribute.apply(this, args), "setAttribute(" + n + ")");
    }
    return origSetAttribute.apply(this, arguments);
  };

  // print() on a suppressed frame must do nothing (it would print an empty page).
  const frameStub = {
    print() {
      log("print() auf zurückgehaltenem/unterdrücktem Frame ignoriert");
    },
    focus() {},
    blur() {},
    close() {},
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    document: { readyState: "complete" },
  };
  const cwDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
  if (cwDesc && cwDesc.get) {
    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
      ...cwDesc,
      get() {
        if (isBlockedFrame(this)) return frameStub;
        return cwDesc.get.call(this);
      },
    });
  }

  // --- links (<a href=blob:... download>) ------------------------------------------------------
  let bypass = false;
  const origClick = HTMLElement.prototype.click;
  const origDispatch = EventTarget.prototype.dispatchEvent;

  function anchorCandidate(el) {
    const a = el instanceof Element ? el.closest("a[href]") : null;
    return a && isCandidate(a.href) ? a : null;
  }

  function holdAnchor(a, replay, method) {
    const name = a.getAttribute("download") || "";
    log(method + " abgefangen", a.href, name);
    decide(a.href, method, name).then((d) => {
      if (d.browser !== "show") return;
      bypass = true;
      try {
        replay();
      } finally {
        bypass = false;
      }
    });
  }

  HTMLElement.prototype.click = function click() {
    const a = !bypass && anchorCandidate(this);
    if (a) return holdAnchor(a, () => origClick.call(this), "a.click");
    return origClick.apply(this, arguments);
  };

  EventTarget.prototype.dispatchEvent = function dispatchEvent(event) {
    if (!bypass && event && event.type === "click") {
      const a = anchorCandidate(this);
      if (a) {
        holdAnchor(a, () => origDispatch.call(this, new MouseEvent("click", { bubbles: true, cancelable: true })), "a.dispatchEvent");
        return false;
      }
    }
    return origDispatch.apply(this, arguments);
  };

  // Real user clicks on such links (the anchor is in the document).
  window.addEventListener(
    "click",
    (event) => {
      if (bypass || event.defaultPrevented) return;
      const a = anchorCandidate(event.target);
      if (!a) return;
      event.preventDefault();
      holdAnchor(a, () => origClick.call(a), "Linkklick");
    },
    true
  );
})();

/* Domains on which the extension is active. Shared by background script and options page.
 *
 * Accepted entries (one per line in the options):
 *   app.example.org          exactly this host
 *   *.example.org            example.org and all subdomains
 *   https://app.example.org/some/page   (pasted URL – only the host is used)
 */
"use strict";

const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/** Returns {host, wildcard, pattern} or throws an Error with a German message. */
function parseDomain(entry) {
  let s = String(entry).trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      throw new Error(`Ungültige Adresse: ${entry}`);
    }
  }
  s = s.replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (!HOST_RE.test(s)) throw new Error(`Ungültige Domain: ${entry}`);
  const wildcard = s.startsWith("*.");
  const host = wildcard ? s.slice(2) : s;
  if (!host.includes(".") && host !== "localhost") throw new Error(`Bitte vollständige Domain angeben: ${entry}`);
  return { host, wildcard, pattern: `*://${wildcard ? "*." : ""}${host}/*` };
}

/** Parses a list (array or newline/comma separated text); returns {domains, errors}. */
function parseDomainList(input) {
  const items = Array.isArray(input) ? input : String(input || "").split(/[\s,;]+/);
  const domains = [];
  const errors = [];
  for (const item of items) {
    if (!String(item).trim()) continue;
    try {
      const d = parseDomain(item);
      if (!domains.some((x) => x.pattern === d.pattern)) domains.push(d);
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { domains, errors };
}

/** True if the URL's host belongs to one of the parsed domains. */
function urlMatchesDomains(url, domains) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => host === d.host || (d.wildcard && host.endsWith("." + d.host)));
}

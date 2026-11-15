// Builds the Chrome version of the extension from the shared sources.
//
//   node build.mjs          -> dist/chrome/ (unpacked) and dist/remote-pdf-printer-chrome-<version>.zip
//
// The Firefox version is this folder itself (manifest.json); see package.json for web-ext commands.
// The Chrome manifest is derived from manifest.json so both stay in sync.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const root = dirname(fileURLToPath(import.meta.url));
const SHARED = ["background.js", "content", "options", "popup", "ui.css", "icons"];
const PNG_ICONS = { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" };

export function chromeManifest(firefox) {
  const m = structuredClone(firefox);
  delete m.browser_specific_settings;
  m.minimum_chrome_version = "111"; // content_scripts "world": "MAIN"
  m.background = { service_worker: "background.js" };
  // Not available in Chrome MV3: no blocking webRequest, no response filtering.
  m.permissions = m.permissions.filter((p) => !["webRequestBlocking", "webRequestFilterResponse"].includes(p));
  m.icons = PNG_ICONS;
  m.action = { ...m.action, default_icon: { 16: PNG_ICONS[16], 32: PNG_ICONS[32], 48: PNG_ICONS[48] } };
  return m;
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

// Minimal ZIP writer (deflate), enough for the Chrome Web Store upload.
function writeZip(srcDir, zipPath) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of listFiles(srcDir).sort()) {
    const name = Buffer.from(relative(srcDir, file).split("\\").join("/"));
    const data = readFileSync(file);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(0, 10); // time
    head.writeUInt16LE(0x21, 12); // date 1980-01-01
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, packed);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += head.length + name.length + packed.length;
  }
  const cenSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(zipPath, Buffer.concat([...local, ...central, end]));
}

export function buildChrome(outDir = join(root, "dist", "chrome")) {
  const firefox = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const entry of SHARED) cpSync(join(root, entry), join(outDir, entry), { recursive: true });
  rmSync(join(outDir, "icons", "icon.svg"), { force: true });
  const manifest = chromeManifest(firefox);
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const zip = join(dirname(outDir), `remote-pdf-printer-chrome-${manifest.version}.zip`);
  writeZip(outDir, zip);
  return { outDir, zip };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { outDir, zip } = buildChrome();
  console.log(`Chrome-Version gebaut:\n  entpackt: ${outDir}\n  ZIP:      ${zip}`);
}

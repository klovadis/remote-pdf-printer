# remote-pdf-printer

Firefox-Erweiterung und kleiner Python-Server, die PDFs aus **app.example.org** abfangen und je nach
Dokumenttyp automatisch **auf dem richtigen Drucker drucken** (z. B. A6-Rezepte auf dem Rezeptdrucker,
A4 auf dem A4-Drucker) und/oder **in Ordnern ablegen** (z. B. Rechnungen für ein Nachbearbeitungsprogramm).
Damit muss in Firefox kein Drucker mehr umgestellt werden.

```
Firefox (WebApp)                         Druckserver (Linux im LAN)
┌──────────────────────────┐  HTTPS +   ┌───────┐ HTTP  ┌────────────────────────────────────┐
│ Erweiterung fängt PDF ab │── Token ──▶│ Caddy │──────▶│ erkennt Typ (Format, Text, Name)   │
│ wartet auf Entscheidung  │◀── JSON ───│ (TLS) │◀──────│ legt ab: /srv/remote-pdf/<typ>/  │
│ show → wie bisher        │            └───────┘ :8080 │ druckt:  lp -d <Drucker> -o …      │
│ suppress → ausblenden    │                            └────────────────────────────────────┘
└──────────────────────────┘
```

Die Regeln liegen ausschließlich auf dem Server (`config.toml`). Pro Dokumenttyp ist festgelegt:

| Einstellung | Bedeutung |
|---|---|
| `folder` | Unterordner zum Ablegen (weglassen = nicht ablegen) |
| `[…print]` | Drucker, CUPS-Optionen, Kopien (weglassen = nicht drucken) |
| `browser` | `suppress`: Firefox zeigt/druckt das PDF nicht mehr selbst · `show`: Firefox verhält sich wie bisher |

Wenn Server, Ablage oder Drucker nicht funktionieren, zeigt Firefox das PDF **immer normal an**.
Es geht also kein Dokument verloren.

Die mitgelieferte Beispielkonfiguration enthält vier Dokumenttypen:

| Typ | Erkennung | Aktion | Firefox |
|---|---|---|---|
| Rezept | Seitenformat A6 | ablegen + Rezeptdrucker (`media=A6`) | ausblenden |
| Rechnung | Text „Rechnung“, „Rechnungsnummer“, „Liquidation“, „Quittung“ | ablegen in `rechnungen/` | ausblenden |
| Befund/Arztbrief | Text „Arztbrief“, „Befund“, … | ablegen | anzeigen |
| A4 (alles andere) | – | ablegen + A4-Drucker | ausblenden |

---

## 1. Server einrichten (Debian/Ubuntu/Raspberry Pi OS)

Voraussetzungen: Python ≥ 3.11, CUPS mit eingerichteten Druckern (`lpstat -p` zeigt die Namen) und
[Caddy](https://caddyserver.com) als Reverse Proxy. Der Druckserver selbst spricht nur HTTP auf
`127.0.0.1:8080`. HTTPS und Zertifikate übernimmt Caddy (siehe Abschnitt 2).

```bash
sudo apt install python3-venv cups-client caddy
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin remote-pdf
sudo git clone https://github.com/klovadis/remote-pdf-printer /opt/remote-pdf-printer
sudo python3 -m venv /opt/remote-pdf-printer/venv
sudo /opt/remote-pdf-printer/venv/bin/pip install /opt/remote-pdf-printer/server
```

Konfiguration:

```bash
sudo mkdir -p /etc/remote-pdf-printer /srv/remote-pdf
sudo cp /opt/remote-pdf-printer/server/config.example.toml /etc/remote-pdf-printer/config.toml
sudo chown -R remote-pdf: /etc/remote-pdf-printer /srv/remote-pdf
sudo chmod 600 /etc/remote-pdf-printer/config.toml
```

In `/etc/remote-pdf-printer/config.toml` anpassen:

- `api_token`: neues Geheimnis erzeugen mit `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`
- `allowed_clients`: Netz bzw. IP des Praxis-PCs. Hinter Caddy wird dafür die echte Adresse aus dem
  Header `X-Forwarded-For` genommen, aber nur, wenn die Anfrage von einem Proxy aus `trusted_proxies` kommt.
  Läuft Caddy auf demselben Rechner, passt der Standard (`127.0.0.1`).
- `host`/`port`: Standard ist `127.0.0.1:8080`, also nur lokal für Caddy erreichbar. Läuft Caddy auf einem
  anderen Rechner, `host` auf die LAN-Adresse setzen und Caddys Adresse bei `trusted_proxies` eintragen.
- Druckernamen (`printer = …`) und Optionen (verfügbare Optionen: `lpoptions -p DRUCKER -l`)

Prüfen und Regeln mit echten PDFs testen. Dabei wird nichts gedruckt oder abgelegt:

```bash
/opt/remote-pdf-printer/venv/bin/remote-pdf-printer -c /etc/remote-pdf-printer/config.toml check
```

```bash
/opt/remote-pdf-printer/venv/bin/remote-pdf-printer -c /etc/remote-pdf-printer/config.toml classify ~/Rezept.pdf ~/Rechnung.pdf
```

Als Dienst starten:

```bash
sudo cp /opt/remote-pdf-printer/deploy/remote-pdf-printer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now remote-pdf-printer
journalctl -u remote-pdf-printer -f
```

Liegt der Ablageordner woanders als `/srv/remote-pdf`, muss `ReadWritePaths=` in der Service-Datei
angepasst werden. Der Dienstbenutzer muss drucken dürfen. Bei Standard-CUPS ist das ohne Weiteres der Fall.

Die abgelegten Dateien heißen standardmäßig `2026-11-15_14-03-22_rechnung_<Originalname>.pdf`. Sie werden
zuerst als versteckte Datei geschrieben und dann umbenannt. Programme, die den Ordner überwachen,
sehen also nie halb geschriebene PDFs.

## 2. Caddy einrichten

Die Vorlage [`deploy/Caddyfile`](deploy/Caddyfile) nach `/etc/caddy/Caddyfile` kopieren oder per `import`
in eine bestehende Caddy-Konfiguration einbinden. Hostname bzw. IP-Adresse anpassen, unter der die
Erweiterung den Server aufrufen soll. Danach:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
```

```bash
sudo systemctl reload caddy
```

Für das Zertifikat gibt es zwei Varianten, beide sind in der Vorlage beschrieben:

- **A – Caddys interne CA (`tls internal`):** Das funktioniert ohne eigene Domain und ohne Internetzugang
  des Servers. Firefox muss Caddys Root-Zertifikat einmalig vertrauen (siehe Abschnitt 3). Caddy erneuert
  die Server-Zertifikate selbstständig.
- **B – Let's Encrypt für eine eigene Domain** (z. B. `druck.meine-praxis.de`, DNS-Eintrag zeigt auf die
  LAN-Adresse): Let's Encrypt kann einen Rechner im LAN nicht erreichen. Dafür braucht es die DNS-Challenge
  und einen Caddy-Build mit dem Plugin des DNS-Anbieters. In Firefox ist dann nichts zu importieren.

Die Vorlage lässt zusätzlich zum Token nur private Netze zu und begrenzt Uploads auf 50 MB.

## 3. Firefox vorbereiten

1. **Nur bei Variante A: Caddys Root-Zertifikat importieren.** Es liegt auf dem Server unter
   `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`. Diese Datei auf den Praxis-PC kopieren,
   dann *Einstellungen → Datenschutz & Sicherheit → Zertifikate anzeigen → Zertifizierungsstellen →
   Importieren* und *„Dieser CA vertrauen, um Websites zu identifizieren“* anhaken. **Nicht** die Datei
   `root.key` kopieren. Zum Prüfen `https://druckserver.local/api/health` in Firefox öffnen: Es darf keine
   Zertifikatswarnung erscheinen, die Antwort ist `{"error": "invalid token"}`.
2. Erweiterung installieren (siehe unten), in den Einstellungen der Erweiterung Server-Adresse
   (z. B. `https://druckserver.local`) und Token eintragen, **Speichern** und die angefragte Berechtigung
   erlauben. Unter dem Formular sollte dann „Verbunden mit Server …“ und die Liste der Kategorien stehen.

Über das Symbol in der Symbolleiste lässt sich die Erweiterung ein- und ausschalten. Dort sieht man
auch die zuletzt verarbeiteten Dokumente.

## 4. Erweiterung signieren und installieren

Normales Firefox installiert nur von Mozilla signierte Erweiterungen. Die Signierung als „unlisted“
ist kostenlos, und die Erweiterung erscheint dabei nicht öffentlich auf addons.mozilla.org.

1. Konto auf <https://addons.mozilla.org> anlegen, unter
   <https://addons.mozilla.org/developers/addon/api/key/> API-Zugangsdaten erzeugen.
2. Signieren (Node.js ≥ 18 nötig):
   ```bash
   cd extension
   ```
   ```bash
   npm install
   ```
   ```bash
   npm run lint
   ```
   ```bash
   npx web-ext sign --channel=unlisted --api-key=USER:… --api-secret=…
   ```
   Die signierte `.xpi` liegt danach in `extension/web-ext-artifacts/`.
3. In Firefox: *Add-ons verwalten → Zahnrad → Add-on aus Datei installieren…* und die `.xpi` wählen.

Für Updates `version` in `extension/manifest.json` erhöhen und erneut signieren.

**Zum Ausprobieren ohne Signatur:** `about:debugging#/runtime/this-firefox` → *Temporäres Add-on laden…*
→ `extension/manifest.json`. Die Erweiterung bleibt dann bis zum Neustart von Firefox aktiv.

## Wie die Erweiterung PDFs abfängt

Wie WebApp seine PDFs genau ausliefert, ist nicht dokumentiert. Die Erweiterung deckt deshalb mehrere Wege ab:

| Weg | Technik |
|---|---|
| PDF wird per HTTP von `*.example.de/.com/.net` geladen (neuer Tab, iframe, Download) | `webRequest.filterResponseData`: die Antwort wird gepuffert, bis der Server entschieden hat. Bei `suppress` wird der Tab geschlossen bzw. zurücknavigiert und ein Download abgebrochen. |
| PDF wird im Browser als Blob/`data:`-URL erzeugt und dann … | Hooks in der Seite (`content/main-world.js`): |
| … per `window.open()` geöffnet | Öffnen wird bis zur Entscheidung zurückgehalten |
| … in ein (verstecktes) iframe/embed/object geladen und gedruckt | `src` wird erst nach der Entscheidung gesetzt; `print()` auf unterdrückten Frames wird ignoriert |
| … über einen Link `<a download>` heruntergeladen | Klick wird erst nach der Entscheidung ausgeführt |
| PDF kommt von einer fremden Domain (z. B. Cloud-Speicher) | Option „Auch PDFs von anderen Domains“ in den Einstellungen; erfasst nur Anfragen, die von WebApp ausgehen |

Gleiche PDFs, die auf mehreren Wegen auftauchen, werden nur einmal gedruckt: Die Erweiterung erkennt
Duplikate innerhalb von 15 s, der Server innerhalb von 20 s.

### Wenn ein Dokument nicht abgefangen wird

1. In den Einstellungen der Erweiterung den **Debug-Modus** einschalten.
2. Die Browser-Konsole öffnen (Strg+Umschalt+J) und das Dokument in WebApp erneut öffnen bzw. drucken.
3. Die Meldungen mit `[PDF-Drucker]` zeigen, was erkannt wurde. Bei „PDF-Blob wurde nicht über einen
   bekannten Weg verwendet“ nutzt WebApp einen Weg, der noch nicht abgedeckt ist. Mit diesen
   Meldungen lässt sich die Erweiterung gezielt erweitern.

## Entwicklung

```bash
cd server && python3 -m venv .venv && .venv/bin/pip install -e '.[test]'
```

```bash
cd server && .venv/bin/pytest
```

Server lokal starten (ohne Caddy, nur zum Testen):

```bash
cd server && .venv/bin/remote-pdf-printer -c config.toml
```

API:

- `GET /api/health`: Status und Kategorien
- `POST /api/documents`: Body ist das PDF. Header: `Authorization: Bearer <token>`, optional
  `X-Filename` und `X-Source-Url` (URL-kodiert) sowie `X-Capture-Method`. Mit `?dry_run=1` wird nur
  klassifiziert. Die Antwort ist JSON mit `category`, `label`, `browser` (`show`/`suppress`), `stored`,
  `printed` und `errors`.

## Datenschutz

Die PDFs enthalten Patientendaten. Sie verlassen den Praxis-PC nur in Richtung des eingetragenen
eigenen Servers und werden dabei per TLS (Caddy) verschlüsselt und per Token authentifiziert. Der Server
protokolliert Dateiname, Format und Kategorie, aber keine Dokumentinhalte. Der Ablageordner sollte
entsprechend geschützt und gesichert werden.

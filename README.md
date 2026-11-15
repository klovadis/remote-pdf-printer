# remote-pdf-printer

Browser-Erweiterung (Firefox und Chrome) und kleiner Python-Server, die PDFs aus Web-Anwendungen
abfangen und je nach Dokumenttyp automatisch **auf dem richtigen Drucker drucken** (z. B. A6-Rezepte auf dem Rezeptdrucker,
A4 auf dem A4-Drucker) und/oder **in Ordnern ablegen** (z. B. Rechnungen für ein Nachbearbeitungsprogramm).
Damit muss im Browser kein Drucker mehr umgestellt werden.

Auf welchen Websites die Erweiterung aktiv ist, wird in ihren Einstellungen festgelegt (z. B.
`app.example.org` oder `*.example.org`). Auf allen anderen Seiten tut sie nichts.

```
Browser (Web-Anwendung)                    Druckserver (Linux im LAN)
┌──────────────────────────┐  HTTPS +   ┌───────┐ HTTP  ┌────────────────────────────────────┐
│ Erweiterung fängt PDF ab │── Token ──▶│ Caddy │──────▶│ erkennt Typ (Format, Text, Name)   │
│ wartet auf Entscheidung  │◀── JSON ───│ (TLS) │◀──────│ legt ab: /srv/remote-pdf/<typ>/  │
│ show → wie bisher        │            └───────┘ :8080 │ druckt:  lp -d <Drucker> -o …      │
│ suppress → ausblenden    │                            └────────────────────────────────────┘
└──────────────────────────┘
```

Der Server läuft unter **Linux** (Druck über CUPS) und unter **Windows** (Druck über SumatraPDF).

Die Regeln liegen ausschließlich auf dem Server (`config.toml`). Pro Dokumenttyp ist festgelegt:

| Einstellung | Bedeutung |
|---|---|
| `folder` | Unterordner zum Ablegen (weglassen = nicht ablegen) |
| `[…print]` | Drucker, Papierformat, Skalierung, Ausrichtung, Duplex, Kopien (weglassen = nicht drucken) |
| `browser` | `suppress`: der Browser zeigt/druckt das PDF nicht mehr selbst · `show`: der Browser verhält sich wie bisher |

Wenn Server, Ablage oder Drucker nicht funktionieren, zeigt der Browser das PDF **immer normal an**.
Es geht also kein Dokument verloren.

Die mitgelieferte Beispielkonfiguration enthält vier Dokumenttypen:

| Typ | Erkennung | Aktion | Browser |
|---|---|---|---|
| Rezept | Seitenformat A6 | ablegen + Rezeptdrucker (Papier A6) | ausblenden |
| Rechnung | Text „Rechnung“, „Rechnungsnummer“, „Liquidation“, „Quittung“ | ablegen in `rechnungen/` | ausblenden |
| Befund/Arztbrief | Text „Arztbrief“, „Befund“, … | ablegen | anzeigen |
| A4 (alles andere) | – | ablegen + A4-Drucker | ausblenden |

---

## 1. Server unter Linux einrichten (Debian/Ubuntu/Raspberry Pi OS)

Unter Windows: siehe [Abschnitt 1b](#1b-server-unter-windows-einrichten).

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
- Druckernamen (`printer = …`, Liste mit dem Befehl `printers`, siehe unten) und Druckeinstellungen
  (`paper`, `scaling`, `orientation`, `duplex`, `copies`). Diese Einstellungen gelten unter Linux und Windows
  gleich. Weitere CUPS-Optionen lassen sich mit `options = [...]` ergänzen. Welche ein Drucker kennt, zeigt
  `lpoptions -p DRUCKER -l`.

Drucker anzeigen, Konfiguration prüfen und Regeln mit echten PDFs testen. Dabei wird nichts gedruckt
oder abgelegt:

```bash
/opt/remote-pdf-printer/venv/bin/remote-pdf-printer -c /etc/remote-pdf-printer/config.toml printers
```

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

## 1b. Server unter Windows einrichten

Unter Windows druckt der Server mit [SumatraPDF](https://www.sumatrapdfreader.org), einem kleinen
kostenlosen PDF-Programm. Es kann PDFs ohne Dialog auf einem bestimmten Drucker mit vorgegebenem
Papierformat drucken.

1. **Python ≥ 3.11** von <https://www.python.org/downloads/windows/> installieren.
2. **SumatraPDF** installieren. Der Server findet es automatisch, wenn es an einem der üblichen Orte liegt
   (`%LOCALAPPDATA%\SumatraPDF`, `C:\Program Files\SumatraPDF`). Bei der portablen Version den Pfad in der
   `config.toml` bei `sumatra_path` eintragen.
3. Repository herunterladen (*Code → Download ZIP* auf GitHub, entpacken) und darin eine PowerShell öffnen.
4. Installieren. Das richtet eine Python-Umgebung unter `%LOCALAPPDATA%\remote-pdf-printer` ein, legt
   `C:\ProgramData\remote-pdf-printer\config.toml` mit zufälligem Token an und zeigt die installierten
   Drucker an:
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1
   ```
5. In `C:\ProgramData\remote-pdf-printer\config.toml` die Druckernamen genau so eintragen, wie sie
   angezeigt wurden. Der Ablageordner ist `C:\Remote-PDF`. Windows-Pfade in der Datei in **einfache**
   Anführungszeichen setzen, z. B. `dir = 'D:\Praxis\PDF'`.
6. Zum Testen im Vordergrund starten (Beenden mit Strg+C):
   ```powershell
   & "$env:LOCALAPPDATA\remote-pdf-printer\venv\Scripts\python.exe" -m remote_pdf_printer -c "$env:ProgramData\remote-pdf-printer\config.toml"
   ```
   Mit `check`, `printers` oder `classify Datei.pdf` am Ende des Befehls lassen sich Konfiguration, Drucker
   und Regeln prüfen.
7. Automatisch bei der Anmeldung starten, ohne Fenster. Das Protokoll steht dann in
   `C:\ProgramData\remote-pdf-printer\server.log`:
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\windows\register-task.ps1
   ```
   Entfernen mit demselben Befehl und `-Remove` am Ende. Meldet Windows „Zugriff verweigert“, die
   PowerShell einmal als Administrator starten.

**Browser auf demselben Windows-PC:** Dann ist Caddy nicht nötig. In der Erweiterung als Server-Adresse
`http://127.0.0.1:8080` eintragen. Die Daten verlassen den Rechner dabei nicht.

**Browser auf einem anderen PC:** Wie unter Linux Caddy davorschalten (gibt es auch für Windows, siehe
Abschnitt 2), sonst gehen die PDFs unverschlüsselt durchs Netz. Läuft Caddy auf einem anderen Rechner,
`host` auf die LAN-Adresse setzen und den Port in der Windows-Firewall freigeben.

**Wenn nicht gedruckt wird:** Der Server prüft vor jedem Druck, ob der eingetragene Drucker unter Windows
existiert, und nennt sonst die installierten Namen. Meldet SumatraPDF selbst einen Fehler, steht im Protokoll
der genaue Befehl. Diesen in der PowerShell ohne `-silent` ausführen, dann zeigt SumatraPDF den Grund an:

```powershell
& "C:\Pfad\zu\SumatraPDF.exe" -print-to "Druckername" -print-settings "fit,paper=A6" "C:\Remote-PDF\rezepte\datei.pdf"
```

Klappt es mit `-print-to-default` statt `-print-to "Druckername"`, stimmt der Druckername nicht. Klappt es
ohne `paper=A6`, unterstützt der Drucker dieses Papierformat nicht unter diesem Namen.

Unterschied zu Linux: Der Server läuft als der angemeldete Benutzer und nur, solange dieser angemeldet ist.
Dafür kann er alle Drucker dieses Benutzers verwenden, auch Netzwerkdrucker.

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
  des Servers. Der Browser muss Caddys Root-Zertifikat einmalig vertrauen (siehe Abschnitt 3). Caddy erneuert
  die Server-Zertifikate selbstständig.
- **B – Let's Encrypt für eine eigene Domain** (z. B. `druck.meine-praxis.de`, DNS-Eintrag zeigt auf die
  LAN-Adresse): Let's Encrypt kann einen Rechner im LAN nicht erreichen. Dafür braucht es die DNS-Challenge
  und einen Caddy-Build mit dem Plugin des DNS-Anbieters. Im Browser ist dann nichts zu importieren.

Die Vorlage lässt zusätzlich zum Token nur private Netze zu und begrenzt Uploads auf 50 MB.

## 3. Browser vorbereiten

1. **Nur bei Variante A: Caddys Root-Zertifikat importieren.** Es liegt auf dem Server unter
   `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`. Diese Datei auf den Praxis-PC kopieren.
   **Nicht** die Datei `root.key` kopieren.
   - **Firefox:** *Einstellungen → Datenschutz & Sicherheit → Zertifikate anzeigen → Zertifizierungsstellen →
     Importieren* und *„Dieser CA vertrauen, um Websites zu identifizieren“* anhaken.
   - **Chrome unter Windows:** Chrome nutzt den Zertifikatsspeicher von Windows. Doppelklick auf `root.crt` →
     *Zertifikat installieren* → Speicherort *„Vertrauenswürdige Stammzertifizierungsstellen“* wählen.
   - **Chrome unter Linux:** `chrome://certificate-manager` → eigene Zertifikate → *Importieren*, dann
     Vertrauen für Websites erteilen.

   Zum Prüfen `https://druckserver.local/api/health` im Browser öffnen: Es darf keine Zertifikatswarnung
   erscheinen, die Antwort ist `{"error": "invalid token"}`.
2. Erweiterung installieren (siehe unten) und ihre Einstellungen öffnen:
   - **Server-Adresse** (z. B. `https://druckserver.local`) und **Token** eintragen.
   - Unter **„Aktiv auf diesen Websites“** die Domains der Web-Anwendung eintragen, eine pro Zeile.
     `app.example.org` gilt genau für diese Adresse, `*.example.org` für `example.org` und alle Subdomains.
     Eine kopierte vollständige Adresse wie `https://app.example.org/start` wird auf die Domain gekürzt.
   - **Speichern** und die angefragten Berechtigungen erlauben. Die Erweiterung bekommt nur Zugriff auf die
     eingetragenen Websites und den Server. Bereits geöffnete Tabs der Web-Anwendung danach neu laden.

   Unter dem Formular sollte dann „Verbunden mit Server …“ und die Liste der Kategorien stehen.

Über das Symbol in der Symbolleiste lässt sich die Erweiterung ein- und ausschalten. Dort sieht man
auch die zuletzt verarbeiteten Dokumente.

## 4. Erweiterung installieren

### Firefox

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
   Die signierte `.xpi` liegt danach in `extension/dist/`.
3. In Firefox: *Add-ons verwalten → Zahnrad → Add-on aus Datei installieren…* und die `.xpi` wählen.

Für Updates `version` in `extension/manifest.json` erhöhen und erneut signieren.

**Zum Ausprobieren ohne Signatur:** `about:debugging#/runtime/this-firefox` → *Temporäres Add-on laden…*
→ `extension/manifest.json`. Die Erweiterung bleibt dann bis zum Neustart von Firefox aktiv.

### Chrome (und andere Chromium-Browser wie Edge)

- **Direkt installieren:** `chrome://extensions` öffnen, oben rechts den *Entwicklermodus* einschalten,
  *Entpackte Erweiterung laden* und den Ordner `extension` aus dem Repository wählen. Er funktioniert in
  Firefox und Chrome gleichermaßen. Anders als in Firefox bleibt die Erweiterung auch nach einem Neustart
  installiert. Den Ordner danach nicht löschen oder verschieben.
- **Über den Chrome Web Store:** Das geht ohne Entwicklermodus. Nötig ist ein Entwicklerkonto (einmalig
  5 US-Dollar). Das Paket dafür erzeugt (Node.js ≥ 22.2 nötig):
  ```bash
  cd extension
  ```
  ```bash
  npm run build:chrome
  ```
  Das ergibt `extension/dist/remote-pdf-printer-chrome-<version>.zip` und `extension/dist/chrome/`, ohne
  Firefox-spezifische Einträge. Die ZIP-Datei im Web Store hochladen und als Sichtbarkeit
  *„Nicht gelistet“* wählen. Google prüft die Erweiterung vor der Freigabe.

Das Manifest enthält für den Hintergrunddienst beide Angaben: `scripts` für Firefox und `service_worker`
für Chrome. Jeder Browser nutzt seine und ignoriert die andere. `npm run lint` meldet deshalb eine
harmlose Warnung zu `service_worker`.

**Was Chrome nicht kann:** Firefox kann PDFs abfangen, die eine Web-Anwendung direkt vom Server in einem
Tab oder Rahmen öffnet. Chrome bietet dafür keine Schnittstelle. Die Chrome-Version meldet solche Fälle nur im
Protokoll („PDF wird direkt im Tab geöffnet …“). Viele Web-Anwendungen erzeugen PDFs aber im Browser und
öffnen sie mit `window.open` oder drucken sie aus einem versteckten Rahmen. Das funktioniert in beiden
Browsern gleich.

## Wie die Erweiterung PDFs abfängt

Web-Anwendungen liefern PDFs auf unterschiedlichen Wegen aus. Die Erweiterung deckt deshalb mehrere ab:

| Weg | Technik | Firefox | Chrome |
|---|---|---|---|
| PDF wird im Browser als Blob/`data:`-URL erzeugt und dann … | Hooks in der Seite (`content/main-world.js`): | | |
| … per `window.open()` geöffnet | Öffnen wird bis zur Entscheidung zurückgehalten | ✓ | ✓ |
| … in ein (verstecktes) iframe/embed/object geladen und gedruckt | `src` wird erst nach der Entscheidung gesetzt; `print()` auf unterdrückten Frames wird ignoriert | ✓ | ✓ |
| … über einen Link `<a download>` heruntergeladen | Klick wird erst nach der Entscheidung ausgeführt | ✓ | ✓ |
| PDF wird per HTTP von einer eingetragenen Website heruntergeladen | Firefox: Antwort wird gepuffert. Chrome: Download wird angehalten, das PDF nachgeladen, danach fortgesetzt oder entfernt | ✓ | ✓ |
| PDF wird per HTTP direkt in einem Tab oder iframe geöffnet | Firefox: `webRequest.filterResponseData` puffert die Antwort, bis der Server entschieden hat. Bei `suppress` wird der Tab geschlossen bzw. zurücknavigiert | ✓ | nur Hinweis im Protokoll |
| PDF kommt von einer fremden Domain (z. B. Cloud-Speicher) | Option „Auch PDFs von anderen Domains“ in den Einstellungen; erfasst nur Anfragen, die von einer eingetragenen Website ausgehen | ✓ | nur Downloads |

Gleiche PDFs, die auf mehreren Wegen auftauchen, werden nur einmal gedruckt: Die Erweiterung erkennt
Duplikate innerhalb von 15 s, der Server innerhalb von 20 s.

### Wenn ein Dokument nicht abgefangen wird

1. In den Einstellungen der Erweiterung den **Debug-Modus** einschalten.
2. Die Konsole öffnen und das Dokument in der Web-Anwendung erneut öffnen bzw. drucken:
   - **Firefox:** Browser-Konsole (Strg+Umschalt+J). Sie zeigt alle Meldungen.
   - **Chrome:** Die Meldungen der Web-Anwendung stehen in den Entwicklertools der Seite (F12 → *Konsole*).
     Die Meldungen des Hintergrundskripts erscheinen unter `chrome://extensions` → *Remote PDF Printer* →
     *Service Worker*.
3. Die Meldungen mit `[PDF-Drucker]` zeigen, was erkannt wurde und warum entschieden wurde. Probleme wie
   „Server nicht erreichbar“ erscheinen dort immer, auch ohne Debug-Modus. Bei „PDF-Blob wurde nicht über einen
   bekannten Weg verwendet“ nutzt die Web-Anwendung einen Weg, der noch nicht abgedeckt ist. Mit diesen
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

Ende-zu-Ende-Test der Chrome-Version: Echtes Chromium mit geladener Erweiterung, eine nachgebaute
Web-Anwendung und der echte Server mit simuliertem Drucker. Geprüft wird auch, dass die Erweiterung auf
nicht eingetragenen Domains inaktiv bleibt. Voraussetzungen sind Playwright mit Chromium,
`openssl` und eine Python-Umgebung mit installiertem Server:

```bash
cd extension && PYTHON=../server/.venv/bin/python npm run test:chrome
```

API:

- `GET /api/health`: Status und Kategorien
- `POST /api/documents`: Body ist das PDF. Header: `Authorization: Bearer <token>`, optional
  `X-Filename` und `X-Source-Url` (URL-kodiert) sowie `X-Capture-Method`. Mit `?dry_run=1` wird nur
  klassifiziert. Die Antwort ist JSON mit `category`, `label`, `browser` (`show`/`suppress`), `stored`,
  `printed` und `errors`.

## Datenschutz

Die PDFs können vertrauliche Daten enthalten, z. B. Patientendaten. Sie verlassen den Praxis-PC nur in Richtung des eingetragenen
eigenen Servers und werden dabei per TLS (Caddy) verschlüsselt und per Token authentifiziert. Der Server
protokolliert Dateiname, Format und Kategorie, aber keine Dokumentinhalte. Der Ablageordner sollte
entsprechend geschützt und gesichert werden.

# Server-API

Diese Beschreibung richtet sich an alle, die einen eigenen Server für die Browser-Erweiterung
*Remote PDF Printer* schreiben möchten, z. B. in einer anderen Sprache oder mit anderer Drucklogik.
Die Erweiterung braucht nur die zwei Endpunkte unten. Was der Server mit dem PDF macht (drucken, ablegen,
weiterleiten), bleibt ganz ihm überlassen.

Die mitgelieferte Implementierung liegt in [`server/remote_pdf_printer/app.py`](../server/remote_pdf_printer/app.py).
Alle Angaben unten beschreiben, was die Erweiterung sendet und auswertet. Wo der mitgelieferte Server mehr
liefert, ist das als *optional* gekennzeichnet.

## Überblick

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/health` | Verbindungstest in den Einstellungen und im Popup |
| `POST` | `/api/documents` | Ein abgefangenes PDF übergeben und die Entscheidung erhalten |
| `OPTIONS` | beide Pfade | CORS-Vorabfrage des Browsers (siehe [CORS](#cors)) |

- **Basis-URL:** Die Server-Adresse aus den Einstellungen der Erweiterung, z. B. `http://192.168.1.20:8080`.
  Ein Pfad ist erlaubt (`http://host/drucken`), die Erweiterung hängt `/api/...` an und entfernt dabei
  abschließende Schrägstriche.
- **Protokoll:** HTTP oder HTTPS. Die Erweiterung akzeptiert beide Schemata. Bei HTTPS muss der Browser dem
  Zertifikat vertrauen.
- **Kodierung:** Antworten sind JSON in UTF-8 (`Content-Type: application/json`).
- **Cookies:** Die Erweiterung sendet keine (`credentials: "omit"`) und cacht nichts (`cache: "no-store"`).

## Authentifizierung

Jede Anfrage außer der CORS-Vorabfrage trägt das in der Erweiterung eingetragene Token:

```
Authorization: Bearer <token>
```

- Die Erweiterung verlangt mindestens 16 Zeichen. Das Token sollte ausschließlich aus URL-sicheren
  Zeichen bestehen.
- Bei falschem oder fehlendem Token antwortet der Server mit `401`. Die Erweiterung zeigt dann den Hinweis,
  dass das Token nicht passt.
- Der Server darf zusätzlich nach Absenderadresse filtern und mit `403` ablehnen. Der mitgelieferte Server
  tut das über `allowed_clients`.
- Token mit konstanter Laufzeit vergleichen, z. B. `hmac.compare_digest` in Python.

## `GET /api/health`

Prüft Erreichbarkeit und Token. Die Erweiterung ruft ihn bei „Verbindung testen“, nach dem Speichern der
Einstellungen und beim Öffnen des Popups auf. Zeitlimit: **8 Sekunden**.

**Anfrage**

```
GET /api/health HTTP/1.1
Authorization: Bearer <token>
```

**Antwort `200`**

```json
{
  "ok": true,
  "version": "0.2.0",
  "categories": [
    { "name": "rezept", "label": "Rezept (A6)", "browser": "suppress", "stores": true, "printer": "Rezeptdrucker" },
    { "name": "befund", "label": "Befund / Arztbrief", "browser": "show", "stores": true, "printer": null }
  ]
}
```

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `ok` | **ja** | Muss `true` sein, sonst gilt die Verbindung als fehlgeschlagen |
| `version` | nein | Wird in „Verbunden mit Server …“ angezeigt |
| `categories` | nein | Liste zur Anzeige in den Einstellungen. Pro Eintrag: `name`, `label` (Anzeigename), `browser` (`"show"`/`"suppress"`), `stores` (bool), `printer` (Name oder `null`). Alle Felder sind optional |

**Fehler:** Jeder Status außer 2xx gilt als Fehlschlag. Steht im JSON-Körper ein Feld `error`, zeigt die
Erweiterung dessen Text an, sonst `HTTP <Status>`.

## `POST /api/documents`

Übergibt ein PDF. Der Browser **wartet auf die Antwort**, bevor er das PDF anzeigt, herunterlädt oder
druckt. Der Server sollte deshalb zügig antworten, z. B. sobald der Druckauftrag in der Warteschlange
liegt. Zeitlimit der Erweiterung: **30 Sekunden**. Danach verhält sich der Browser wie ohne Erweiterung.

**Anfrage**

```
POST /api/documents HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/pdf
Content-Length: 18260
X-Filename: Rechnung%20M%C3%BCller.pdf
X-Source-Url: https%3A%2F%2Fapp.example.org%2Fpatient%2F42
X-Capture-Method: iframe.src

%PDF-1.7 … (rohe PDF-Bytes)
```

- **Körper:** Die PDF-Datei als rohe Bytes, kein Multipart, kein Base64. Die Erweiterung sendet nur Daten,
  die in den ersten 1024 Bytes die Kennung `%PDF-` enthalten (meist steht sie ganz am Anfang).
- **Header:** Die drei `X-`-Header sind mit `encodeURIComponent` kodiert (UTF-8, Prozent-Kodierung) und
  müssen vor der Verwendung dekodiert werden. Sie können leer sein.

| Header | Inhalt |
|---|---|
| `X-Filename` | Ursprünglicher Dateiname, soweit bekannt: aus `Content-Disposition`, dem `download`-Attribut eines Links oder der URL. Bei im Browser erzeugten PDFs, die per `window.open` geöffnet werden, meist leer. **Nicht vertrauenswürdig**, vor Verwendung als Dateiname bereinigen |
| `X-Source-Url` | Adresse der Seite bzw. des Downloads, aus der das PDF stammt |
| `X-Capture-Method` | Wie das PDF abgefangen wurde (siehe unten), nur zur Information und Protokollierung |

Werte von `X-Capture-Method`:

| Wert | Bedeutung |
|---|---|
| `window.open` | Im Browser erzeugtes PDF (Blob/`data:`-URL) sollte in neuem Fenster geöffnet werden |
| `iframe.src`, `embed.src`, `object.data`, `setAttribute(src)`, `setAttribute(data)` | Im Browser erzeugtes PDF sollte in einen (oft versteckten) Rahmen geladen werden, meist zum Drucken |
| `a.click`, `a.dispatchEvent`, `Linkklick` | Im Browser erzeugtes PDF sollte über einen Link heruntergeladen werden |
| `http:main_frame`, `http:sub_frame`, `http:object` | Nur Firefox: PDF wurde direkt vom Webserver in einem Tab bzw. Rahmen geladen |
| `download` | Nur Chrome: PDF-Download von einer eingetragenen Website |

**Antwort `200`**

```json
{
  "browser": "suppress",
  "category": "rechnung",
  "label": "Rechnung",
  "stored": "C:\\Remote-PDF\\rechnungen\\2026-11-15_22-02-07_rechnung_dokument.pdf",
  "printed": null,
  "errors": [],
  "duplicate": false
}
```

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `browser` | **ja** | `"suppress"`: Der Browser zeigt, lädt oder druckt das PDF **nicht** selbst. Jeder andere Wert und ein fehlendes Feld bedeuten `"show"`: Der Browser verhält sich wie ohne Erweiterung |
| `label` | nein | Anzeigename für Benachrichtigung und Popup. Ersatzweise `category`, sonst „Dokument“ |
| `category` | nein | Interner Name der Kategorie |
| `printed` | nein | Objekt mit `printer` (Name) bei erfolgreichem Druck, sonst `null`. Wird als „gedruckt auf …“ angezeigt |
| `stored` | nein | Beliebiger wahrer Wert (z. B. der Pfad) bedeutet „abgelegt“, sonst `null` |
| `errors` | nein | Liste von Fehlertexten. Ist sie nicht leer, zeigt die Erweiterung eine Fehlermeldung statt der Erfolgsmeldung |
| `duplicate` | nein | `true`, wenn dieses PDF eben schon verarbeitet wurde. Die Erweiterung zeigt dann keine zweite Benachrichtigung |

**Wichtig – nie ein Dokument verschlucken:** Konnte der Server nicht drucken oder nicht ablegen, sollte er
`"browser": "show"` zurückgeben, damit der Benutzer das PDF im Browser noch selbst drucken kann. Die
Erweiterung übernimmt `browser` unverändert, auch wenn `errors` gefüllt ist.

Der mitgelieferte Server liefert zusätzlich `rule` (Nummer der passenden Regel oder `null`), `pages`,
`paper` (z. B. `"A6"`), `sha256` und `dry_run`. Die Erweiterung wertet diese Felder nicht aus.

**Fehlerantworten:** Jeder Status außer 2xx führt zu „show“, also normalem Browserverhalten, und einer
Fehlermeldung mit dem Text aus `error`. Der mitgelieferte Server verwendet:

| Status | `error` | Anlass |
|---|---|---|
| `401` | `invalid token` | Token fehlt oder ist falsch |
| `403` | `client not allowed` | Absenderadresse nicht in `allowed_clients` |
| `404` | `not found` | Unbekannter Pfad |
| `411` | `Content-Length required` | Header fehlt |
| `413` | `body must be 1..N bytes` | Leer oder größer als `max_upload_mb` |
| `422` | Grund | Keine lesbare PDF-Datei |
| `500` | Grund | Unerwarteter Fehler |

Kann der Server gar nicht antworten oder überschreitet er das Zeitlimit, verhält sich der Browser ebenfalls
wie ohne Erweiterung.

### Optional: `?dry_run=1`

Der mitgelieferte Server klassifiziert dann nur und gibt die Entscheidung zurück, ohne zu drucken oder
abzulegen. Das ist praktisch zum Testen von Regeln, z. B. mit `curl`. Die Erweiterung nutzt diesen Parameter
nicht.

### Doppelte Übertragungen

Dasselbe PDF kann auf mehreren Wegen abgefangen werden. Die Erweiterung sendet identische Bytes innerhalb
von **15 Sekunden** nur einmal. Ein eigener Server sollte trotzdem selbst Duplikate erkennen, damit nicht
doppelt gedruckt wird. Dafür eignet sich ein SHA-256 der Bytes. Der mitgelieferte Server merkt sich die
Entscheidung **20 Sekunden** lang und liefert sie bei einem Duplikat mit `"duplicate": true` erneut, ohne
noch einmal zu drucken.

## CORS

Hat die Erweiterung (noch) keine Berechtigung für die Server-Adresse, behandelt Chrome ihre Anfragen wie
die einer Webseite. Das passiert z. B. bei „Verbindung testen“ vor dem Speichern. Wegen des
`Authorization`-Headers schickt Chrome dann vorab eine Vorabfrage:

```
OPTIONS /api/health HTTP/1.1
Origin: chrome-extension://<id>
Access-Control-Request-Method: GET
Access-Control-Request-Headers: authorization
Access-Control-Request-Private-Network: true      (nur bei Servern im lokalen Netz)
```

Antwort des mitgelieferten Servers (ohne Token-Prüfung, weil die Vorabfrage keins enthält):

```
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: chrome-extension://<id>
Vary: Origin
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type, X-Filename, X-Source-Url, X-Capture-Method
Access-Control-Max-Age: 600
Access-Control-Allow-Private-Network: true
```

Auch die eigentlichen Antworten auf `GET` und `POST` müssen dann `Access-Control-Allow-Origin` mit dem
`Origin` der Anfrage enthalten. Der mitgelieferte Server erlaubt nur Ursprünge, die mit `chrome-extension://`,
`moz-extension://` oder `safari-web-extension://` beginnen, und beantwortet Vorabfragen von Webseiten mit `403`.
Hat die Erweiterung die Berechtigung erteilt bekommen, sendet der Browser keine Vorabfrage. CORS-Unterstützung
ist trotzdem empfehlenswert.

## Ausprobieren mit curl

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/health
```

```bash
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/pdf" -H "X-Filename: test.pdf" --data-binary @test.pdf "http://127.0.0.1:8080/api/documents?dry_run=1"
```

## Minimaler eigener Server (Python, nur Standardbibliothek)

Dieses Beispiel speichert jedes PDF in einem Ordner und lässt den Browser es danach normal anzeigen. Es zeigt
das vollständige Protokoll einschließlich CORS. Drucklogik, Duplikaterkennung, Größenlimit und
Adressfilter fehlen.

```python
import hmac, json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

TOKEN = "mindestens-16-zeichen-langes-geheimnis"
OUT = Path("eingang"); OUT.mkdir(exist_ok=True)
EXT_ORIGINS = ("chrome-extension://", "moz-extension://", "safari-web-extension://")


class Handler(BaseHTTPRequestHandler):
    def cors(self):
        origin = self.headers.get("Origin", "")
        if origin.startswith(EXT_ORIGINS):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def reply(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        auth = self.headers.get("Authorization", "")
        if hmac.compare_digest(auth.encode(), f"Bearer {TOKEN}".encode()):
            return True
        self.reply(401, {"error": "invalid token"})
        return False

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Authorization, Content-Type, X-Filename, X-Source-Url, X-Capture-Method")
        if self.headers.get("Access-Control-Request-Private-Network") == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if urlsplit(self.path).path != "/api/health":
            return self.reply(404, {"error": "not found"})
        if self.authorized():
            self.reply(200, {"ok": True, "version": "beispiel"})

    def do_POST(self):
        if urlsplit(self.path).path != "/api/documents":
            return self.reply(404, {"error": "not found"})
        if not self.authorized():
            return
        data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if b"%PDF-" not in data[:1024]:
            return self.reply(422, {"error": "kein PDF"})
        name = Path(unquote(self.headers.get("X-Filename", ""))).name or "dokument.pdf"
        target = OUT / f"{time.strftime('%Y%m%d-%H%M%S')}_{name}"
        target.write_bytes(data)
        self.reply(200, {"browser": "show", "label": "Eingang", "stored": str(target), "printed": None, "errors": []})


ThreadingHTTPServer(("127.0.0.1", 8080), Handler).serve_forever()
```

Soll der Browser das PDF nicht mehr selbst anzeigen oder drucken, `"browser": "suppress"` zurückgeben,
aber nur, wenn der Server das Dokument wirklich verarbeitet hat.

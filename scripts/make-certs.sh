#!/bin/sh
# Erzeugt eine eigene kleine Zertifizierungsstelle (CA) und ein Server-Zertifikat.
#
#   scripts/make-certs.sh ZIELORDNER IP-ODER-HOSTNAME [weitere ...]
#   z.B. scripts/make-certs.sh /etc/remote-pdf-printer/tls 192.168.1.20 druckserver.local
#
# Danach:
#   - server.crt / server.key in der config.toml eintragen
#   - ca.crt in Firefox importieren: Einstellungen > Datenschutz & Sicherheit > Zertifikate anzeigen
#     > Zertifizierungsstellen > Importieren > "Dieser CA vertrauen, um Websites zu identifizieren"
# Die CA wird nur einmal erzeugt; bei erneutem Aufruf wird nur das Server-Zertifikat erneuert.
set -eu

if [ $# -lt 2 ]; then
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
fi

dir=$1
shift
mkdir -p "$dir"
cd "$dir"
umask 077

san=""
for name in "$@"; do
    case $name in
        *[!0-9.]*) entry="DNS:$name" ;;
        *) entry="IP:$name" ;;
    esac
    case $name in *:*) entry="IP:$name" ;; esac  # IPv6
    san="${san:+$san,}$entry"
done

if [ ! -f ca.key ]; then
    openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes \
        -keyout ca.key -out ca.crt -subj "/CN=WebApp PDF Printer lokale CA" \
        -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
        -addext "keyUsage=critical,keyCertSign,cRLSign"
    echo "Neue CA erzeugt: $dir/ca.crt"
fi

openssl req -newkey rsa:2048 -sha256 -nodes -keyout server.key -out server.csr -subj "/CN=$1"
cat > server.ext <<EOF
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$san
EOF
# 825 Tage: Höchstlaufzeit, die Browser für Server-Zertifikate akzeptieren
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -days 825 -sha256 -extfile server.ext -out server.crt
rm -f server.csr server.ext
chmod 644 ca.crt server.crt
chmod 600 ca.key server.key

echo
echo "Server-Zertifikat für $san erzeugt:"
echo "  $dir/server.crt, $dir/server.key  -> in config.toml eintragen"
echo "  $dir/ca.crt                       -> in Firefox als Zertifizierungsstelle importieren"
echo "  $dir/ca.key                       -> geheim halten (nur zum Erneuern nötig)"

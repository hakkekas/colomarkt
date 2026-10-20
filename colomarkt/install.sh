#!/usr/bin/env bash
# Installeert Colomarkt+ op een Ubuntu- of Debian-server.
# Gebruik:  sudo ./install.sh app.jouwschool.be
set -euo pipefail
DOMEIN="${1:-}"
DOEL=/opt/colomarkt
[ "$(id -u)" = 0 ] || { echo "Start dit script met sudo."; exit 1; }
[ -n "$DOMEIN" ] || { echo "Geef het webadres mee, bv.: sudo ./install.sh colomarkt.jouwschool.be"; exit 1; }
BRON="$(cd "$(dirname "$0")" && pwd)"

echo "1/5 Node.js controleren"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

command -v unzip >/dev/null || apt-get install -y unzip

echo "2/5 Bestanden naar $DOEL kopiëren"
id colomarkt >/dev/null 2>&1 || useradd --system --home "$DOEL" --shell /usr/sbin/nologin colomarkt
mkdir -p "$DOEL" /var/lib/colomarkt
if [ "$BRON" != "$DOEL" ]; then cp -r "$BRON"/. "$DOEL"/; fi
chown -R colomarkt:colomarkt /var/lib/colomarkt
chmod +x "$DOEL"/install.sh "$DOEL"/update.sh

echo "3/5 Instellingen"
if [ ! -f /etc/colomarkt.env ]; then
  CODE="$(tr -dc 'a-z0-9' </dev/urandom | head -c 10 || true)"
  SLEUTEL="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40 || true)"
  sed -e "s/^TOEGANGSCODE=.*/TOEGANGSCODE=$CODE/" -e "s/^SERVER_SLEUTEL=.*/SERVER_SLEUTEL=$SLEUTEL/" "$DOEL/config.voorbeeld.env" > /etc/colomarkt.env
  chmod 600 /etc/colomarkt.env
  echo "   Toegangscode voor de toestellen: $CODE  (aan te passen in /etc/colomarkt.env)"
fi

echo "4/5 Dienst starten"
cat > /etc/systemd/system/colomarkt.service <<UNIT
[Unit]
Description=Colomarkt+
After=network.target

[Service]
User=colomarkt
Environment=COLOMARKT_CONFIG=/etc/colomarkt.env
EnvironmentFile=/etc/colomarkt.env
WorkingDirectory=$DOEL
ExecStart=/usr/bin/env node $DOEL/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now colomarkt
systemctl restart colomarkt

echo "5/5 HTTPS met Caddy voor $DOMEIN"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi
POORT="$(grep -E '^POORT=' /etc/colomarkt.env | cut -d= -f2)"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMEIN {
  encode gzip
  reverse_proxy 127.0.0.1:${POORT:-3000}
}
CADDY
systemctl reload caddy || systemctl restart caddy

sleep 2
if curl -fsS "http://127.0.0.1:${POORT:-3000}/gezond" >/dev/null; then
  echo "Klaar. Open https://$DOMEIN op een toestel en geef de toegangscode in."
else
  echo "De dienst start niet. Bekijk de fout met: journalctl -u colomarkt -n 50"; exit 1
fi

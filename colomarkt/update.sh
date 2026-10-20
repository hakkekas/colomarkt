#!/usr/bin/env bash
# Zet een nieuwe versie van Colomarkt+ op de server. De gegevens blijven staan.
# Gebruik:  sudo ./update.sh                 (haalt de nieuwste versie van GitHub, als de map een git-checkout is)
#           sudo ./update.sh nieuwe-versie.zip
set -euo pipefail
DOEL=/opt/colomarkt
[ "$(id -u)" = 0 ] || { echo "Start dit script met sudo."; exit 1; }

DATA="$(grep -E '^DATA_MAP=' /etc/colomarkt.env | cut -d= -f2)"; DATA="${DATA:-/var/lib/colomarkt}"
STEMPEL="$(date +%Y-%m-%d_%H%M)"
mkdir -p "$DATA/backups"
cp "$DATA/state.json" "$DATA/backups/voor-update-$STEMPEL.json" 2>/dev/null || true
echo "Back-up van de gegevens: $DATA/backups/voor-update-$STEMPEL.json"

if [ -n "${1:-}" ]; then
  TMP="$(mktemp -d)"
  unzip -q "$1" -d "$TMP"
  SRC="$TMP"; [ -f "$TMP/server.js" ] || SRC="$(dirname "$(find "$TMP" -name server.js -not -path '*/node_modules/*' | head -1)")"
  cp -r "$SRC"/. "$DOEL"/
  rm -rf "$TMP"
elif [ -d "$DOEL/.git" ]; then
  git -C "$DOEL" pull --ff-only
else
  echo "Geef een zip mee, bv.: sudo ./update.sh colomarkt-server.zip"; exit 1
fi

systemctl restart colomarkt
sleep 2
POORT="$(grep -E '^POORT=' /etc/colomarkt.env | cut -d= -f2)"
if curl -fsS "http://127.0.0.1:${POORT:-3000}/gezond" >/dev/null; then echo "Bijgewerkt en opnieuw gestart."
else echo "Opgelet: de dienst start niet. Bekijk: journalctl -u colomarkt -n 50"; exit 1; fi

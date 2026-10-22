# Colomarkt+: overdracht aan IT

Colomarkt+ is de bestel- en voorraadapp van de keukens, de bakkerij, de zaal en het economaat van het Huis van de Gastronomie. Dit pakket zet de app op een eigen server, zodat alle toestellen dezelfde gegevens delen.
Contactpersoon: Stefan (praktijkleerkracht).

## In het kort
- **Wat het is:** één Node.js-proces zonder npm-afhankelijkheden (`server.js`). Caddy staat ervoor als reverse proxy en regelt https.
- **Gegevens:** één JSON-bestand in `/var/lib/colomarkt/state.json`. De app maakt zelf elke dag een kopie in `/var/lib/colomarkt/backups/` en houdt die 30 dagen bij.
- **Toegang:** wie de app wil openen, moet eerst één toegangscode ingeven (`TOEGANGSCODE`). Daarna krijgt dat toestel een HttpOnly-cookie die 400 dagen geldig blijft. Binnen de app meldt elke gebruiker zich nog eens aan met een eigen pincode. De systeembeheerder meldt zich aan met `BEHEER_WACHTWOORD`. Dat wordt op de server gecontroleerd en geeft een sessiecookie van 12 uur (HttpOnly, SameSite=Strict, alleen voor `/api/beheer/`).
- **Uitgaand verkeer, enkel naar `api.anthropic.com`:** dat is nodig voor twee optionele dingen: foto's laten lezen door Claude en de Claude-taken starten.

## Vereisten
- Ubuntu 22.04 of 24.04, of Debian 12, met sudo-rechten.
- Een DNS-naam die naar de server wijst. DDNS kan ook.
- Poorten 80 en 443 die van buitenaf bereikbaar zijn, voor Let's Encrypt en de gebruikers.
- Ongeveer 200 MB schijfruimte voor de app, plus de gegevens en de back-ups.

## Installatie
```bash
unzip colomarkt-server.zip -d colomarkt && cd colomarkt
sudo ./install.sh colomarkt.jullieschool.be
```
Het script doet het volgende:
1. Het installeert Node.js 22 (via NodeSource) als die er nog niet is.
2. Het kopieert de bestanden naar `/opt/colomarkt` en maakt een systeemgebruiker `colomarkt` aan.
3. Het maakt `/etc/colomarkt.env` aan (chmod 600) met een willekeurige `TOEGANGSCODE`, `SERVER_SLEUTEL` en `BEHEER_WACHTWOORD`.
4. Het maakt de systemd-dienst `colomarkt` aan, die luistert op 127.0.0.1:3000.
5. Het installeert Caddy en schrijft `/etc/caddy/Caddyfile` voor het domein.

Draait er op de server al een webserver of reverse proxy? Sla stap 5 dan over en stuur het domein door naar `127.0.0.1:3000`. Geef daarbij `X-Forwarded-Proto` mee, zodat de cookie als Secure gemarkeerd wordt.

## Na de installatie, graag doorgeven aan Stefan
- het webadres;
- de `TOEGANGSCODE`, voor de toestellen;
- het `BEHEER_WACHTWOORD`, voor de systeembeheerder in de app;
- de `SERVER_SLEUTEL`. Via die sleutel sturen de Claude-taken van Stefan nieuwe prijzen en de bestelstatus naar de server (endpoints `/api/taak/*`, Bearer-token).

Stefan bezorgt op zijn beurt drie routine-tokens. Die komen in `/etc/colomarkt.env` (`ROUTINE_TOKEN_*`). Doe daarna `sudo systemctl restart colomarkt`. Een eventuele `ANTHROPIC_API_KEY` voor het lezen van foto's komt ook in dat bestand.

## Updates
```bash
sudo /opt/colomarkt/update.sh colomarkt-server-nieuw.zip
```
Het script maakt eerst een kopie van de gegevens, vervangt dan de code en herstart de dienst. Ontbreekt `BEHEER_WACHTWOORD`, dan maakt het script er een aan en toont het. De gegevens in `/var/lib/colomarkt` blijven staan. De gebruikers merken enkel een onderbreking van een paar seconden.

## Beheer
- Beheersmodule in de app (rol Systeembeheerder): gebruikers, toegangscode, toestellen intrekken, back-ups op de server, systeeminfo. Endpoints `/api/beheer/*`. Elke actie komt in `/var/lib/colomarkt/beheer-log.json`.
- In de app gewijzigde toegangscode of beheerwachtwoord: `/var/lib/colomarkt/instellingen.json` (gaat voor op `/etc/colomarkt.env`).
- Status: `systemctl status colomarkt`
- Logs: `journalctl -u colomarkt -n 100`
- Gezondheidscheck: `curl http://127.0.0.1:3000/gezond`
- Back-up: neem `/var/lib/colomarkt` mee in de gewone back-up van de server.
- Alle toestellen afmelden: wijzig `TOEGANGSCODE` en herstart de dienst.

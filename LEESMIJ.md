# Colomarkt+ op de cloudserver

Met dit pakket draait Colomarkt+ op een eigen webadres. Alle toestellen delen dan dezelfde gegevens: een bestelling die een chef op de gsm ingeeft, ziet het magazijn binnen enkele seconden op de pc.

## Wat erin zit

- `app/`: de huidige versie van Colomarkt+ met alle functies en catalogi, en het Coloma-icoon voor op de gsm.
- `server.js`: een kleine server die de app toont en de gegevens centraal bewaart. Hij heeft enkel Node.js nodig, geen extra pakketten.
- `install.sh` en `update.sh`: installeren en bijwerken met één commando.

## Wat de server nodig heeft

- Ubuntu 22.04 of 24.04, of Debian 12, met beheerdersrechten (sudo).
- Een webadres dat naar de server wijst, bijvoorbeeld `colomarkt.jouwschool.be`. Een DDNS-naam werkt ook.
- Poort 80 en 443 open naar het internet. Caddy haalt daarmee zelf een gratis https-certificaat op.

## Installeren

1. Kopieer `colomarkt-server.zip` naar de server en pak het uit: `unzip colomarkt-server.zip -d colomarkt && cd colomarkt`
2. Start het installatiescript met het webadres: `sudo ./install.sh colomarkt.jouwschool.be`
3. Het script toont op het einde de **toegangscode**. Elk toestel vraagt die één keer. Je kan de code aanpassen in `/etc/colomarkt.env`, waarna je `sudo systemctl restart colomarkt` doet.

## De huidige gegevens overzetten

De gegevens staan nu in de browser van het toestel waarop je de app gebruikt.

1. Open de huidige app op het toestel met de meest volledige gegevens (meestal de pc van het magazijn).
2. Ga naar **Cijfers & back-up** en klik op **Back-up downloaden**.
3. Open de nieuwe app op het nieuwe adres, ga naar dezelfde plaats en kies **Back-up terugzetten**.

Alle andere toestellen zien die gegevens daarna meteen.

## Bijwerken

Een nieuwe versie zet je zo op de server: `sudo /opt/colomarkt/update.sh colomarkt-server-nieuw.zip`

De gegevens blijven staan. Voor elke update wordt er een extra back-up gemaakt. Staat de code later op GitHub, dan volstaat `sudo /opt/colomarkt/update.sh`.

## Systeembeheerder en beheersmodule

Op het aanmeldscherm staat onder **Beheer** de gebruiker **Systeembeheerder**. Die meldt zich niet aan met een pincode, maar met het **beheerwachtwoord** van de server. Het installatiescript of het updatescript maakt dat wachtwoord aan en toont het één keer. Het staat ook in `/etc/colomarkt.env` bij `BEHEER_WACHTWOORD`.

In de beheersmodule kan de systeembeheerder:

- **Gebruikers** aanmaken, hernoemen, een andere rol geven, hun pincode wissen en ze verwijderen. Dat geldt voor chefs, bakkers, zaal, magazijn, kelder, TA en andere beheerders.
- **Toegang & toestellen**: de toegangscode wijzigen, zien welke toestellen toegang hebben, ze een naam geven, de toegang van één toestel intrekken of alle andere toestellen afmelden. Het beheerwachtwoord wijzig je hier ook.
- **Back-ups**: zelf een back-up downloaden of terugzetten, de back-ups op de server bekijken, downloaden of terugzetten, en meteen een extra back-up maken.
- **Systeem**: de toestand van de server bekijken (versie, back-ups, AI en Claude-taken) en het logboek van alle beheeracties.

Een toegangscode of beheerwachtwoord dat in de app gewijzigd is, staat in `/var/lib/colomarkt/instellingen.json` en gaat voor op `/etc/colomarkt.env`. Ben je het beheerwachtwoord kwijt? Verwijder dan `beheerHash` uit dat bestand (of het hele bestand, maar dan geldt ook weer de toegangscode uit `/etc/colomarkt.env`), zet een nieuw `BEHEER_WACHTWOORD` in `/etc/colomarkt.env` en doe `sudo systemctl restart colomarkt`.

## Back-ups

- De server bewaart de laatste 30 dagen elke dag een kopie in `/var/lib/colomarkt/backups/`.
- Neem die map ook mee in de gewone back-up van de server.

## Foto's laten lezen door Claude (Claude API)

Met de Claude API kan de app leverbonnen, facturen en recepten van een foto lezen.

1. Maak op **console.anthropic.com** een account voor de school aan en zet er krediet op (Billing). Je betaalt per gebruik. Omdat de productlijst mee wordt gestuurd, schat ik één leverbon of recept op 5 tot 20 eurocent.
2. Ga naar **API Keys** › **Create Key**, noem de sleutel `Colomarkt server` en kopieer hem. Hij begint met `sk-ant-` en je ziet hem maar één keer.
3. Open op de server het instellingenbestand: `sudo nano /etc/colomarkt.env`
4. Plak de sleutel achter `ANTHROPIC_API_KEY=`, zonder spaties of aanhalingstekens. Bewaar met Ctrl+O en Enter, en sluit af met Ctrl+X.
5. Herstart de app: `sudo systemctl restart colomarkt`

Herlaad daarna de app. Bij Levering verwerken staan nu de knoppen **Foto van de leverbon/factuur**, en bij een nieuw recept staat **Snel invullen met Claude**. Zonder sleutel blijven die knoppen weg en werkt de rest gewoon.

De app gebruikt standaard `claude-opus-5-5` voor foto's en recepten. Je kan dat aanpassen met `AI_MODEL` in hetzelfde bestand. Weigert het model een document onterecht, dan probeert de API het automatisch met een ander model.

## Webshop en prijzen

Drie knoppen in de app starten een Claude-taak op Stefans claude.ai-account: **In winkelwagen zetten**, **Controleer bestelstatus** en **Prijzen nu bijwerken**. De server kan die taken rechtstreeks starten.

1. Open op claude.ai/code/routines elk van de drie taken en kies **Bewerken**. Voeg bij **Add another trigger** een **API**-trigger toe en klik **Generate token**.
2. Zet de drie tokens in `/etc/colomarkt.env` bij `ROUTINE_TOKEN_WEBSHOP`, `ROUTINE_TOKEN_BESTELSTATUS` en `ROUTINE_TOKEN_PRIJZEN`. Doe daarna `sudo systemctl restart colomarkt`.
3. Geef Claude het serveradres en de `SERVER_SLEUTEL` uit `/etc/colomarkt.env`. Claude past dan de taken aan, zodat ze nieuwe catalogi en prijzen en de bestelstatus naar de server sturen (zie `routines/server-koppeling.md`).

Zonder tokens staan die knoppen uit en werkt de rest gewoon.

## Wat alleen in de claude.ai-versie werkt

Bestelbonnen per Gmail klaarzetten loopt via de Gmail-koppeling van claude.ai. Op de server is die knop verborgen: download de bestelbon als PDF en mail hem zelf.

## Problemen

- Draait de dienst? `systemctl status colomarkt`
- De laatste meldingen: `journalctl -u colomarkt -n 50`
- Gezondheidscheck: `curl http://127.0.0.1:3000/gezond`

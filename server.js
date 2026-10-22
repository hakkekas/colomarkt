// Colomarkt+ server: serveert de app en bewaart de gegevens centraal, zodat elk toestel hetzelfde ziet.
// Geen extra pakketten nodig: enkel Node.js 18 of nieuwer.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const {verschil, toepassen} = require('./lib/merge');

// ---------- Instellingen ----------
function leesEnv(bestand){
  try{
    for(const regel of fs.readFileSync(bestand, 'utf8').split(/\r?\n/)){
      const m = regel.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if(m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }catch(e){}
}
leesEnv(process.env.COLOMARKT_CONFIG || path.join(__dirname, 'config.env'));

const POORT = parseInt(process.env.POORT || '3000', 10);
const ADRES = process.env.ADRES || '127.0.0.1';
const TOEGANGSCODE = process.env.TOEGANGSCODE || '';
const DATA_MAP = path.resolve(process.env.DATA_MAP || path.join(__dirname, 'data'));
const APP_MAP = path.resolve(process.env.APP_MAP || path.join(__dirname, 'app'));
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const AI_MODEL_SNEL = process.env.AI_MODEL_SNEL || 'claude-haiku-5-5';
const BACKUP_DAGEN = parseInt(process.env.BACKUP_DAGEN || '30', 10);
const LOKALE_SLEUTELS = ['currentUser']; // per toestel, nooit gedeeld

// Claude-taken (routines) die de app start: webshop vullen, bestelstatus controleren, prijzen bijwerken.
// Per taak het id en de API-token uit claude.ai/code/routines.
const ROUTINES = {
  webshop:{id:process.env.ROUTINE_ID_WEBSHOP || 'trig_01VBkHNZhm7jv9CLHdxojHKx', token:process.env.ROUTINE_TOKEN_WEBSHOP || ''},
  bestelstatus:{id:process.env.ROUTINE_ID_BESTELSTATUS || 'trig_013xCvBcBHDdP97KMBdnFvaq', token:process.env.ROUTINE_TOKEN_BESTELSTATUS || ''},
  prijzen:{id:process.env.ROUTINE_ID_PRIJZEN || 'trig_01SQVeG4jukER7d2tZSdxGe6', token:process.env.ROUTINE_TOKEN_PRIJZEN || ''}
};
// Sleutel waarmee die taken resultaten (catalogi, bestelstatus) naar deze server terugsturen.
const SERVER_SLEUTEL = process.env.SERVER_SLEUTEL || '';
// Wachtwoord van de systeembeheerder (beheersmodule in de app). Kan daarna in de app gewijzigd worden.
const BEHEER_WACHTWOORD = process.env.BEHEER_WACHTWOORD || '';
const START_TIJD = Date.now();

// Instellingen die de systeembeheerder in de app wijzigt. Ze gaan voor op /etc/colomarkt.env.
const INSTELLINGEN_BESTAND = path.join(DATA_MAP, 'instellingen.json');
let instellingen = {};
try{ instellingen = JSON.parse(fs.readFileSync(INSTELLINGEN_BESTAND, 'utf8')); }catch(e){}

if(!TOEGANGSCODE && !instellingen.toegangscodeHash){
  console.error('Stel eerst een TOEGANGSCODE in (zie config.voorbeeld.env).');
  process.exit(1);
}
fs.mkdirSync(path.join(DATA_MAP, 'backups'), {recursive:true});
fs.mkdirSync(path.join(DATA_MAP, 'catalogus'), {recursive:true});
const BONSTATUS_BESTAND = path.join(DATA_MAP, 'bonstatus.json');
let bonstatus = {};
try{ bonstatus = JSON.parse(fs.readFileSync(BONSTATUS_BESTAND, 'utf8')); }catch(e){}

// ---------- Gegevens ----------
const STATE_BESTAND = path.join(DATA_MAP, 'state.json');
const TOEGANG_BESTAND = path.join(DATA_MAP, 'toegang.json');

let db = {versie:0, data:null};
try{ db = JSON.parse(fs.readFileSync(STATE_BESTAND, 'utf8')); }catch(e){}
let log = []; // recente wijzigingen: {versie, toestel, patch}
const LOG_MAX = 2000;

function veiligSchrijven(bestand, inhoud){
  const tmp = bestand + '.tmp';
  fs.writeFileSync(tmp, inhoud);
  fs.renameSync(tmp, bestand);
}

let schrijfTimer = null;
function bewaarLater(){
  if(schrijfTimer) return;
  schrijfTimer = setTimeout(bewaarNu, 500);
}
function bewaarNu(){
  clearTimeout(schrijfTimer); schrijfTimer = null;
  try{ veiligSchrijven(STATE_BESTAND, JSON.stringify(db)); maakDagBackup(); }
  catch(e){ console.error('Bewaren mislukt:', e); }
}
function maakDagBackup(){
  const dag = new Date().toISOString().slice(0, 10);
  const doel = path.join(DATA_MAP, 'backups', `state-${dag}.json`);
  if(fs.existsSync(doel)) return;
  fs.copyFileSync(STATE_BESTAND, doel);
  const oud = fs.readdirSync(path.join(DATA_MAP, 'backups')).filter(f => /^state-\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
  while(oud.length > BACKUP_DAGEN) fs.unlinkSync(path.join(DATA_MAP, 'backups', oud.shift()));
}

function zonderLokaal(patch){
  if(patch && patch.t === 'o'){
    for(const k of LOKALE_SLEUTELS){ if(patch.set) delete patch.set[k]; if(patch.del) patch.del = patch.del.filter(x => x !== k); }
  }
  return patch;
}

function pasToe(patch, toestel){
  patch = zonderLokaal(patch);
  if(patch.t !== 'o') throw new Error('Ongeldige wijziging');
  db.data = toepassen(db.data || {}, patch);
  db.versie++;
  log.push({versie:db.versie, toestel, patch});
  if(log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
  bewaarLater();
}

function wijzigingenSinds(versie, toestel){
  if(versie === db.versie) return {versie:db.versie, patches:[]};
  const eerste = log.length ? log[0].versie : db.versie + 1;
  if(versie < eerste - 1 || versie > db.versie) return {versie:db.versie, volledig:db.data};
  return {versie:db.versie, patches:log.filter(x => x.versie > versie && x.toestel !== toestel).map(x => x.patch)};
}

// ---------- Toegang (één code per school, cookie per toestel) ----------
function hashCode(code){ return crypto.createHash('sha256').update('colomarkt:' + code).digest('hex'); }
// Een code die de beheerder in de app instelde, gaat voor op TOEGANGSCODE uit /etc/colomarkt.env.
let codeHash = instellingen.toegangscodeHash || hashCode(TOEGANGSCODE);
let toegang = {};
try{ toegang = JSON.parse(fs.readFileSync(TOEGANG_BESTAND, 'utf8')); }catch(e){}
function bewaarToegang(){ veiligSchrijven(TOEGANG_BESTAND, JSON.stringify(toegang, null, 1)); }
function bewaarInstellingen(){ veiligSchrijven(INSTELLINGEN_BESTAND, JSON.stringify(instellingen, null, 1)); }
// Korte, niet-geheime naam voor een toestel (de cookie zelf toont de beheerder nooit).
function toestelId(token){ return crypto.createHash('sha256').update('toestel:' + token).digest('hex').slice(0, 10); }
let toegangGewijzigd = false;
setInterval(() => { if(toegangGewijzigd){ toegangGewijzigd = false; try{ bewaarToegang(); }catch(e){ console.error(e); } } }, 5 * 60 * 1000).unref();

function cookies(req){
  const uit = {};
  for(const deel of (req.headers.cookie || '').split(';')){
    const i = deel.indexOf('=');
    if(i > 0) uit[deel.slice(0, i).trim()] = decodeURIComponent(deel.slice(i + 1).trim());
  }
  return uit;
}
function heeftToegang(req){
  const t = cookies(req).cm_toegang;
  const ok = !!(t && toegang[t] && toegang[t].code === codeHash);
  if(ok){
    // Laatst gezien, per kwartier bijgehouden (voor het overzicht van de toestellen).
    const nu = new Date().toISOString();
    if(!toegang[t].laatst || Date.parse(nu) - Date.parse(toegang[t].laatst) > 15 * 60 * 1000){ toegang[t].laatst = nu; toegangGewijzigd = true; }
  }
  return ok;
}
const pogingen = new Map(); // ip -> {n, sinds}
function teVeelPogingen(ip){
  const nu = Date.now(), p = pogingen.get(ip);
  if(!p || nu - p.sinds > 15 * 60 * 1000){ pogingen.set(ip, {n:1, sinds:nu}); return false; }
  p.n++;
  return p.n > 10;
}
function isHttps(req){ return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted; }
function gelijkeHash(a, b){
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function klantIp(req){ return req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress; }

// ---------- Hulpjes ----------
function stuur(req, res, status, body, type, extra){
  const headers = Object.assign({'Content-Type':type || 'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}, extra || {});
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  if(buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')){
    buf = zlib.gzipSync(buf, {level:6});
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}
function leesBody(req, max){
  return new Promise((ok, fout) => {
    const delen = []; let n = 0;
    req.on('data', d => { n += d.length; if(n > max){ fout(Object.assign(new Error('te groot'), {status:413})); req.destroy(); } else delen.push(d); });
    req.on('end', () => { try{ ok(JSON.parse(Buffer.concat(delen).toString('utf8') || '{}')); }catch(e){ fout(Object.assign(e, {status:400})); } });
    req.on('error', fout);
  });
}

// ---------- Statische bestanden ----------
const TYPES = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.png':'image/png', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.css':'text/css; charset=utf-8'};
const cache = new Map(); // pad -> {mtime, gz, raw, etag}
function bestand(req, res, vol){
  let st;
  try{ st = fs.statSync(vol); }catch(e){ return stuur(req, res, 404, {fout:'niet gevonden'}); }
  if(!st.isFile()) return stuur(req, res, 404, {fout:'niet gevonden'});
  let c = cache.get(vol);
  if(!c || c.mtime !== st.mtimeMs){
    const raw = fs.readFileSync(vol);
    c = {mtime:st.mtimeMs, raw, gz:raw.length > 1024 ? zlib.gzipSync(raw) : null, etag:'"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16) + '"'};
    cache.set(vol, c);
  }
  if(req.headers['if-none-match'] === c.etag){ res.writeHead(304, {'ETag':c.etag}); return res.end(); }
  const headers = {'Content-Type':TYPES[path.extname(vol)] || 'application/octet-stream', 'ETag':c.etag, 'Cache-Control':'no-cache'};
  let buf = c.raw;
  if(c.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')){ buf = c.gz; headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding'; }
  headers['Content-Length'] = buf.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

// De app zelf: index.html uit de app-map, met de koppeling naar de server erin gezet.
let appCache = {mtime:0, html:''};
function appHtml(){
  const vol = path.join(APP_MAP, 'index.html');
  const st = fs.statSync(vol);
  if(appCache.mtime === st.mtimeMs) return appCache.html;
  let html = fs.readFileSync(vol, 'utf8');
  const kop = '<script>window.COLOMARKT_SERVER = true;</script><script src="/merge.js"></script><script src="/sync.js"></script>'
    + '<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';
  html = html.replace(/<head[^>]*>/i, m => m + '\n' + kop);
  // Link voor "Op je gsm" wijst naar dit adres in plaats van naar claude.ai.
  html = html.replace(/const APP_LINK = '[^']*';/, 'const APP_LINK = location.origin + "/";');
  html = html.replace(/<p class="note">Let op: zolang de serverversie er niet is[\s\S]*?<\/p>/, '<p class="note">Alle toestellen delen dezelfde gegevens via de server.</p>');
  // Gmail werkt enkel binnen claude.ai: verberg de mailknop op de server.
  html = html.split('${email && bonGmail ?').join('${email && bonGmail && bonGmail.gmail !== false ?');
  // De claude.ai-versie haalt catalogi uit haar eigen opslag; hier staan ze gewoon als bestand op de server.
  html = html.replace('function catFetch(path){', 'function catFetch(path){ if(window.COLOMARKT_SERVER) return fetch(path);');
  html = html.replace('Alle gegevens staan in de browser van dit toestel. Download geregeld een back-up','Alle gegevens staan op de server, die elke dag zelf een back-up maakt. Je kan ook zelf een back-up downloaden');
  appCache = {mtime:st.mtimeMs, html};
  return html;
}

function toegangPagina(fout){
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Colomarkt+</title><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="theme-color" content="#B01E4B">
<style>:root{--bg:#F5F3EC;--panel:#fff;--ink:#232722;--soft:#5B6459;--brand:#C42A55;--line:#DDD8C9}
@media (prefers-color-scheme:dark){:root{--bg:#1B1E1A;--panel:#242822;--ink:#EEEDE6;--soft:#A8AE9F;--brand:#F27A97;--line:#38402F}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
form{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px;max-width:360px;width:100%}
h1{color:var(--brand);margin:0 0 6px;font-size:28px}p{color:var(--soft);margin:0 0 16px;font-size:14px}
input{width:100%;box-sizing:border-box;font-size:18px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink)}
button{margin-top:12px;width:100%;font-size:16px;font-weight:600;padding:12px;border:0;border-radius:8px;background:var(--brand);color:#fff;cursor:pointer}
.fout{color:#c0392b;min-height:20px;margin-top:10px;font-size:14px}</style></head><body>
<form method="post" action="/toegang"><h1>Colomarkt+</h1><p>Geef de toegangscode van de school. Dit toestel onthoudt de code daarna.</p>
<input name="code" type="password" autocomplete="current-password" autofocus required aria-label="Toegangscode">
<button type="submit">Openen</button><div class="fout">${fout || ''}</div></form></body></html>`;
}

// ---------- AI (foto's en tekst lezen met Claude) ----------
async function aiVraag(body){
  const content = [];
  for(const img of (body.images || []).slice(0, 10)){
    if(!/^image\/(jpeg|png|gif|webp)$/.test(img.mediaType || '')) continue;
    content.push({type:'image', source:{type:'base64', media_type:img.mediaType, data:img.data}});
  }
  content.push({type:'text', text:String(body.prompt || '').slice(0, 60000)});
  const model = body.tier === 'quick' ? AI_MODEL_SNEL : AI_MODEL;
  const verzoek = {model, max_tokens:16000, messages:[{role:'user', content}]};
  const headers = {'content-type':'application/json', 'x-api-key':ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01'};
  // Weigert het model een verzoek onterecht, dan kiest de API zelf een ander model (niet voor Haiku).
  if(!/haiku/.test(model)){ verzoek.fallbacks = 'default'; headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; }
  const r = await fetch('https://api.anthropic.com/v1/messages', {method:'POST', headers, body:JSON.stringify(verzoek)});
  const j = await r.json().catch(() => ({}));
  if(!r.ok){
    const code = r.status === 429 || r.status === 529 ? 'rate_limited' : (r.status === 400 && content.length > 1 ? 'image_rejected' : 'fout');
    throw Object.assign(new Error((j.error && j.error.message) || ('AI-fout ' + r.status)), {code});
  }
  if(j.stop_reason === 'refusal') throw Object.assign(new Error('Claude kon dit document niet verwerken.'), {code:'fout'});
  if(j.stop_reason === 'max_tokens') throw Object.assign(new Error('Het antwoord was te lang. Probeer minder foto\'s tegelijk.'), {code:'fout'});
  const tekst = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  return leesJson(tekst);
}
function leesJson(tekst){
  let t = tekst.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try{ return JSON.parse(t); }catch(e){}
  const start = t.search(/[\[{]/);
  if(start >= 0){
    const eind = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
    try{ return JSON.parse(t.slice(start, eind + 1)); }catch(e){}
  }
  throw Object.assign(new Error('Geen geldige JSON van de AI'), {code:'fout'});
}

// ---------- Claude-taken starten ----------
function routineVoor(triggerId){
  for(const naam of Object.keys(ROUTINES)) if(ROUTINES[naam].id === triggerId && ROUTINES[naam].token) return ROUTINES[naam];
  return null;
}
async function startRoutine(r, tekst){
  const res = await fetch(`https://api.anthropic.com/v1/claude_code/routines/${encodeURIComponent(r.id)}/fire`, {
    method:'POST',
    headers:{'Authorization':'Bearer ' + r.token, 'anthropic-beta':'experimental-cc-routine-2026-04-01', 'anthropic-version':'2023-06-01', 'Content-Type':'application/json'},
    body:JSON.stringify({text:String(tekst || '').slice(0, 60000)})
  });
  const j = await res.json().catch(() => ({}));
  if(!res.ok){
    const code = res.status === 401 || res.status === 403 ? 'needs_reauth' : (res.status === 429 ? 'rate_limited' : 'upstream_error');
    throw Object.assign(new Error((j.error && j.error.message) || ('Taak starten mislukt (' + res.status + ')')), {code});
  }
  return j;
}

// Taken sturen hun resultaat terug met de serversleutel.
function isTaak(req){
  const h = String(req.headers.authorization || '');
  if(!SERVER_SLEUTEL || !h.startsWith('Bearer ')) return false;
  const a = Buffer.from(crypto.createHash('sha256').update(h.slice(7)).digest('hex'));
  const b = Buffer.from(crypto.createHash('sha256').update(SERVER_SLEUTEL).digest('hex'));
  return crypto.timingSafeEqual(a, b);
}
const CORS = {'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Authorization, Content-Type', 'Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS', 'Access-Control-Max-Age':'600'};
const CATALOGUS_NAAM = /^[a-z0-9-]+\.json$/;
async function taakRoute(req, res, p){
  if(req.method === 'OPTIONS'){ res.writeHead(204, CORS); return res.end(); }
  if(!isTaak(req)) return stuur(req, res, 401, {fout:'ongeldige serversleutel'}, null, CORS);

  // Openstaande bestelbonnen, zodat de taak weet wat ze moet controleren.
  if(p === '/api/taak/bonnen' && req.method === 'GET'){
    const bonnen = ((db.data && db.data.bestelbonnen) || []).filter(b => b.status === 'aangemaakt')
      .map(b => ({bonnummer:b.id, leverancier:b.leverancier, datum:b.datum, regels:(b.regels || []).map(r => ({art:r.art || '', naam:r.naam, aantal:r.aantal, eenheid:r.eenheid}))}));
    return stuur(req, res, 200, {bonnen}, null, CORS);
  }
  if(p === '/api/taak/bonstatus' && req.method === 'POST'){
    const body = await leesBody(req, 1024 * 1024);
    const lijst = Array.isArray(body) ? body : [body];
    let n = 0;
    for(const x of lijst){
      const id = String(x.bonnummer || x.id || '');
      if(!/^BB-\d{4}-\d{4}$/.test(id)) continue;
      if(bonstatus[id] && bonstatus[id].status === 'besteld' && x.status !== 'besteld') continue;
      bonstatus[id] = {status:String(x.status || 'besteld'), bron:x.bron || '', besteldOp:x.besteldOp || '', leverdatum:x.leverdatum || '', totaalExclBtw:typeof x.totaalExclBtw === 'number' ? x.totaalExclBtw : null, gecontroleerd:x.gecontroleerd || new Date().toISOString()};
      n++;
    }
    veiligSchrijven(BONSTATUS_BESTAND, JSON.stringify(bonstatus, null, 1));
    return stuur(req, res, 200, {bewaard:n}, null, CORS);
  }
  const m = p.match(/^\/api\/taak\/catalogus\/(.+)$/);
  if(m && CATALOGUS_NAAM.test(m[1])){
    const eigen = path.join(DATA_MAP, 'catalogus', m[1]);
    if(req.method === 'GET'){
      const vol = fs.existsSync(eigen) ? eigen : path.join(APP_MAP, 'catalogus', m[1]);
      if(!fs.existsSync(vol)) return stuur(req, res, 404, {fout:'niet gevonden'}, null, CORS);
      return stuur(req, res, 200, fs.readFileSync(vol), 'application/json; charset=utf-8', CORS);
    }
    if(req.method === 'PUT' || req.method === 'POST'){
      const body = await leesBody(req, 60 * 1024 * 1024); // controleert ook dat het geldige JSON is
      veiligSchrijven(eigen, JSON.stringify(body));
      return stuur(req, res, 200, {bewaard:m[1]}, null, CORS);
    }
  }
  return stuur(req, res, 404, {fout:'niet gevonden'}, null, CORS);
}

// ---------- Beheersmodule (systeembeheerder) ----------
// Alles onder /api/beheer/ vraagt eerst de gewone toegangscode (cookie) en daarna het beheerwachtwoord.
const BEHEER_LOG_BESTAND = path.join(DATA_MAP, 'beheer-log.json');
const BACKUP_NAAM = /^[A-Za-z0-9_-]{1,80}\.json$/;
const beheerSessies = new Map(); // token -> {tot, toegang}
const BEHEER_SESSIE_UREN = 12;
let beheerLog = [];
try{ beheerLog = JSON.parse(fs.readFileSync(BEHEER_LOG_BESTAND, 'utf8')); }catch(e){}

function nuTekst(){
  const d = new Date(), tz = {timeZone:'Europe/Brussels'};
  return d.toLocaleDateString('nl-BE', tz) + ' ' + d.toLocaleTimeString('nl-BE', Object.assign({hour:'2-digit', minute:'2-digit'}, tz));
}
function logBeheer(req, tekst){
  beheerLog.push({tijd:new Date().toISOString(), ip:klantIp(req), toestel:toestelId(cookies(req).cm_toegang || ''), tekst});
  if(beheerLog.length > 500) beheerLog.splice(0, beheerLog.length - 500);
  try{ veiligSchrijven(BEHEER_LOG_BESTAND, JSON.stringify(beheerLog, null, 1)); }catch(e){ console.error(e); }
  console.log('Beheer:', tekst);
}
function wachtwoordHash(pw){
  const zout = crypto.randomBytes(16).toString('hex');
  return 'scrypt$' + zout + '$' + crypto.scryptSync(pw, zout, 32).toString('hex');
}
function wachtwoordKlopt(pw){
  pw = String(pw || '');
  if(instellingen.beheerHash){
    const [, zout, hash] = instellingen.beheerHash.split('$');
    return gelijkeHash(crypto.scryptSync(pw, zout, 32).toString('hex'), hash);
  }
  if(!BEHEER_WACHTWOORD) return false;
  return gelijkeHash(hashCode(pw), hashCode(BEHEER_WACHTWOORD));
}
function beheerIngesteld(){ return !!(instellingen.beheerHash || BEHEER_WACHTWOORD); }
function beheerSessie(req){
  const c = cookies(req), s = c.cm_beheer && beheerSessies.get(c.cm_beheer);
  if(!s) return null;
  if(s.tot < Date.now() || s.toegang !== c.cm_toegang){ beheerSessies.delete(c.cm_beheer); return null; }
  return s;
}
function beheerCookie(req, token, maxAge){
  return `cm_beheer=${token}; Path=/api/beheer/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${isHttps(req) ? '; Secure' : ''}`;
}
function backupLijst(){
  const map = path.join(DATA_MAP, 'backups');
  return fs.readdirSync(map).filter(f => BACKUP_NAAM.test(f)).map(f => {
    const st = fs.statSync(path.join(map, f));
    const soort = f.startsWith('state-') ? 'dagelijks' : f.startsWith('voor-update-') ? 'voor update' : f.startsWith('voor-terugzetten-') ? 'voor terugzetten' : 'handmatig';
    return {bestand:f, soort, grootte:st.size, datum:st.mtime.toISOString()};
  }).sort((a, b) => b.datum.localeCompare(a.datum));
}
function stempel(){ // lokale tijd, bv. 2026-10-22_1125
  return new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Brussels', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}).format(new Date()).replace(' ', '_').replace(':', '');
}
// Leest een back-up: het serverformaat {versie, data} of een download uit de app {app, state}.
function leesBackupInhoud(tekst){
  const j = JSON.parse(tekst);
  let data = j && j.data !== undefined && j.versie !== undefined ? j.data : (j && j.state) || null;
  if(!data || !Array.isArray(data.users) || !Array.isArray(data.products)) throw new Error('Dit bestand is geen back-up van Colomarkt+.');
  data = Object.assign({}, data); for(const k of LOKALE_SLEUTELS) delete data[k];
  return data;
}

async function beheerRoute(req, res, p, url){
  const post = req.method === 'POST';
  // Enkel JSON-aanvragen van de app zelf (beschermt tegen formulieren van andere sites).
  if(post && !/^application\/json/i.test(req.headers['content-type'] || '')) return stuur(req, res, 415, {fout:'Verkeerd formaat'});
  const eigenToestel = cookies(req).cm_toegang;

  if(p === '/api/beheer/status' && req.method === 'GET')
    return stuur(req, res, 200, {ingesteld:beheerIngesteld(), aangemeld:!!beheerSessie(req)});

  if(p === '/api/beheer/aanmelden' && post){
    const ip = 'beheer:' + klantIp(req);
    if(teVeelPogingen(ip)) return stuur(req, res, 429, {fout:'Te veel pogingen. Probeer het over een kwartier opnieuw.'});
    if(!beheerIngesteld()) return stuur(req, res, 503, {fout:'Er is nog geen beheerwachtwoord ingesteld. Zet BEHEER_WACHTWOORD in /etc/colomarkt.env en herstart de dienst.'});
    const body = await leesBody(req, 10000);
    if(!wachtwoordKlopt(body.wachtwoord)){ await new Promise(r => setTimeout(r, 600)); return stuur(req, res, 403, {fout:'Verkeerd wachtwoord.'}); }
    pogingen.delete(ip);
    const token = crypto.randomBytes(24).toString('hex');
    beheerSessies.set(token, {tot:Date.now() + BEHEER_SESSIE_UREN * 3600 * 1000, toegang:eigenToestel});
    logBeheer(req, 'Aangemeld als systeembeheerder.');
    return stuur(req, res, 200, {ok:true}, null, {'Set-Cookie':beheerCookie(req, token, BEHEER_SESSIE_UREN * 3600)});
  }
  if(p === '/api/beheer/afmelden' && post){
    const c = cookies(req); if(c.cm_beheer) beheerSessies.delete(c.cm_beheer);
    return stuur(req, res, 200, {ok:true}, null, {'Set-Cookie':beheerCookie(req, '', 0)});
  }

  if(!beheerSessie(req)) return stuur(req, res, 401, {fout:'Meld je opnieuw aan als systeembeheerder.', code:'beheer'});

  if(p === '/api/beheer/info' && req.method === 'GET'){
    let grootte = 0; try{ grootte = fs.statSync(STATE_BESTAND).size; }catch(e){}
    let appDatum = ''; try{ appDatum = fs.statSync(path.join(APP_MAP, 'index.html')).mtime.toISOString(); }catch(e){}
    return stuur(req, res, 200, {
      versie:db.versie, gestart:new Date(START_TIJD).toISOString(), node:process.version, appDatum,
      dataGrootte:grootte, dataMap:DATA_MAP, backupDagen:BACKUP_DAGEN, backups:backupLijst().length,
      toestellen:Object.values(toegang).filter(t => t.code === codeHash).length,
      ai:!!ANTHROPIC_API_KEY, aiModel:AI_MODEL, aiModelSnel:AI_MODEL_SNEL,
      routines:{webshop:!!ROUTINES.webshop.token, bestelstatus:!!ROUTINES.bestelstatus.token, prijzen:!!ROUTINES.prijzen.token},
      serverSleutel:!!SERVER_SLEUTEL,
      codeBron:instellingen.toegangscodeHash ? 'app' : 'config', wachtwoordBron:instellingen.beheerHash ? 'app' : 'config'
    });
  }
  if(p === '/api/beheer/logboek' && req.method === 'GET') return stuur(req, res, 200, {log:beheerLog.slice(-200).reverse()});

  // --- Toestellen en toegangscode ---
  if(p === '/api/beheer/toestellen' && req.method === 'GET'){
    const lijst = Object.entries(toegang).filter(([, t]) => t.code === codeHash).map(([token, t]) => ({
      id:toestelId(token), naam:t.naam || '', toestel:t.toestel || '', sinds:t.sinds || '', laatst:t.laatst || '', ditToestel:token === eigenToestel
    })).sort((a, b) => (b.laatst || '').localeCompare(a.laatst || ''));
    return stuur(req, res, 200, {toestellen:lijst});
  }
  if(p === '/api/beheer/toestel' && post){
    const body = await leesBody(req, 10000);
    const token = Object.keys(toegang).find(t => toestelId(t) === String(body.id || ''));
    if(!token) return stuur(req, res, 404, {fout:'Toestel niet gevonden.'});
    if(body.actie === 'naam'){
      toegang[token].naam = String(body.naam || '').trim().slice(0, 60); bewaarToegang();
      return stuur(req, res, 200, {ok:true});
    }
    if(body.actie === 'intrekken'){
      if(token === eigenToestel) return stuur(req, res, 400, {fout:'Je kan de toegang van dit toestel niet intrekken.'});
      const naam = toegang[token].naam || toestelId(token);
      delete toegang[token]; bewaarToegang();
      logBeheer(req, `Toegang ingetrokken voor toestel ${naam}.`);
      return stuur(req, res, 200, {ok:true});
    }
    return stuur(req, res, 400, {fout:'Onbekende actie.'});
  }
  if(p === '/api/beheer/toestellen-afmelden' && post){
    let n = 0;
    for(const t of Object.keys(toegang)) if(t !== eigenToestel){ delete toegang[t]; n++; }
    bewaarToegang();
    logBeheer(req, `Alle andere toestellen afgemeld (${n}).`);
    return stuur(req, res, 200, {afgemeld:n});
  }
  if(p === '/api/beheer/toegangscode' && post){
    const body = await leesBody(req, 10000);
    const code = String(body.code || '').trim();
    if(code.length < 8) return stuur(req, res, 400, {fout:'Kies een toegangscode van minstens 8 tekens.'});
    codeHash = hashCode(code);
    instellingen.toegangscodeHash = codeHash; bewaarInstellingen();
    // Dit toestel blijft binnen; alle andere toestellen moeten de nieuwe code ingeven.
    let n = 0;
    for(const t of Object.keys(toegang)){ if(t === eigenToestel) toegang[t].code = codeHash; else { delete toegang[t]; n++; } }
    bewaarToegang();
    logBeheer(req, `Toegangscode gewijzigd; ${n} andere toestellen moeten de nieuwe code ingeven.`);
    return stuur(req, res, 200, {ok:true, afgemeld:n});
  }
  if(p === '/api/beheer/wachtwoord' && post){
    const body = await leesBody(req, 10000);
    if(!wachtwoordKlopt(body.huidig)) return stuur(req, res, 403, {fout:'Het huidige wachtwoord klopt niet.'});
    const nieuw = String(body.nieuw || '');
    if(nieuw.length < 10) return stuur(req, res, 400, {fout:'Kies een wachtwoord van minstens 10 tekens.'});
    instellingen.beheerHash = wachtwoordHash(nieuw); bewaarInstellingen();
    // Andere beheersessies stoppen; deze blijft.
    const eigen = cookies(req).cm_beheer;
    for(const t of [...beheerSessies.keys()]) if(t !== eigen) beheerSessies.delete(t);
    logBeheer(req, 'Beheerwachtwoord gewijzigd.');
    return stuur(req, res, 200, {ok:true});
  }

  // --- Back-ups op de server ---
  if(p === '/api/beheer/backups' && req.method === 'GET') return stuur(req, res, 200, {backups:backupLijst(), dagen:BACKUP_DAGEN});
  if(p === '/api/beheer/backup' && req.method === 'GET'){
    const naam = url.searchParams.get('bestand') || '';
    let vol, downloadNaam = naam;
    if(naam === 'huidig'){ bewaarNu(); vol = STATE_BESTAND; downloadNaam = `colomarkt-server_${stempel()}.json`; }
    else if(BACKUP_NAAM.test(naam)) vol = path.join(DATA_MAP, 'backups', naam);
    if(!vol || !fs.existsSync(vol)) return stuur(req, res, 404, {fout:'Back-up niet gevonden.'});
    logBeheer(req, `Back-up gedownload: ${downloadNaam}.`);
    return stuur(req, res, 200, fs.readFileSync(vol), 'application/json; charset=utf-8', {'Content-Disposition':`attachment; filename="${downloadNaam}"`});
  }
  if(p === '/api/beheer/backup-maken' && post){
    bewaarNu();
    const naam = `handmatig-${stempel()}.json`;
    fs.copyFileSync(STATE_BESTAND, path.join(DATA_MAP, 'backups', naam));
    logBeheer(req, `Back-up gemaakt: ${naam}.`);
    return stuur(req, res, 200, {bestand:naam});
  }
  if(p === '/api/beheer/backup-terugzetten' && post){
    const body = await leesBody(req, 60 * 1024 * 1024);
    let data, bron;
    try{
      if(body.bestand){
        if(!BACKUP_NAAM.test(body.bestand)) throw new Error('Ongeldige bestandsnaam.');
        data = leesBackupInhoud(fs.readFileSync(path.join(DATA_MAP, 'backups', body.bestand), 'utf8'));
        bron = body.bestand;
      } else if(body.inhoud){
        data = leesBackupInhoud(typeof body.inhoud === 'string' ? body.inhoud : JSON.stringify(body.inhoud));
        bron = 'een geüpload bestand';
      } else throw new Error('Geen back-up gekozen.');
    }catch(e){ return stuur(req, res, 400, {fout:e.code === 'ENOENT' ? 'Back-up niet gevonden.' : e.message}); }
    // Eerst een vangnet van de huidige gegevens.
    bewaarNu();
    const vangnet = `voor-terugzetten-${stempel()}.json`;
    try{ fs.copyFileSync(STATE_BESTAND, path.join(DATA_MAP, 'backups', vangnet)); }catch(e){}
    if(!Array.isArray(data.activity)) data.activity = [];
    data.activity.push({tijd:nuTekst(), tekst:`Back-up teruggezet door de systeembeheerder (${bron}).`});
    // Een hogere versie en een leeg logboek: elk toestel haalt meteen de volledige gegevens opnieuw op.
    db = {versie:db.versie + 1, data};
    log = [];
    bewaarNu();
    logBeheer(req, `Back-up teruggezet: ${bron}. Vangnet: ${vangnet}.`);
    return stuur(req, res, 200, {ok:true, vangnet, versie:db.versie});
  }

  return stuur(req, res, 404, {fout:'niet gevonden'});
}

// ---------- Routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try{
    if(p === '/gezond') return stuur(req, res, 200, {ok:true, versie:db.versie});
    if(p.startsWith('/api/taak/')) return await taakRoute(req, res, p);

    // Bestanden die ook zonder code nodig zijn (icoon op het beginscherm).
    if(['/manifest.webmanifest', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png'].includes(p))
      return bestand(req, res, path.join(APP_MAP, p.slice(1)));

    if(p === '/toegang' && req.method === 'POST'){
      const ip = req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress;
      if(teVeelPogingen(ip)) return stuur(req, res, 429, toegangPagina('Te veel pogingen. Probeer het over een kwartier opnieuw.'), 'text/html; charset=utf-8');
      const ruw = await new Promise(ok => { let s = ''; req.on('data', d => { s += d; if(s.length > 2000) req.destroy(); }); req.on('end', () => ok(s)); });
      const code = new URLSearchParams(ruw).get('code') || '';
      if(!gelijkeHash(hashCode(code), codeHash)) return stuur(req, res, 401, toegangPagina('Deze code klopt niet.'), 'text/html; charset=utf-8');
      const token = crypto.randomBytes(24).toString('hex');
      toegang[token] = {code:codeHash, sinds:new Date().toISOString(), laatst:new Date().toISOString(), toestel:String(req.headers['user-agent'] || '').slice(0, 120)};
      bewaarToegang();
      pogingen.delete(ip);
      const cookie = `cm_toegang=${token}; Path=/; Max-Age=${400 * 24 * 3600}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;
      res.writeHead(303, {'Location':'/', 'Set-Cookie':cookie});
      return res.end();
    }

    if(!heeftToegang(req)){
      if(p.startsWith('/api/')) return stuur(req, res, 401, {fout:'geen toegang'});
      return stuur(req, res, 200, toegangPagina(''), 'text/html; charset=utf-8');
    }

    if(p.startsWith('/api/beheer/')) return await beheerRoute(req, res, p, url);

    if(p === '/' || p === '/index.html') return stuur(req, res, 200, appHtml(), 'text/html; charset=utf-8');
    if(p === '/merge.js') return bestand(req, res, path.join(__dirname, 'lib', 'merge.js'));
    if(p === '/sync.js') return bestand(req, res, path.join(__dirname, 'public', 'sync.js'));

    if(p === '/api/state' && req.method === 'GET') return stuur(req, res, 200, {versie:db.versie, data:db.data});

    if(p === '/api/wijzigingen' && req.method === 'GET'){
      const sinds = parseInt(url.searchParams.get('sinds') || '0', 10);
      return stuur(req, res, 200, wijzigingenSinds(sinds, url.searchParams.get('toestel') || ''));
    }

    if(p === '/api/wijzig' && req.method === 'POST'){
      const body = await leesBody(req, 50 * 1024 * 1024);
      const basis = parseInt(body.basis, 10) || 0;
      const toestel = String(body.toestel || '');
      const anderen = wijzigingenSinds(basis, toestel);
      if(body.patch) pasToe(body.patch, toestel);
      // Het toestel krijgt meteen mee wat anderen sinds zijn laatste versie veranderden.
      const uit = {versie:db.versie};
      if(anderen.volledig !== undefined) uit.volledig = db.data; else uit.patches = anderen.patches;
      return stuur(req, res, 200, uit);
    }

    if(p === '/api/ai' && req.method === 'GET') return stuur(req, res, 200, {beschikbaar:!!ANTHROPIC_API_KEY});
    if(p === '/api/ai' && req.method === 'POST'){
      if(!ANTHROPIC_API_KEY) return stuur(req, res, 503, {fout:'AI is niet ingesteld op deze server.', code:'not_granted'});
      const body = await leesBody(req, 40 * 1024 * 1024);
      try{ return stuur(req, res, 200, {data:await aiVraag(body)}); }
      catch(e){ return stuur(req, res, 502, {fout:e.message, code:e.code || 'fout'}); }
    }

    if(p === '/api/koppelingen' && req.method === 'GET')
      return stuur(req, res, 200, {webshop:!!ROUTINES.webshop.token, bestelstatus:!!ROUTINES.bestelstatus.token, prijzen:!!ROUTINES.prijzen.token, mail:false, ai:!!ANTHROPIC_API_KEY});
    if(p === '/api/taak-starten' && req.method === 'POST'){
      const body = await leesBody(req, 1024 * 1024);
      const r = routineVoor(String(body.trigger_id || ''));
      if(!r) return stuur(req, res, 404, {fout:'Deze taak is niet ingesteld op de server.', code:'server_not_found'});
      try{ const j = await startRoutine(r, body.text); return stuur(req, res, 200, {ok:true, sessie:j.claude_code_session_url || ''}); }
      catch(e){ return stuur(req, res, 502, {fout:e.message, code:e.code}); }
    }
    if(p === '/api/bonstatus' && req.method === 'GET') return stuur(req, res, 200, bonstatus);

    // Catalogi die een taak naar de server stuurde, gaan voor op die uit het pakket.
    const cm = p.match(/^\/catalogus\/([a-z0-9-]+\.json)$/);
    if(cm && fs.existsSync(path.join(DATA_MAP, 'catalogus', cm[1]))) return bestand(req, res, path.join(DATA_MAP, 'catalogus', cm[1]));

    // Catalogusbestanden en andere bestanden van de app.
    const vol = path.join(APP_MAP, path.normalize(p).replace(/^([/\\])+/, ''));
    if(!vol.startsWith(APP_MAP + path.sep)) return stuur(req, res, 404, {fout:'niet gevonden'});
    return bestand(req, res, vol);
  }catch(e){
    console.error(e);
    if(!res.headersSent) stuur(req, res, e.status || 500, {fout:e.status ? e.message : 'serverfout'});
  }
});

function stop(){ bewaarNu(); process.exit(0); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

server.listen(POORT, ADRES, () => console.log(`Colomarkt+ draait op http://${ADRES}:${POORT} (gegevensversie ${db.versie})`));
module.exports = {server, verschil};

// Koppelt de Colomarkt+-app aan de server.
// De app bewaart alles onder één sleutel in localStorage; dit script vangt dat op,
// stuurt enkel de wijzigingen naar de server en haalt wijzigingen van andere toestellen binnen.
(function(){
  'use strict';
  var SLEUTEL = 'hvg_voorraad_v1';
  var LOKAAL = ['currentUser'];
  var M = window.ColoMerge;
  var opslag = window.localStorage;
  var origGet = Storage.prototype.getItem, origSet = Storage.prototype.setItem;

  var toestel = (function(){
    try{ var t = origGet.call(opslag, 'cm_toestel'); if(t) return t; }catch(e){}
    var n = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try{ origSet.call(opslag, 'cm_toestel', n); }catch(e){}
    return n;
  })();

  var versie = 0;        // laatste serverversie die dit toestel kent
  var gesynct = null;    // gegevens zoals de server ze kent (zonder lokale sleutels)
  var geheugen = null;   // wat de app als opgeslagen tekst ziet
  var bezig = false, timer = null, opnieuw = false, verbonden = true, fouten = 0;

  function zonderLokaal(o){
    var c = {};
    for(var k in o) if(Object.prototype.hasOwnProperty.call(o, k) && LOKAAL.indexOf(k) < 0) c[k] = o[k];
    return c;
  }

  // ---- Eerste lading: synchroon, zodat de app meteen de servergegevens leest ----
  (function(){
    var lokaal = null;
    try{ lokaal = origGet.call(opslag, SLEUTEL); }catch(e){}
    var lokaalObj = null;
    try{ lokaalObj = lokaal ? JSON.parse(lokaal) : null; }catch(e){}
    try{
      var x = new XMLHttpRequest();
      x.open('GET', '/api/state', false);
      x.send();
      if(x.status === 401){ location.reload(); return; }
      if(x.status !== 200) throw new Error('status ' + x.status);
      var r = JSON.parse(x.responseText);
      versie = r.versie;
      if(r.data){
        gesynct = r.data;
        var app = M.clone(r.data);
        if(lokaalObj) LOKAAL.forEach(function(k){ if(lokaalObj[k] !== undefined) app[k] = lokaalObj[k]; });
        geheugen = JSON.stringify(app);
      } else {
        // Lege server: de gegevens van dit toestel worden de startgegevens.
        gesynct = {};
        geheugen = lokaal;
      }
      try{ origSet.call(opslag, 'cm_versie', String(versie)); }catch(e){}
    }catch(e){
      // Geen verbinding: werk verder met de laatst bekende gegevens op dit toestel.
      verbonden = false;
      geheugen = lokaal;
      gesynct = lokaalObj ? zonderLokaal(lokaalObj) : {};
      try{ versie = parseInt(origGet.call(opslag, 'cm_versie') || '0', 10); }catch(_){}
    }
  })();

  Storage.prototype.getItem = function(k){
    if(this === opslag && k === SLEUTEL) return geheugen;
    return origGet.apply(this, arguments);
  };
  Storage.prototype.setItem = function(k, v){
    if(this === opslag && k === SLEUTEL){
      geheugen = String(v);
      try{ origSet.call(opslag, SLEUTEL, geheugen); }catch(e){} // kopie op het toestel; mag vol zijn
      planVersturen();
      return;
    }
    return origSet.apply(this, arguments);
  };

  function appState(){
    try{ return typeof state !== 'undefined' ? state : null; }catch(e){ return null; } // eslint-disable-line no-undef
  }

  function planVersturen(){
    clearTimeout(timer);
    timer = setTimeout(versturen, 300);
  }

  function huidig(){
    var s = appState();
    if(s) return zonderLokaal(JSON.parse(JSON.stringify(s)));
    try{ return geheugen ? zonderLokaal(JSON.parse(geheugen)) : null; }catch(e){ return null; }
  }

  function versturen(){
    timer = null;
    if(bezig){ opnieuw = true; return; }
    var nu = huidig();
    if(!nu) return;
    var patch = M.verschil(gesynct || {}, nu);
    if(!patch){ return; }
    bezig = true;
    fetch('/api/wijzig', {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
      body:JSON.stringify({basis:versie, toestel:toestel, patch:patch})})
      .then(function(r){ if(r.status === 401){ location.reload(); throw new Error('geen toegang'); } if(!r.ok) throw new Error('status ' + r.status); return r.json(); })
      .then(function(r){
        gesynct = nu;
        ontvang(r);
        status(true);
      })
      .catch(function(){ status(false); setTimeout(planVersturen, Math.min(30000, 2000 * fouten)); })
      .then(function(){ bezig = false; if(opnieuw){ opnieuw = false; planVersturen(); } });
  }

  // Verwerkt wijzigingen van andere toestellen.
  function ontvang(r){
    var s = appState();
    var veranderd = false;
    if(r.volledig !== undefined && r.volledig !== null){
      var cur = s ? zonderLokaal(JSON.parse(JSON.stringify(s))) : gesynct;
      var p = M.verschil(cur, r.volledig);
      gesynct = M.clone(r.volledig);
      if(p && s){ M.toepassen(s, p); veranderd = true; }
    } else if(r.patches && r.patches.length){
      r.patches.forEach(function(p){
        gesynct = M.toepassen(gesynct || {}, p);
        if(s) M.toepassen(s, p);
      });
      veranderd = true;
    }
    versie = r.versie;
    try{ origSet.call(opslag, 'cm_versie', String(versie)); }catch(e){}
    if(veranderd && s){
      geheugen = JSON.stringify(s);
      try{ origSet.call(opslag, SLEUTEL, geheugen); }catch(e){}
      hertekenen();
    }
  }

  var wachtOpBlur = false;
  function hertekenen(){
    var a = document.activeElement;
    var typt = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
    if(typt || document.querySelector('dialog[open]')){
      if(!wachtOpBlur){ wachtOpBlur = true; document.addEventListener('focusout', function f(){ document.removeEventListener('focusout', f); wachtOpBlur = false; setTimeout(hertekenen, 50); }); }
      return;
    }
    try{
      var login = document.getElementById('login');
      if(login && !login.hidden && login.style.display !== 'none' && typeof renderLogin === 'function') renderLogin(); // eslint-disable-line no-undef
      else if(typeof renderMain === 'function') renderMain(); // eslint-disable-line no-undef
    }catch(e){ console.warn('Hertekenen mislukt', e); }
  }

  function ophalen(){
    if(bezig || timer) return;
    fetch('/api/wijzigingen?sinds=' + versie + '&toestel=' + encodeURIComponent(toestel), {credentials:'same-origin', cache:'no-store'})
      .then(function(r){ if(r.status === 401){ location.reload(); throw new Error('geen toegang'); } if(!r.ok) throw new Error('status ' + r.status); return r.json(); })
      .then(function(r){ if(!bezig && !timer) ontvang(r); status(true); })
      .catch(function(){ status(false); });
  }

  // ---- Verbindingsmelding ----
  var balk;
  function status(ok){
    if(ok){ fouten = 0; if(!verbonden){ verbonden = true; planVersturen(); } if(balk) balk.hidden = true; return; }
    fouten++; verbonden = false;
    if(!balk){
      balk = document.createElement('div');
      balk.setAttribute('role', 'status');
      balk.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;background:#9A2F2F;color:#fff;padding:8px 12px;border-radius:8px;font:13px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);max-width:calc(100vw - 24px)';
      balk.textContent = 'Geen verbinding met de server. Je wijzigingen worden bewaard zodra de verbinding terug is.';
      document.body.appendChild(balk);
    }
    balk.hidden = false;
  }

  function lus(){
    ophalen();
    setTimeout(lus, document.hidden ? 30000 : 4000);
  }
  document.addEventListener('visibilitychange', function(){ if(!document.hidden) ophalen(); });
  window.addEventListener('online', function(){ planVersturen(); ophalen(); });
  window.addEventListener('load', function(){
    if(!verbonden) status(false);
    planVersturen(); // ook de migraties die de app bij het laden deed, gaan naar de server
    setTimeout(lus, 4000);
  });

  // ---- Wat op claude.ai door Claude geregeld werd, doet hier de browser of de server ----
  function blobVan(data){
    if(data instanceof Blob) return data;
    if(data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new Blob([data]);
    return new Blob([typeof data === 'string' ? data : JSON.stringify(data)], {type:'text/plain;charset=utf-8'});
  }
  var downloads = {
    save: function(o){
      var url = URL.createObjectURL(blobVan(o.data));
      var a = document.createElement('a');
      a.href = url; a.download = o.filename || 'bestand';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 10000);
      return Promise.resolve({status:'saved'});
    }
  };
  function base64(file){
    return new Promise(function(ok, fout){
      var r = new FileReader();
      r.onload = function(){ ok(String(r.result).split(',')[1]); };
      r.onerror = fout;
      r.readAsDataURL(file);
    });
  }
  var aiBeschikbaar = null;
  function aiStatus(){
    if(!aiBeschikbaar) aiBeschikbaar = fetch('/api/ai', {credentials:'same-origin'}).then(function(r){ return r.json(); }).then(function(j){ return !!j.beschikbaar; }).catch(function(){ return false; });
    return aiBeschikbaar;
  }
  var TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  var sample = {
    limits: function(){ return Promise.resolve({images:{mediaTypes:TYPES}}); },
    json: function(prompt, opts){
      opts = opts || {};
      var beelden = (opts.images || []).filter(function(f){ return TYPES.indexOf(f.type) >= 0; });
      if((opts.images || []).length && !beelden.length) return Promise.reject(Object.assign(new Error('foto'), {code:'image_rejected'}));
      return Promise.all(beelden.map(base64)).then(function(data){
        return fetch('/api/ai', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({prompt:prompt, tier:opts.modelTier, images:beelden.map(function(f, i){ return {mediaType:f.type, data:data[i]}; })})});
      }).then(function(r){ return r.json().then(function(j){ if(!r.ok) throw Object.assign(new Error(j.fout || 'AI-fout'), {code:j.code}); return j.data; }); });
    }
  };
  // Claude-taken (webshop vullen, bestelstatus, prijzen) start de server; Gmail bestaat hier niet.
  var koppelingen = null;
  function koppelingenLaden(){
    if(!koppelingen) koppelingen = fetch('/api/koppelingen', {credentials:'same-origin'}).then(function(r){ return r.json(); }).catch(function(){ return {}; });
    return koppelingen;
  }
  var mcp = {
    gmail: false,
    callTool: function(server, tool, args){
      if(server === 'Gmail'){
        if(tool === 'search_threads') return Promise.resolve({payload:{threads:[]}});
        return Promise.reject(Object.assign(new Error('Mailen via Gmail kan enkel in de claude.ai-versie.'), {code:'tool_error'}));
      }
      if(tool !== 'fire_trigger') return Promise.reject(Object.assign(new Error('Niet beschikbaar op de server.'), {code:'server_not_found'}));
      return fetch('/api/taak-starten', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify(args || {})})
        .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw Object.assign(new Error(j.fout || 'Starten mislukt'), {code:j.code || 'tool_error'}); return {payload:j}; }); });
    }
  };
  var dbShim = {
    collection: function(naam){
      return {get: function(){
        if(naam !== 'bonstatus') return Promise.resolve({docs:[]});
        return fetch('/api/bonstatus', {credentials:'same-origin', cache:'no-store'}).then(function(r){ return r.json(); }).then(function(o){
          return {docs:Object.keys(o).map(function(id){ return {id:id, data:function(){ return o[id]; }}; })};
        });
      }};
    }
  };
  window.claude = {
    use: function(naam){
      if(naam === 'downloads') return Promise.resolve(downloads);
      if(naam === 'sample') return aiStatus().then(function(ok){ return ok ? sample : null; });
      if(naam === 'db') return Promise.resolve(dbShim);
      if(naam === 'mcp') return koppelingenLaden().then(function(k){ return (k.webshop || k.bestelstatus || k.prijzen) ? mcp : null; });
      return Promise.resolve(null);
    }
  };
})();

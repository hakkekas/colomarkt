// Verschillen tussen twee versies van de app-gegevens berekenen en toepassen.
// Wordt zowel door de server (Node) als door de browser (sync.js) gebruikt.
// Lijsten met een "id" per item worden per item samengevoegd, zodat twee
// toestellen tegelijk iets kunnen toevoegen of wijzigen zonder elkaars werk te overschrijven.
(function(root){
  function isObj(x){ return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function clone(x){ return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function sleutel(x){ return isObj(x) && x.id !== undefined && x.id !== null ? String(x.id) : null; }

  function idLijst(a){
    if(!Array.isArray(a)) return false;
    const gezien = new Set();
    for(const x of a){
      const k = sleutel(x);
      if(k === null || gezien.has(k)) return false;
      gezien.add(k);
    }
    return true;
  }

  function gelijk(a, b){
    if(a === b) return true;
    if(a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if(Array.isArray(a) !== Array.isArray(b)) return false;
    if(Array.isArray(a)){
      if(a.length !== b.length) return false;
      for(let i = 0; i < a.length; i++) if(!gelijk(a[i], b[i])) return false;
      return true;
    }
    const ka = Object.keys(a), kb = Object.keys(b);
    if(ka.length !== kb.length) return false;
    for(const k of ka){
      if(!Object.prototype.hasOwnProperty.call(b, k) || !gelijk(a[k], b[k])) return false;
    }
    return true;
  }

  // Geeft undefined als a en b gelijk zijn, anders een patch.
  //   {t:'s', v}                     waarde vervangen
  //   {t:'o', set, del}              object: sleutels wijzigen of wissen
  //   {t:'a', upd, add, del, order}  lijst met id's: per item
  //   {t:'p', items}                 lijst zonder id's waar enkel achteraan iets bijkwam
  function verschil(a, b){
    if(gelijk(a, b)) return undefined;
    if(isObj(a) && isObj(b)){
      const set = {}, del = [];
      for(const k of Object.keys(b)){
        if(!Object.prototype.hasOwnProperty.call(a, k)){ if(b[k] !== undefined) set[k] = {t:'s', v:b[k]}; }
        else { const d = verschil(a[k], b[k]); if(d !== undefined) set[k] = d; }
      }
      for(const k of Object.keys(a)) if(!Object.prototype.hasOwnProperty.call(b, k)) del.push(k);
      return {t:'o', set, del};
    }
    if(Array.isArray(a) && Array.isArray(b)){
      if(idLijst(a) && idLijst(b)){
        const oud = new Map(a.map(x => [sleutel(x), x]));
        const upd = {}, add = [], order = [], inB = new Set();
        for(const x of b){
          const k = sleutel(x);
          order.push(k); inB.add(k);
          if(oud.has(k)){ const d = verschil(oud.get(k), x); if(d !== undefined) upd[k] = d; }
          else add.push(x);
        }
        const del = [];
        for(const k of oud.keys()) if(!inB.has(k)) del.push(k);
        const p = {t:'a', upd, add, del};
        const verwacht = a.map(sleutel).filter(k => inB.has(k)).concat(add.map(sleutel));
        if(verwacht.length !== order.length || verwacht.some((k, i) => k !== order[i])) p.order = order;
        return p;
      }
      if(b.length > a.length && gelijk(a, b.slice(0, a.length))) return {t:'p', items:b.slice(a.length)};
    }
    return {t:'s', v:b};
  }

  // Past een patch toe. Wijzigt cur waar mogelijk ter plaatse en geeft de nieuwe waarde terug.
  function toepassen(cur, p){
    if(!p) return cur;
    if(p.t === 's') return clone(p.v);
    if(p.t === 'o'){
      const o = isObj(cur) ? cur : {};
      for(const k of Object.keys(p.set || {})) o[k] = toepassen(o[k], p.set[k]);
      for(const k of (p.del || [])) delete o[k];
      return o;
    }
    if(p.t === 'p'){
      const arr = Array.isArray(cur) ? cur : [];
      for(const x of clone(p.items || [])) arr.push(x);
      return arr;
    }
    if(p.t === 'a'){
      const arr = Array.isArray(cur) ? cur : [];
      const del = new Set(p.del || []);
      const map = new Map();
      for(const x of arr){ const k = sleutel(x); if(k !== null) map.set(k, x); }
      for(const k of Object.keys(p.upd || {})) if(map.has(k)) map.set(k, toepassen(map.get(k), p.upd[k]));
      for(const x of clone(p.add || [])) map.set(sleutel(x), x);
      let uit;
      if(p.order){
        const inOrder = new Set(p.order);
        uit = p.order.filter(k => map.has(k) && !del.has(k)).map(k => map.get(k));
        // Items die intussen door een ander toestel zijn toegevoegd, blijven op hun plaats staan.
        arr.forEach((x, i) => {
          const k = sleutel(x);
          if(k === null) uit.splice(Math.min(i, uit.length), 0, x);
          else if(!inOrder.has(k) && !del.has(k)) uit.splice(Math.min(i, uit.length), 0, map.get(k));
        });
      } else {
        uit = []; const gezien = new Set();
        for(const x of arr){
          const k = sleutel(x);
          if(k === null){ uit.push(x); continue; }
          if(del.has(k) || gezien.has(k)) continue;
          gezien.add(k); uit.push(map.get(k));
        }
        for(const x of (p.add || [])){
          const k = sleutel(x);
          if(!gezien.has(k) && !del.has(k)){ gezien.add(k); uit.push(map.get(k)); }
        }
      }
      arr.length = 0;
      for(const x of uit) arr.push(x);
      return arr;
    }
    return cur;
  }

  const api = {verschil, toepassen, gelijk, clone};
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ColoMerge = api;
})(typeof window !== 'undefined' ? window : this);

// Controleert dat wijzigingen van twee toestellen samen bewaard blijven. Starten met: node test/merge.test.js
const assert = require('assert');
const {verschil, toepassen, clone, gelijk} = require('../lib/merge');

const basis = {orders:[{id:'o1', status:'ingediend'}], activity:[{tekst:'a'}], products:[{id:'p1', qty:5}, {id:'p2', qty:1}], budget:{k:1}};

// Toestel A voegt een bestelling toe en wijzigt voorraad p1; toestel B voegt ook een bestelling toe en wijzigt p2.
const a = clone(basis); a.orders.push({id:'o2', status:'ingediend'}); a.products[0].qty = 4; a.activity.push({tekst:'A'});
const b = clone(basis); b.orders.unshift({id:'o3', status:'ingediend'}); b.products[1].qty = 9; b.activity.push({tekst:'B'}); b.budget.k = 2;

const server = clone(basis);
toepassen(server, verschil(basis, a));
toepassen(server, verschil(basis, b));
assert.deepStrictEqual(server.orders.map(o => o.id).sort(), ['o1', 'o2', 'o3']);
assert.strictEqual(server.products.find(p => p.id === 'p1').qty, 4);
assert.strictEqual(server.products.find(p => p.id === 'p2').qty, 9);
assert.deepStrictEqual(server.activity.map(x => x.tekst), ['a', 'A', 'B']);
assert.strictEqual(server.budget.k, 2);

// Verwijderen en volgorde.
const c = clone(server); c.orders = c.orders.filter(o => o.id !== 'o1').reverse();
const s2 = clone(server); toepassen(s2, verschil(server, c));
assert.ok(gelijk(s2, c));

// Toepassen gebeurt ter plaatse, zodat de app dezelfde objecten houdt.
const ref = s2.orders;
toepassen(s2, verschil(s2, Object.assign(clone(s2), {orders:[...clone(s2.orders), {id:'o9'}]})));
assert.strictEqual(s2.orders, ref);
assert.strictEqual(ref.length, 3);

// Willekeurige test: diff + toepassen geeft altijd exact het doel.
for(let i = 0; i < 2000; i++){
  const x = willekeurig(3), y = willekeurig(3);
  const r = toepassen(clone(x), verschil(x, y));
  assert.ok(gelijk(r === undefined ? x : r, y), JSON.stringify({x, y}));
}
function willekeurig(d){
  const r = Math.random();
  if(d === 0 || r < 0.2) return [1, 'a', null, true, 2.5][Math.floor(Math.random() * 5)];
  if(r < 0.5){ const o = {}; for(const k of ['a', 'b', 'c']) if(Math.random() < 0.6) o[k] = willekeurig(d - 1); return o; }
  if(r < 0.75){ const ids = ['1', '2', '3', '4'].filter(() => Math.random() < 0.6).sort(() => Math.random() - 0.5); return ids.map(id => ({id, v:willekeurig(d - 1)})); }
  return Array.from({length:Math.floor(Math.random() * 4)}, () => willekeurig(d - 1));
}
console.log('Alle samenvoegtests geslaagd.');

'use strict';
/* Pantry Prep: shared recipes + weekly H-E-B shopping list.
   Data lives in Supabase (shared by the household) or, before setup, in this browser only. */

const CFG = window.RECIPE_BOX_CONFIG || {};
/* Bump together with version.json and the ?v= numbers in index.html on every publish. */
const APP_VERSION = 11;
const CACHE_KEY = 'recipe-box-cache-v1';
const LOCAL_KEY = 'recipe-box-local-v1';

const S = {
  ready: false, user: null, notMember: false, authMsg: null,
  recipes: [], prices: {}, list: emptyList(),
  view: 'recipes', openId: null, q: '',
  import: null, editing: null, confirm: null, matching: null, editRecipe: false,
  showHave: false, pasteOpen: false,
  households: {}, pantry: readPref('pantry') || 'all', renaming: false,
  category: null,          // null = every category, NONE = uncategorized, else a category name
  settingCat: false, renamingCat: false,
};
const NONE = '__none__';
function readPref(k) { try { return localStorage.getItem('recipe-box-' + k); } catch { return null; } }
function writePref(k, v) { try { localStorage.setItem('recipe-box-' + k, v); } catch {} }
const doneSteps = new Set();
function emptyList() { return { recipes: {}, checked: {}, have: {}, qty: {}, extras: [] }; }

/* ---------------- helpers ---------------- */
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const safeUrl = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const clone = o => JSON.parse(JSON.stringify(o));
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600); }
function fmtMinutes(m) { m = Number(m) || 0; if (!m) return ''; const h = Math.floor(m / 60), r = m % 60; return h ? `${h} hr${r ? ` ${r} min` : ''}` : `${r} min`; }
function cacheSave() { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ recipes: S.recipes, prices: S.prices, list: S.list, households: S.households })); } catch {} }
function cacheLoad() { try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); if (c) { S.recipes = c.recipes || []; S.prices = c.prices || {}; S.list = { ...emptyList(), ...(c.list || {}) }; S.households = c.households || {}; } } catch {} }

/* ---------------- storage: Supabase or this-device-only ---------------- */
const Remote = {
  client: null,
  enabled: () => !!(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase),
  async init() {
    this.client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
    // Fires once at start with the saved session (if any), then on every sign-in / sign-out.
    this.client.auth.onAuthStateChange((_e, session) => {
      const before = S.user && S.user.id;
      S.user = (session && session.user) || null;
      if (S.user && S.user.id !== before) setTimeout(startSession, 0);
      if (!S.user) { S.ready = true; render(); }
    });
  },
  subscribed: false,
  async loadAll() {
    const c = this.client;
    const [r, p, l] = await Promise.all([
      c.from('recipes').select('id,data,created_at').order('created_at', { ascending: false }),
      c.from('prices').select('key,data'),
      this.listQuery(),
    ]);
    for (const x of [r, p, l]) if (x.error) throw x.error;
    const hh = await c.from('households').select('household,label');   // missing before update 3: ignore
    S.households = hh.error ? {} : Object.fromEntries(hh.data.map(x => [x.household, x.label]));
    S.recipes = r.data.map(x => ({ id: x.id, ...x.data, createdAt: x.created_at }));
    S.prices = Object.fromEntries(p.data.map(x => [x.key, x.data]));
    S.list = { ...emptyList(), ...((l.data && l.data.data) || {}) };
  },
  async isMember() {
    const { data, error } = await this.client.rpc('is_household');
    // Each household has its own weekly list. Before the households update is run, everyone shares the old one.
    const h = await this.client.rpc('my_household');
    this.household = !h.error && h.data ? h.data : null;
    return error ? true : !!data;
  },
  household: null,
  listQuery() {
    return this.household
      ? this.client.from('lists').select('data').eq('household', this.household).maybeSingle()
      : this.client.from('shopping_list').select('data').eq('id', 1).maybeSingle();
  },
  listRow(data) {
    const updated_at = new Date().toISOString();
    return this.household ? this.client.from('lists').upsert({ household: this.household, data, updated_at })
      : this.client.from('shopping_list').upsert({ id: 1, data, updated_at });
  },
  subscribe(onChange) {
    if (this.subscribed) return;
    this.subscribed = true;
    let t;
    const bump = () => { clearTimeout(t); t = setTimeout(onChange, 300); };
    this.client.channel('recipe-box')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recipes' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'prices' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'households' }, bump)
      .on('postgres_changes', this.household
        ? { event: '*', schema: 'public', table: 'lists', filter: `household=eq.${this.household}` }
        : { event: '*', schema: 'public', table: 'shopping_list' }, bump)
      .subscribe();
  },
  async addRecipe(data) {
    const { data: row, error } = await this.client.from('recipes').insert({ data }).select('id').single();
    if (error) throw error; return row.id;
  },
  async updateRecipe(id, data) {
    const { error } = await this.client.from('recipes').update({ data, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
  },
  async deleteRecipe(id) { const { error } = await this.client.from('recipes').delete().eq('id', id); if (error) throw error; },
  async setHouseholdName(household, label) {
    const { error } = await this.client.from('households').upsert({ household, label });
    if (error) throw error;
  },
  async setPrice(key, data) {
    const { error } = await this.client.from('prices').upsert({ key, data, updated_at: new Date().toISOString() });
    if (error) throw error;
  },
  /* Apply queued list changes on top of the newest copy, so two phones don't overwrite each other. */
  async writeList(ops) {
    const { data, error } = await this.listQuery();
    if (error) throw error;
    const next = { ...emptyList(), ...((data && data.data) || {}) };
    ops.forEach(fn => fn(next));
    const { error: e2 } = await this.listRow(next);
    if (e2) throw e2;
    return next;
  },
  async importUrl(url) {
    const { data, error } = await this.client.functions.invoke('import-recipe', { body: { url } });
    if (error) {
      let code = 'failed';
      try { const body = await error.context.json(); code = body.error || code; } catch {}
      throw { code };
    }
    return data;
  },
  async signIn(email, password) { const { error } = await this.client.auth.signInWithPassword({ email, password }); if (error) throw error; },
  async signUp(email, password) {
    const { data, error } = await this.client.auth.signUp({ email, password, options: { emailRedirectTo: location.href.split('#')[0] } });
    if (error) throw error; return !!data.session;
  },
  async signOut() { await this.client.auth.signOut(); },
};

const Local = {
  read() { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null') || { recipes: [], prices: {}, list: emptyList() }; } catch { return { recipes: [], prices: {}, list: emptyList() }; } },
  write(d) { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(d)); } catch {} },
  async loadAll() { const d = this.read(); S.recipes = d.recipes; S.prices = d.prices; S.list = { ...emptyList(), ...d.list }; S.households = d.households || {}; },
  async addRecipe(data) { const d = this.read(); const id = uid(); d.recipes.unshift({ id, ...data, createdAt: new Date().toISOString() }); this.write(d); return id; },
  async updateRecipe(id, data) { const d = this.read(); d.recipes = d.recipes.map(r => r.id === id ? { id, ...data, createdAt: r.createdAt } : r); this.write(d); },
  async deleteRecipe(id) { const d = this.read(); d.recipes = d.recipes.filter(r => r.id !== id); this.write(d); },
  async setPrice(key, data) { const d = this.read(); d.prices[key] = data; this.write(d); },
  async setHouseholdName(household, label) { const d = this.read(); d.households = { ...(d.households || {}), [household]: label }; this.write(d); S.households = d.households; },
  async writeList(ops) { const d = this.read(); const next = { ...emptyList(), ...d.list }; ops.forEach(fn => fn(next)); d.list = next; this.write(d); return next; },
  async importUrl() { throw { code: 'needs_setup' }; },
};
let Store = Local;

/* ---------------- price book + ingredient math ---------------- */
/* Stores. Built-in prices are H-E-B estimates; other stores start from those times a rough
   factor until you correct an item there (corrections are saved per store as "store|item"). */
const STORES = {
  heb:     { name: 'H-E-B',      factor: 1,    search: 'https://www.heb.com/search?q=' },
  walmart: { name: 'Walmart',    factor: 0.93, search: 'https://www.walmart.com/search?q=' },
  kroger:  { name: 'Kroger',     factor: 1.03, search: 'https://www.kroger.com/search?query=' },
  sams:    { name: "Sam's Club", factor: 0.85, search: 'https://www.samsclub.com/s/' },
  costco:  { name: 'Costco',     factor: 0.85, search: 'https://www.costco.com/CatalogSearch?keyword=' },
};
const currentStore = () => (STORES[S.list.store] ? S.list.store : 'heb');
const storeName = (s = currentStore()) => STORES[s].name;
const priceKey = (key, store = currentStore()) => (store === 'heb' ? key : `${store}|${key}`);
let STORE_PRICES = {};
function storeEntry(e, store) {
  if (!e || store === 'heb') return e;
  const o = STORE_PRICES[store] && STORE_PRICES[store][e.key];
  if (o) {
    const size = o.size != null && o.size !== '' ? o.size : e.size;
    return { ...e, price: Number(o.price) || 0, size, by: o.by || e.by, per: size === e.size ? e.per : {}, yours: true };
  }
  return { ...e, price: Math.round(e.price * STORES[store].factor * 100) / 100, yours: false };
}

let ENTRIES = new Map();
function rebuildEntries() {
  ENTRIES = new Map(PRICE_BOOK.map(e => [e.key, e]));
  STORE_PRICES = {};
  for (const [pk, d] of Object.entries(S.prices)) {
    const bar = pk.indexOf('|');
    if (bar > 0 && STORES[pk.slice(0, bar)]) {
      const store = pk.slice(0, bar), key = pk.slice(bar + 1);
      (STORE_PRICES[store] = STORE_PRICES[store] || {})[key] = d;
      // An item first priced at another store still needs a base entry so it can be matched.
      if (!ENTRIES.has(key) && !S.prices[key]) ENTRIES.set(key, { key, names: [key], aisle: d.aisle || guessAisle(key), size: '', price: 0, by: d.by || 'pk', pantry: false, per: {}, lbEach: 0, product: '', yours: false });
      continue;
    }
    const key = pk;
    const base = ENTRIES.get(key);
    ENTRIES.set(key, {
      key, names: [...new Set([...(base ? base.names : [key]), ...(d.names || [])])],
      aisle: d.aisle || (base ? base.aisle : guessAisle(key)), size: d.size ?? (base ? base.size : ''),
      price: Number(d.price) || 0, by: d.by || (base ? base.by : 'pk'), pantry: base ? base.pantry : !!d.pantry,
      per: base ? base.per : {}, lbEach: base ? base.lbEach : 0, product: d.product || '', yours: true,
    });
  }
  buildMatchIndex([...ENTRIES.values()]);
  resolveCache.clear();
}
const resolveCache = new Map();
function resolve(ing, store = currentStore()) {
  const ck = ing.raw + '|' + (ing.key || '') + '|' + store;
  if (resolveCache.has(ck)) return resolveCache.get(ck);
  const p = parseIngredient(ing.raw);
  if (ing.key) p.key = p.full = ing.key;
  const e = storeEntry(ing.key && ENTRIES.has(ing.key) ? ENTRIES.get(ing.key) : (matchEntry(p.full) || matchEntry(p.key)), store);
  const r = {
    p, e, itemKey: e ? e.key : p.key, aisle: e ? e.aisle : guessAisle(p.key), pantry: e ? e.pantry : false,
    buy: e ? amountToBuy(p, e) : 1, price: e ? e.price : 0,
  };
  r.cost = r.buy * r.price;
  resolveCache.set(ck, r);
  return r;
}
/* ---------------- pantries (each household's recipes) ---------------- */
const myHousehold = () => (Store === Remote && Remote.household) || 'home';
const recipeHousehold = r => r.household || 'home';
const pantryLabel = h => S.households[h] || (h === 'home' ? 'Home' : h.charAt(0).toUpperCase() + h.slice(1));
function pantries() {
  const ids = new Set([myHousehold(), ...Object.keys(S.households), ...S.recipes.map(recipeHousehold)]);
  const mine = myHousehold();
  return [...ids].sort((a, b) => (a === mine ? -1 : b === mine ? 1 : pantryLabel(a).localeCompare(pantryLabel(b))))
    .map(id => ({ id, label: pantryLabel(id), mine: id === mine, count: S.recipes.filter(r => recipeHousehold(r) === id).length }));
}

/* Categories inside a pantry (BBQ, Sandwiches…): one per recipe, made up by you. */
const recipeCategory = r => String(r.category || '').trim();
const inPantryScope = (r, pantry) => pantry === 'all' || recipeHousehold(r) === pantry;
function categoriesFor(pantry) {
  const counts = new Map(); let none = 0;
  for (const r of S.recipes) {
    if (!inPantryScope(r, pantry)) continue;
    const c = recipeCategory(r);
    if (!c) { none++; continue; }
    const k = c.toLowerCase(), cur = counts.get(k);
    counts.set(k, { name: cur ? cur.name : c, count: (cur ? cur.count : 0) + 1 });   // "bbq" and "BBQ" are one category
  }
  return { cats: [...counts.values()].sort((a, b) => a.name.localeCompare(b.name)), none };
}
// Adding a recipe while looking at one of your categories files it there.
const newRecipeCategory = () => (S.category && S.category !== NONE && (S.pantry === myHousehold() || S.pantry === 'all') ? S.category : '');
const catMatches = r => S.category == null || (S.category === NONE ? !recipeCategory(r) : recipeCategory(r).toLowerCase() === S.category.toLowerCase());

const recipeCost = r => (r.ingredients || []).reduce((s, i) => s + resolve(i).cost, 0);
const recipeById = id => S.recipes.find(r => r.id === id);

function buildList(store = currentStore()) {
  const agg = new Map();
  for (const [rid, sel] of Object.entries(S.list.recipes || {})) {
    const r = recipeById(rid); if (!r) continue;
    const mult = Number(sel && sel.mult) || 1;
    for (const ing of r.ingredients || []) {
      const x = resolve(ing, store);
      if (!x.itemKey) continue;
      let a = agg.get(x.itemKey);
      if (!a) agg.set(x.itemKey, a = { key: x.itemKey, e: x.e, aisle: x.aisle, pantry: x.pantry, need: 0, uses: new Set() });
      a.need += x.buy * mult;
      a.uses.add(r.title);
    }
  }
  const items = [...agg.values()].map(a => {
    const e = a.e;
    const byLb = e && e.by === 'lb';
    let qty = byLb ? Math.max(0.1, Math.round(a.need * 10) / 10) : Math.max(1, Math.ceil(a.need - 0.05));
    const manual = S.list.qty[a.key];
    if (manual != null) qty = manual;
    const price = e ? e.price : 0;
    const have = S.list.have[a.key] != null ? !!S.list.have[a.key] : a.pantry;
    return { ...a, name: e ? e.key : a.key, product: e && e.product, size: e ? e.size : '', byLb, price, qty, manual: manual != null,
      cost: price * qty, have, got: !!S.list.checked[a.key], estimate: !(e && e.yours), priced: !!(e && (e.price || e.yours)) };
  });
  for (const x of S.list.extras || []) {
    const k = 'x:' + x.id;
    items.push({ key: k, extraId: x.id, name: x.name, aisle: 'Other', uses: new Set(), price: Number(x.price) || 0, qty: 1, cost: Number(x.price) || 0,
      have: false, got: !!S.list.checked[k], extra: true, estimate: false, priced: true, size: '' });
  }
  return items;
}

/* ---------------- writes ---------------- */
let listOps = [], listTimer = null, listBusy = false;
function changeList(fn) {
  const next = clone(S.list); fn(next); S.list = next; cacheSave(); render();
  listOps.push(fn); clearTimeout(listTimer); listTimer = setTimeout(flushList, 500);
}
async function flushList() {
  if (listBusy || !listOps.length) return;
  listBusy = true;
  const ops = listOps; listOps = [];
  try { S.list = await Store.writeList(ops); cacheSave(); render(); }
  catch (e) {
    listOps = ops.concat(listOps);
    if (navigator.onLine) toast("Couldn't save the list. It'll retry when you're back online.");
  }
  listBusy = false;
  if (listOps.length) listTimer = setTimeout(flushList, 1500);
}
window.addEventListener('online', () => flushList());
async function safely(p, okMsg) {
  try { const r = await p; if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(e && e.message ? `Couldn't save: ${e.message}` : "Couldn't save that. Check your connection."); throw e; }
}

/* ---------------- import ---------------- */
async function importFromUrl(url) {
  const existing = S.recipes.find(r => r.sourceUrl && r.sourceUrl === url);
  if (existing) { navTo('r-' + existing.id); toast('You already have this one'); return; }
  S.import = { busy: true, msg: `Reading ${host(url)}…` }; render();
  try {
    const d = await Store.importUrl(url);
    if (!d || !Array.isArray(d.ingredients) || !d.ingredients.length) throw { code: 'no_recipe' };
    const groupsSeen = d.steps || [];
    const data = {
      title: d.title || 'Untitled recipe', sourceUrl: url, summary: d.summary || '', servings: d.servings || '',
      totalMinutes: d.totalMinutes || 0, image: safeUrl(d.image),
      ingredients: d.ingredients.map(raw => ({ raw })), steps: groupsSeen.map(s => ({ group: s.group || '', text: s.text })),
      addedBy: S.user ? S.user.email : '', household: myHousehold(), category: newRecipeCategory(),
    };
    const id = await Store.addRecipe(data);
    S.recipes.unshift({ id, ...data, createdAt: new Date().toISOString() });
    S.import = null; cacheSave(); navTo('r-' + id); toast(`Added “${data.title}”`);
  } catch (e) {
    const c = e && e.code;
    S.import = { err: c === 'needs_setup' ? "Adding from a link starts working once the app is connected to Supabase (see SETUP.md). For now, paste the recipe text below."
      : c === 'no_recipe' ? `Couldn't find a recipe on that page. Open it, copy the recipe text, and paste it below.`
      : c === 'fetch_failed' ? `${host(url)} wouldn't let the app read the page. Copy the recipe text from the site and paste it below.`
      : c === 'bad_url' ? "That doesn't look like a web link. It should start with https://"
      : "Couldn't import that link. Check your connection, or paste the recipe text below.", };
    S.pasteOpen = true;
    render();
  }
}
async function importFromText(text) {
  const t = parseRecipeText(text);
  if (!t.ingredients.length) { S.import = { err: "Couldn't spot the ingredients. Make sure the text includes an “Ingredients” heading or lines that start with amounts." }; render(); return; }
  const data = { title: t.title, sourceUrl: '', summary: '', servings: '', totalMinutes: 0, image: '',
    ingredients: t.ingredients.map(raw => ({ raw })), steps: t.steps.map(text => ({ group: '', text })), addedBy: S.user ? S.user.email : '', household: myHousehold(), category: newRecipeCategory() };
  try {
    const id = await safely(Store.addRecipe(data));
    S.recipes.unshift({ id, ...data, createdAt: new Date().toISOString() });
    S.import = null; cacheSave(); navTo('r-' + id); toast('Added. Check it over and tap Edit to fix anything.');
  } catch {}
}

/* ---------------- render ---------------- */
function render() {
  const n = Object.keys(S.list.recipes || {}).filter(recipeById).length;
  const wc = $('#week-count'); wc.hidden = !n; wc.textContent = n;
  $('#tab-recipes').setAttribute('aria-current', String(S.view !== 'list'));
  $('#tab-list').setAttribute('aria-current', String(S.view === 'list'));
  const banner = $('#banner');
  banner.hidden = Store !== Local;
  banner.textContent = 'Not connected yet: recipes are saved on this device only. Follow SETUP.md to share with your household.';
  $('#account-btn').hidden = !(Store === Remote && S.user);
  renderPicker();
  const app = $('#app');
  const f = document.activeElement, focusId = f && f.id, sel = f && f.selectionStart;
  if (!S.ready) app.innerHTML = `<div class="empty"><h2>Opening Pantry Prep…</h2></div>`;
  else if (Store === Remote && !S.user) app.innerHTML = viewAuth();
  else if (S.notMember) app.innerHTML = viewNotMember();
  else if (S.view === 'list') app.innerHTML = viewList();
  else if (S.view === 'recipe') app.innerHTML = viewRecipe();
  else if (S.view === 'account') app.innerHTML = viewAccount();
  else app.innerHTML = viewRecipes();
  if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); try { if (sel != null) el.setSelectionRange(sel, sel); } catch {} } }
}

/* Phone header: a dropdown of every pantry and its categories (uses the phone's own picker). */
function renderPicker() {
  const box = $('#pantry-picker');
  const show = S.ready && !(Store === Remote && !S.user) && !S.notMember;
  box.hidden = !show;
  if (!show) { box.innerHTML = ''; return; }
  const ps = pantries();
  const val = (p, c) => JSON.stringify([p, c]);
  const current = val(S.pantry, S.category);
  const opt = (v, text) => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(text)}</option>`;
  const allCats = categoriesFor('all');
  let html = `<optgroup label="Everyone">${opt(val('all', null), `All recipes (${S.recipes.length})`)}
    ${allCats.cats.map(c => opt(val('all', c.name), `${c.name} (${c.count})`)).join('')}</optgroup>`;
  for (const p of ps) {
    const { cats, none } = categoriesFor(p.id);
    html += `<optgroup label="${esc(p.label)}${p.mine ? ' (you)' : ''}">
      ${opt(val(p.id, null), `All of ${p.label} (${p.count})`)}
      ${cats.map(c => opt(val(p.id, c.name), `${c.name} (${c.count})`)).join('')}
      ${none && cats.length ? opt(val(p.id, NONE), `No category (${none})`) : ''}</optgroup>`;
  }
  html += `<optgroup label="App">
    <option value="${esc(JSON.stringify(['__reload', null]))}">Reload app (get latest version)</option>
    ${Store === Remote ? `<option value="${esc(JSON.stringify(['__account', null]))}">Account &amp; sign out</option>` : ''}</optgroup>`;
  const cur = ps.find(p => p.id === S.pantry);
  const top = cur ? cur.label : 'Everyone';
  const main = S.category == null ? 'All recipes' : S.category === NONE ? 'No category' : S.category;
  box.innerHTML = `<span class="picker-label"><span class="picker-text"><small>${esc(top)}</small><span>${esc(main)}</span></span><span aria-hidden="true">▾</span></span>
    <select id="pantry-select" aria-label="Pantry and category">${html}</select>`;
}

function viewAuth() {
  const m = S.authMsg;
  return `<form class="auth" id="auth-form">
    <h1>Sign in</h1>
    <p class="muted" style="margin:0">Use the email that's on your household list.</p>
    <label>Email<input type="email" id="auth-email" autocomplete="email" required></label>
    <label>Password<input type="password" id="auth-pass" autocomplete="current-password" minlength="6" required></label>
    <div class="row"><button class="btn primary" type="submit" data-mode="in">Sign in</button>
      <button class="btn" type="submit" data-mode="up">Create account</button></div>
    ${m ? `<div class="status ${m.bad ? 'err' : ''}" role="status">${esc(m.text)}</div>` : ''}
  </form>`;
}
function viewNotMember() {
  return `<div class="empty"><h2>This account isn't on the household list</h2>
    <p class="muted">Signed in as ${esc(S.user && S.user.email)}. Add this email to <b>household_members</b> in Supabase (see SETUP.md), then reload.</p>
    <p><button class="btn" data-act="signout">Sign out</button></p></div>`;
}
function viewAccount() {
  return `<div class="empty"><h2>Account</h2><p class="muted">Signed in as ${esc(S.user && S.user.email)}</p>
    <p><button class="btn" data-act="reload">Reload app</button> <button class="btn" data-act="signout">Sign out</button> <a class="btn ghost" href="#recipes">Back</a></p>
    <p class="note">Version ${APP_VERSION}</p></div>`;
}

function viewImporter() {
  const im = S.import || {};
  const dis = im.busy ? 'disabled' : '';
  return `<section class="adder" aria-label="Add a recipe">
    <form class="adder-row" id="add-form">
      <input type="url" id="add-url" placeholder="Paste a recipe link" ${dis} autocomplete="off" inputmode="url">
      <button class="btn primary" type="submit" ${dis}>Add recipe</button>
    </form>
    <details id="paste-details" ${S.pasteOpen ? 'open' : ''}><summary>Or paste the recipe text</summary>
      <form id="paste-form" style="display:grid;gap:8px">
        <textarea id="add-text" placeholder="Copy the recipe from the website (title, ingredients and instructions) and paste it here." ${dis}></textarea>
        <div><button class="btn" type="submit" ${dis}>Add from text</button></div>
      </form>
    </details>
    ${im.busy ? `<div class="status"><span class="spin" aria-hidden="true"></span><span>${esc(im.msg)}</span></div>` : ''}
    ${im.err ? `<div class="status err" role="alert">${esc(im.err)}</div>` : ''}
  </section>`;
}

function viewRecipes() {
  const q = S.q.trim().toLowerCase();
  const ps = pantries();
  if (S.pantry !== 'all' && !ps.some(p => p.id === S.pantry)) S.pantry = 'all';
  const { cats, none } = categoriesFor(S.pantry);
  if (S.category != null && S.category !== NONE && !cats.some(c => c.name.toLowerCase() === S.category.toLowerCase())) S.category = null;
  if (S.category === NONE && !none) S.category = null;
  const inPantry = S.recipes.filter(r => inPantryScope(r, S.pantry) && catMatches(r));
  const list = inPantry.filter(r => !q || (r.title + ' ' + (r.ingredients || []).map(i => i.raw).join(' ')).toLowerCase().includes(q));
  const cur = ps.find(p => p.id === S.pantry);
  const heading = (cur ? `${cur.label}${cur.mine ? '' : "'s pantry"}` : 'All recipes')
    + (S.category == null ? '' : ` › ${S.category === NONE ? 'No category' : S.category}`);
  let body;
  if (!S.recipes.length) body = `<div class="empty"><h2>No recipes yet</h2><p class="muted">Paste a link from a recipe site above. The app keeps just the ingredients and steps and estimates what they cost at H-E-B.</p></div>`;
  else if (!inPantry.length) body = `<div class="empty"><h2>No recipes here yet</h2><p class="muted">${cur && cur.mine ? 'Recipes you add go in your pantry.' : `When ${esc(cur ? cur.label : 'they')} add recipes, they show up here.`}</p></div>`;
  else if (!list.length) body = `<div class="empty"><h2>Nothing matches “${esc(S.q)}”</h2><p class="muted">Try an ingredient or part of the name.</p></div>`;
  else body = `<div class="grid">${list.map(card).join('')}</div>`;
  return `<div class="with-side">${viewPantries(ps)}
    <div class="side-main">
      ${viewImporter()}
      <div class="toolbar"><h2 class="pantry-title">${esc(heading)}</h2>
        ${inPantry.length > 3 ? `<input type="text" id="search" placeholder="Search recipes or ingredients" value="${esc(S.q)}" autocomplete="off">` : ''}</div>
      ${viewRenameCategory()}${viewRenamePantry(cur)}
      ${!cats.length && S.recipes.length ? `<p class="note">Sort recipes into categories like BBQ or Sandwiches: open a recipe and tap “Add a category”.</p>` : ''}
      ${body}
    </div></div>`;
}

function viewPantries(ps) {
  const item = (id, label, count, extra = '') => `<button class="pantry ${S.pantry === id && S.category == null ? 'on' : ''}" data-act="pantry" data-id="${esc(id)}" aria-pressed="${S.pantry === id}">
      <span>${esc(label)}${extra}</span><span class="num muted">${count}</span></button>${S.pantry === id ? viewCategories() : ''}`;
  return `<aside class="pantries" aria-label="Pantries">
    <h3>Pantries</h3>
    <div class="pantry-list">
      ${item('all', 'All recipes', S.recipes.length)}
      ${ps.map(p => item(p.id, p.label, p.count, p.mine ? ' <span class="you">you</span>' : '')).join('')}
    </div>
  </aside>`;
}

function viewRenamePantry(cur) {
  if (!cur || !cur.mine || S.category != null) return '';
  if (S.renaming) return `<form id="rename-form" class="catline"><input type="text" id="rename-input" value="${esc(cur.label)}" maxlength="40" aria-label="Pantry name">
      <button class="btn sm primary">Save</button><button class="btn sm ghost" type="button" data-act="cancel-rename">Cancel</button></form>`;
  return `<button class="linkish" data-act="rename-pantry">Rename your pantry</button>`;
}

function viewCategories() {
  const { cats, none } = categoriesFor(S.pantry);
  if (!cats.length) return '';
  const sub = (val, label, count) => {
    const on = val === S.category;
    return `<button class="pantry sub ${on ? 'on' : ''}" data-act="category" data-cat="${esc(val)}" aria-pressed="${on}"><span>${esc(label)}</span><span class="num muted">${count}</span></button>`;
  };
  return `<div class="subs" role="group" aria-label="Categories">
    ${cats.map(c => sub(c.name, c.name, c.count)).join('')}
    ${none ? sub(NONE, 'No category', none) : ''}
  </div>`;
}

function viewRenameCategory() {
  if (!S.category || S.category === NONE) return '';
  if (S.renamingCat) return `<form id="cat-rename-form" class="catline"><input type="text" id="cat-rename-input" value="${esc(S.category)}" maxlength="40" aria-label="Category name">
      <button class="btn sm primary">Save</button><button class="btn sm ghost" type="button" data-act="cancel-rename-cat">Cancel</button>
      <span class="note">Leave it blank to take these recipes out of the category.</span></form>`;
  return `<button class="linkish" data-act="rename-cat">Rename category</button>`;
}

function card(r) {
  const on = !!S.list.recipes[r.id];
  const img = safeUrl(r.image);
  return `<article class="card ${on ? 'on' : ''}">
    ${img ? `<a href="#r-${esc(r.id)}" tabindex="-1"><img class="thumb" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"></a>` : ''}
    <div class="body">
      <h3><a href="#r-${esc(r.id)}">${esc(r.title)}</a></h3>
      <div class="meta">${S.pantry === 'all' && pantries().length > 1 ? `<span class="tag">${esc(pantryLabel(recipeHousehold(r)))}</span>` : ''}${r.totalMinutes ? `<span>${fmtMinutes(r.totalMinutes)}</span>` : ''}${r.servings ? `<span>Serves ${esc(r.servings)}</span>` : ''}${r.sourceUrl ? `<span>${esc(host(r.sourceUrl))}</span>` : ''}</div>
      <div class="foot"><span class="cost num">~${money(recipeCost(r))} <span class="muted small" style="font-weight:400">to make</span></span>
        <button class="btn sm ${on ? '' : 'primary'}" data-act="toggle-week" data-id="${esc(r.id)}">${on ? 'In this week ✓' : 'Add to week'}</button></div>
    </div>
  </article>`;
}

function viewRecipe() {
  const r = recipeById(S.openId);
  if (!r) return `<div class="empty"><h2>That recipe isn't here anymore</h2><p><a href="#recipes">Back to recipes</a></p></div>`;
  if (S.editRecipe) return viewEditRecipe(r);
  const on = !!S.list.recipes[r.id];
  let lastGroup = '';
  const ings = (r.ingredients || []).map((i, ix) => {
    let g = '';
    if (i.group && i.group !== lastGroup) { lastGroup = i.group; g = `<li class="group">${esc(i.group)}</li>`; }
    const x = resolve(i);
    const matching = S.matching === ix;
    const match = matching
      ? `<form id="match-form" data-ix="${ix}"><input type="text" id="match-input" value="${esc(x.itemKey)}" placeholder="What to buy, e.g. chicken thighs" list="pb-names"><button class="btn sm primary">Save</button><button class="btn sm ghost" type="button" data-act="cancel-match">Cancel</button></form>
         <datalist id="pb-names">${[...ENTRIES.keys()].map(k => `<option value="${esc(k)}">`).join('')}</datalist>`
      : `Buy: <button data-act="match" data-ix="${ix}">${x.e ? esc(x.itemKey) : `${esc(x.itemKey || '?')} (no price yet)`}</button>`;
    return `${g}<li><span>${esc(i.raw)}</span><span class="c num">${x.cost >= 0.01 ? '~' + money(x.cost) : ''}</span><div class="match">${match}</div></li>`;
  }).join('');
  let n = 0, lastSG = '';
  const steps = (r.steps || []).map((s, ix) => {
    const st = typeof s === 'string' ? { group: '', text: s } : s;
    let g = '';
    if (st.group && st.group !== lastSG) { lastSG = st.group; g = `<li class="sg">${esc(st.group)}</li>`; }
    n++;
    return `${g}<li class="st ${doneSteps.has(r.id + ':' + ix) ? 'done' : ''}" data-act="step" data-ix="${ix}"><b>${n}</b><span>${esc(st.text)}</span></li>`;
  }).join('');
  const confirming = S.confirm === 'delete:' + r.id;
  const img = safeUrl(r.image);
  return `<div class="detail-head">
      <div><a href="#recipes" class="small">← All recipes</a></div>
      ${img ? `<img class="hero-img" src="${esc(img)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      <h1>${esc(r.title)}</h1>
      <div class="meta">${r.totalMinutes ? `<span>${fmtMinutes(r.totalMinutes)}</span>` : ''}${r.servings ? `<span>Serves ${esc(r.servings)}</span>` : ''}
        ${r.sourceUrl ? `<span><a href="${esc(safeUrl(r.sourceUrl))}" target="_blank" rel="noopener">Original on ${esc(host(r.sourceUrl))}</a></span>` : ''}
        <span class="num">About ${money(recipeCost(r))} at ${esc(storeName())} <span class="est">estimate</span></span></div>
      ${viewSetCategory(r)}
      <div class="detail-actions">
        <button class="btn ${on ? '' : 'primary'}" data-act="toggle-week" data-id="${esc(r.id)}">${on ? 'In this week ✓' : "Add to this week's list"}</button>
        <button class="btn ghost" data-act="edit-recipe">Edit</button>
        ${confirming ? `<span class="confirm">Delete this recipe for everyone? <button class="btn sm danger" data-act="delete" data-id="${esc(r.id)}">Delete</button><button class="btn sm ghost" data-act="cancel-confirm">Keep it</button></span>`
          : `<button class="btn ghost" data-act="ask-delete" data-id="${esc(r.id)}">Delete</button>`}
      </div>
    </div>
    <div class="detail">
      <section class="panel"><h2>Ingredients <small>${(r.ingredients || []).length}</small></h2><ul class="ings">${ings}</ul>
        <p class="note" style="margin-top:8px">Tap what's after “Buy” to change which grocery item a line counts as.</p></section>
      <section class="panel"><h2>Steps <small>tap a step to cross it off</small></h2><ol class="steps">${steps}</ol></section>
    </div>`;
}

function viewSetCategory(r) {
  const cat = recipeCategory(r);
  const where = `${pantryLabel(recipeHousehold(r))}`;
  if (!S.settingCat) {
    return `<div class="catline">${cat ? `<span class="tag">${esc(where)} › ${esc(cat)}</span>` : `<span class="muted small">${esc(where)} · no category</span>`}
      <button class="linkish" data-act="set-cat">${cat ? 'Change category' : 'Add a category'}</button></div>`;
  }
  const existing = categoriesFor(recipeHousehold(r)).cats.map(c => c.name);
  return `<form class="catline" id="cat-form">
      <input type="text" id="cat-input" value="${esc(cat)}" placeholder="e.g. BBQ, Sandwiches, Soups" maxlength="40" list="cat-names" aria-label="Category">
      <datalist id="cat-names">${existing.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      <button class="btn sm primary">Save</button><button class="btn sm ghost" type="button" data-act="cancel-set-cat">Cancel</button>
    </form>
    ${existing.length ? `<div class="catline small">${existing.map(c => `<button type="button" class="chipbtn" data-act="pick-cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}`;
}

function viewEditRecipe(r) {
  const steps = (r.steps || []).map(s => (typeof s === 'string' ? s : s.text)).join('\n');
  return `<form class="editform panel" id="edit-form">
    <h2>Edit recipe</h2>
    <label>Name<input type="text" id="ed-title" value="${esc(r.title)}"></label>
    <label>Serves<input type="text" id="ed-serves" value="${esc(r.servings)}" style="max-width:160px"></label>
    <label>Ingredients, one per line<textarea id="ed-ings">${esc((r.ingredients || []).map(i => i.raw).join('\n'))}</textarea></label>
    <label>Steps, one per line<textarea id="ed-steps">${esc(steps)}</textarea></label>
    <div class="detail-actions"><button class="btn primary" type="submit">Save</button><button class="btn ghost" type="button" data-act="cancel-edit-recipe">Cancel</button></div>
  </form>`;
}

function viewList() {
  const sel = Object.entries(S.list.recipes || {}).filter(([id]) => recipeById(id));
  const items = buildList();
  const need = items.filter(i => !i.have), have = items.filter(i => i.have);
  const total = need.reduce((s, i) => s + i.cost, 0);
  const left = need.filter(i => !i.got).length;
  if (!sel.length && !(S.list.extras || []).length) return `<div class="empty"><h2>No recipes picked for this week</h2><p class="muted">Open <a href="#recipes">Recipes</a> and tap “Add to week” on what you want to cook. The list adds up every ingredient, grouped by aisle, with price estimates for H-E-B, Walmart, Kroger, Sam's Club or Costco.</p></div>${extrasBox()}`;
  const chips = sel.map(([id, v]) => { const r = recipeById(id); const m = Number(v && v.mult) || 1; return `<span class="chip"><a href="#r-${esc(id)}">${esc(r.title)}</a>
      <span class="mult"><button data-act="mult" data-id="${esc(id)}" data-d="-1" aria-label="Fewer batches">−</button><span class="num">×${m}</span><button data-act="mult" data-id="${esc(id)}" data-d="1" aria-label="More batches">+</button></span>
      <button class="x" data-act="toggle-week" data-id="${esc(id)}" aria-label="Remove ${esc(r.title)}">✕</button></span>`; }).join('');
  const groups = AISLE_ORDER.map(a => [a, need.filter(i => i.aisle === a)]).filter(([, l]) => l.length);
  const unpriced = need.filter(i => !i.priced).length;
  const newWeek = S.confirm === 'newweek'
    ? `<span class="confirm">Clear this week's recipes and checkmarks for your household? <button class="btn sm danger" data-act="new-week">Clear list</button><button class="btn sm ghost" data-act="cancel-confirm">Cancel</button></span>`
    : `<button class="btn" data-act="ask-new-week">Start a new week</button>`;
  const store = currentStore();
  const totals = Object.keys(STORES).map(s => ({ s, total: s === store ? total : buildList(s).filter(i => !i.have).reduce((t, i) => t + i.cost, 0) }));
  const cheapest = totals.reduce((a, b) => (b.total < a.total ? b : a));
  const picker = `<section class="stores" aria-label="Where are you shopping?">
      <div class="lbl">Shopping at</div>
      <div class="store-row">${totals.map(({ s, total: t }) => `<button class="store ${s === store ? 'on' : ''}" data-act="store" data-id="${s}" aria-pressed="${s === store}">
        <span class="store-name">${esc(STORES[s].name)}</span><span class="num">~${money(t)}</span>${s === cheapest.s && totals.length > 1 ? '<span class="best">lowest</span>' : ''}</button>`).join('')}</div>
    </section>`;
  return `${picker}<section class="summary">
      <div><div class="lbl">Estimated at ${esc(storeName())}</div><div class="big num">${money(total)}</div></div>
      <div><div class="lbl">Items</div><div class="num" style="font-size:18px;font-weight:600">${left} left of ${need.length}</div></div>
      <div class="actions"><button class="btn" data-act="copy">Copy list</button>${newWeek}</div>
    </section>
    <div class="chips">${chips}</div>
    ${unpriced ? `<p class="note">${unpriced} item${unpriced > 1 ? 's have' : ' has'} no price yet, so the total is low. Tap “add price” to fill one in once; it's remembered.</p>` : ''}
    ${groups.map(([a, l]) => `<section class="aisle"><h3>${esc(a)}</h3><div class="rows">${l.map(row).join('')}</div></section>`).join('')}
    ${extrasBox()}
    ${have.length ? `<section class="aisle"><h3>Already have at home (${have.length}) <button class="linkish" data-act="toggle-have-list">${S.showHave ? 'hide' : 'show'}</button></h3>
      ${S.showHave ? `<div class="rows">${have.map(row).join('')}</div>` : `<p class="note">Staples like salt and oil start here and aren't in the total. Move anything back if you're out.</p>`}</section>` : ''}
    <p class="note">${store === 'heb'
      ? 'Prices marked EST are built-in estimates of regular H-E-B shelf prices; your store and sales will differ.'
      : `Prices marked EST are rough guesses based on H-E-B prices${store === 'sams' || store === 'costco' ? `, for the same amount. ${esc(storeName())} sells bigger packs, so your receipt total will be higher, though it costs less per ounce` : ''}.`}
      Tap a price to correct it for ${esc(storeName())}, and your price is used everywhere from then on.</p>`;
}

function row(i) {
  const qtyTxt = i.extra ? '' : i.byLb ? `≈ ${i.qty} lb` : `${i.qty} × ${esc(i.size || 'each')}`;
  const forTxt = i.uses.size ? 'for ' + [...i.uses].join(', ') : '';
  const enc = encodeURIComponent(i.key);
  let edit = '';
  if (S.editing === i.key) {
    const e = i.e || {};
    edit = `<form class="editor" id="price-form" data-key="${esc(i.key)}">
      ${i.extra ? '' : `<label>Package<input type="text" id="pe-size" value="${esc(i.size)}" placeholder="16 oz"></label>
      <label>Sold<select id="pe-by"><option value="pk" ${(!e.by || e.by === 'pk') ? 'selected' : ''}>per package</option><option value="ea" ${e.by === 'ea' ? 'selected' : ''}>each</option><option value="lb" ${e.by === 'lb' ? 'selected' : ''}>per lb</option></select></label>`}
      <label>Price<input type="number" step="0.01" min="0" inputmode="decimal" id="pe-price" value="${i.price ? i.price.toFixed(2) : ''}"></label>
      ${i.extra ? '' : `<label>Aisle<select id="pe-aisle">${AISLE_ORDER.map(a => `<option ${a === i.aisle ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
      <label>How many<span class="stepper"><button type="button" data-act="qty" data-key="${esc(i.key)}" data-d="-1">−</button><span class="num">${i.qty}</span><button type="button" data-act="qty" data-key="${esc(i.key)}" data-d="1">+</button></span></label>`}
      <button class="btn sm primary" type="submit">Save</button><button class="btn sm ghost" type="button" data-act="cancel-price">Cancel</button>
      ${i.extra ? `<button class="btn sm ghost danger" type="button" data-act="drop-extra" data-id="${esc(i.extraId)}">Remove</button>` : ''}
    </form>`;
  }
  return `<div class="row ${i.got ? 'got' : ''}">
    <input type="checkbox" id="ck-${esc(enc)}" data-act="check" data-key="${esc(i.key)}" ${i.got ? 'checked' : ''}>
    <div style="min-width:0"><label class="name" for="ck-${esc(enc)}">${esc(i.name)}</label>
      ${forTxt ? `<div class="for">${esc(forTxt)}</div>` : ''}
      ${i.extra ? '' : `<button class="linkish" data-act="have" data-key="${esc(i.key)}" data-v="${i.have ? 0 : 1}">${i.have ? 'Need to buy' : 'Have it'}</button>
      · <a class="linkish" href="${STORES[currentStore()].search}${encodeURIComponent(i.name)}" target="_blank" rel="noopener">Find at ${esc(storeName())}</a>`}
    </div>
    <div class="right"><button class="price-btn num" data-act="edit-price" data-key="${esc(i.key)}" aria-label="Edit price for ${esc(i.name)}">${i.estimate && i.priced ? '<span class="est">est</span>' : ''}<span class="amt">${i.priced ? money(i.cost) : 'add price'}</span></button>
      ${qtyTxt ? `<span class="size num">${qtyTxt}${i.price && (i.byLb || i.qty > 1) ? ` @ ${money(i.price)}${i.byLb ? '/lb' : ''}` : ''}${i.manual ? ' (set by you)' : ''}</span>` : ''}</div>
    ${edit}
  </div>`;
}

function extrasBox() {
  return `<section class="aisle"><h3>Anything else</h3><form class="extra-add" id="extra-form">
    <input type="text" id="extra-name" placeholder="Add an item, like paper towels or coffee" autocomplete="off">
    <button class="btn" type="submit">Add</button></form></section>`;
}

function listAsText() {
  const items = buildList().filter(i => !i.have);
  const lines = [];
  for (const a of AISLE_ORDER) {
    const l = items.filter(i => i.aisle === a); if (!l.length) continue;
    lines.push(a.toUpperCase());
    for (const i of l) lines.push(`${i.got ? '[x]' : '[ ]'} ${i.name}${i.extra ? '' : i.byLb ? ` (~${i.qty} lb)` : i.qty > 1 ? ` x${i.qty}` : ''}${i.cost ? `  ~${money(i.cost)}` : ''}`);
    lines.push('');
  }
  lines.push(`Estimated total at ${storeName()}: ${money(items.reduce((s, i) => s + i.cost, 0))}`);
  return lines.join('\n');
}

/* ---------------- events ---------------- */
document.addEventListener('click', async e => {
  const go = e.target.closest("[data-go], a[href^='#']");
  if (go) { e.preventDefault(); navTo(go.dataset.go || go.getAttribute('href').slice(1)); return; }
  if (e.target.id === 'account-btn') { navTo('account'); return; }
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id, key = el.dataset.key;
  switch (act) {
    case 'check': return;
    case 'toggle-week': changeList(l => { if (l.recipes[id]) delete l.recipes[id]; else l.recipes[id] = { mult: 1 }; }); break;
    case 'mult': { const d = Number(el.dataset.d); changeList(l => { const cur = Number(l.recipes[id] && l.recipes[id].mult) || 1; if (l.recipes[id]) l.recipes[id] = { mult: Math.min(6, Math.max(1, cur + d)) }; }); break; }
    case 'have': { const v = el.dataset.v === '1'; changeList(l => { l.have[key] = v; }); break; }
    case 'qty': {
      const item = buildList().find(i => i.key === key); if (!item) break;
      const step = item.byLb ? 0.5 : 1, d = Number(el.dataset.d) * step;
      const next = Math.max(item.byLb ? 0.5 : 0, Math.round((item.qty + d) * 10) / 10);
      changeList(l => { l.qty[key] = next; });
      break;
    }
    case 'edit-price': S.editing = S.editing === key ? null : key; render(); setTimeout(() => { const p = $('#pe-price'); if (p) p.focus(); }, 0); break;
    case 'cancel-price': S.editing = null; render(); break;
    case 'drop-extra': S.editing = null; changeList(l => { l.extras = (l.extras || []).filter(x => x.id !== id); delete l.checked['x:' + id]; }); break;
    case 'ask-delete': S.confirm = 'delete:' + id; render(); break;
    case 'ask-new-week': S.confirm = 'newweek'; render(); break;
    case 'cancel-confirm': S.confirm = null; render(); break;
    case 'delete':
      S.confirm = null;
      try { await safely(Store.deleteRecipe(id), 'Recipe deleted'); } catch { break; }
      S.recipes = S.recipes.filter(r => r.id !== id); cacheSave();
      if (S.list.recipes[id]) changeList(l => { delete l.recipes[id]; });
      navTo('recipes'); break;
    case 'new-week': S.confirm = null; changeList(l => { l.recipes = {}; l.checked = {}; l.have = {}; l.qty = {}; l.extras = []; }); toast('List cleared for a new week'); break;
    case 'toggle-have-list': S.showHave = !S.showHave; render(); break;
    case 'store': if (STORES[id]) { S.editing = null; changeList(l => { l.store = id; }); } break;
    case 'pantry': S.pantry = id; S.category = null; S.renamingCat = false; S.q = ''; writePref('pantry', id); render(); break;
    case 'category': S.category = S.category === el.dataset.cat ? null : el.dataset.cat; S.renamingCat = false; render(); break;
    case 'rename-cat': S.renamingCat = true; render(); setTimeout(() => { const i = $('#cat-rename-input'); if (i) { i.focus(); i.select(); } }, 0); break;
    case 'cancel-rename-cat': S.renamingCat = false; render(); break;
    case 'set-cat': S.settingCat = true; render(); setTimeout(() => { const i = $('#cat-input'); if (i) i.focus(); }, 0); break;
    case 'cancel-set-cat': S.settingCat = false; render(); break;
    case 'pick-cat': { const r = recipeById(S.openId); if (r) { S.settingCat = false; const d = recipeData(r); d.category = el.dataset.cat; await saveRecipeData(r.id, d); } break; }
    case 'rename-pantry': S.renaming = true; render(); setTimeout(() => { const i = $('#rename-input'); if (i) { i.focus(); i.select(); } }, 0); break;
    case 'cancel-rename': S.renaming = false; render(); break;
    case 'step': { const k = S.openId + ':' + el.dataset.ix; doneSteps.has(k) ? doneSteps.delete(k) : doneSteps.add(k); el.classList.toggle('done'); break; }
    case 'match': S.matching = Number(el.dataset.ix); render(); setTimeout(() => { const m = $('#match-input'); if (m) { m.focus(); m.select(); } }, 0); break;
    case 'cancel-match': S.matching = null; render(); break;
    case 'edit-recipe': S.editRecipe = true; render(); break;
    case 'cancel-edit-recipe': S.editRecipe = false; render(); break;
    case 'signout': await Store.signOut(); navTo('recipes'); break;
    case 'reload': toast('Reloading…'); checkForUpdate(true); break;
    case 'copy': {
      const txt = listAsText();
      try { await navigator.clipboard.writeText(txt); toast('List copied'); }
      catch { const ta = document.createElement('textarea'); ta.value = txt; ta.style.minHeight = '220px'; el.closest('.summary').after(ta); ta.select(); toast('Select all and copy'); }
      break;
    }
  }
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'pantry-select') {
    try {
      const [p, c] = JSON.parse(el.value);
      if (p === '__account') { navTo('account'); return; }
      if (p === '__reload') { toast('Reloading…'); checkForUpdate(true); return; }
      S.pantry = p; S.category = c; S.q = ''; S.renamingCat = false; writePref('pantry', p);
      navTo('recipes');
    } catch {}
    return;
  }
  if (el.dataset && el.dataset.act === 'check') { const k = el.dataset.key, on = el.checked; changeList(l => { if (on) l.checked[k] = true; else delete l.checked[k]; }); }
});
document.addEventListener('toggle', e => { if (e.target.id === 'paste-details') S.pasteOpen = e.target.open; }, true);
document.addEventListener('input', e => { if (e.target.id === 'search') { S.q = e.target.value; render(); } });

document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'auth-form') {
    const mode = (e.submitter && e.submitter.dataset.mode) || 'in';
    const email = $('#auth-email').value.trim(), pass = $('#auth-pass').value;
    S.authMsg = { text: 'Working…' }; render();
    $('#auth-email').value = email;
    try {
      if (mode === 'up') {
        const ready = await Store.signUp(email, pass);
        S.authMsg = ready ? null : { text: 'Check your email and click the confirmation link, then come back and sign in.' };
      } else { await Store.signIn(email, pass); S.authMsg = null; }
    } catch (err) { S.authMsg = { bad: true, text: (err && err.message) || 'Something went wrong.' }; }
    render();
  } else if (f.id === 'add-form') {
    const url = safeUrl($('#add-url').value.trim());
    if (!url) { S.import = { err: "That doesn't look like a web link. It should start with https://" }; render(); return; }
    importFromUrl(url);
  } else if (f.id === 'paste-form') {
    const text = $('#add-text').value;
    if (!text.trim()) return;
    importFromText(text);
  } else if (f.id === 'price-form') {
    const k = f.dataset.key;
    const price = Math.max(0, Number($('#pe-price').value) || 0);
    if (k.startsWith('x:')) { const xid = k.slice(2); changeList(l => { const x = (l.extras || []).find(y => y.id === xid); if (x) x.price = price; }); }
    else {
      const pk = priceKey(k);
      const data = { ...(S.prices[pk] || {}), size: $('#pe-size').value.trim(), by: $('#pe-by').value, price, aisle: $('#pe-aisle').value, updatedAt: Date.now() };
      S.prices = { ...S.prices, [pk]: data }; rebuildEntries(); cacheSave();
      safely(Store.setPrice(pk, data), `${storeName()} price saved for every recipe`).catch(() => {});
    }
    S.editing = null; render();
  } else if (f.id === 'cat-form') {
    const r = recipeById(S.openId); if (!r) return;
    let name = $('#cat-input').value.trim().slice(0, 40);
    // Reuse an existing category's spelling ("bbq" → "BBQ").
    const same = categoriesFor(recipeHousehold(r)).cats.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (same) name = same.name;
    else name = name.charAt(0).toUpperCase() + name.slice(1);
    S.settingCat = false;
    const d = recipeData(r); d.category = name; await saveRecipeData(r.id, d);
  } else if (f.id === 'cat-rename-form') {
    const from = S.category, to = $('#cat-rename-input').value.trim().slice(0, 40);
    S.renamingCat = false;
    const targets = S.recipes.filter(r => inPantryScope(r, S.pantry) && recipeCategory(r).toLowerCase() === String(from).toLowerCase());
    for (const r of targets) { const d = recipeData(r); d.category = to; await saveRecipeData(r.id, d, true); }
    S.category = to || null; render(); toast(to ? `Renamed to ${to}` : 'Category removed');
  } else if (f.id === 'rename-form') {
    const label = $('#rename-input').value.trim().slice(0, 40);
    S.renaming = false;
    if (label) {
      const h = myHousehold(), before = S.households[h];
      S.households = { ...S.households, [h]: label }; render();
      try { await Store.setHouseholdName(h, label); toast('Pantry renamed'); }
      catch { S.households = { ...S.households, [h]: before }; toast("Couldn't rename yet. Run update 3 in Supabase (see SETUP.md)."); }
    }
    render();
  } else if (f.id === 'extra-form') {
    const name = $('#extra-name').value.trim(); if (!name) return;
    $('#extra-name').value = '';
    const id = uid().slice(0, 12);
    changeList(l => { (l.extras = l.extras || []).push({ id, name: name.slice(0, 120), price: 0 }); });
  } else if (f.id === 'match-form') {
    const ix = Number(f.dataset.ix), r = recipeById(S.openId);
    const key = $('#match-input').value.trim().toLowerCase();
    if (!r || !key) return;
    const data = recipeData(r); data.ingredients[ix] = { ...data.ingredients[ix], key };
    S.matching = null; await saveRecipeData(r.id, data);
  } else if (f.id === 'edit-form') {
    const r = recipeById(S.openId); if (!r) return;
    const old = new Map((r.ingredients || []).map(i => [i.raw, i]));
    const data = recipeData(r);
    data.title = $('#ed-title').value.trim() || r.title;
    data.servings = $('#ed-serves').value.trim();
    data.ingredients = $('#ed-ings').value.split('\n').map(s => s.trim()).filter(Boolean).map(raw => old.get(raw) || { raw });
    data.steps = $('#ed-steps').value.split('\n').map(s => s.trim()).filter(Boolean).map(text => ({ group: '', text }));
    S.editRecipe = false; await saveRecipeData(r.id, data);
  }
});
function recipeData(r) { const { id, createdAt, ...rest } = r; return clone(rest); }
async function saveRecipeData(id, data, quiet) {
  try { await safely(Store.updateRecipe(id, data), quiet ? null : 'Saved'); } catch { return; }
  S.recipes = S.recipes.map(r => r.id === id ? { id, ...data, createdAt: r.createdAt } : r);
  resolveCache.clear(); cacheSave(); render();
}

/* ---------------- routing ---------------- */
function navTo(h) { try { if (location.hash.slice(1) !== h) history.pushState(null, '', '#' + h); } catch {} route(h); }
function route(given) {
  const h = typeof given === 'string' ? given : location.hash.replace(/^#/, '');
  S.confirm = null; S.editing = null; S.matching = null; S.editRecipe = false; S.settingCat = false;
  if (h === 'list') S.view = 'list';
  else if (h === 'account') S.view = 'account';
  else if (h.startsWith('r-')) { S.view = 'recipe'; S.openId = h.slice(2); }
  else S.view = 'recipes';
  render(); window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => route());
window.addEventListener('hashchange', () => route());

/* ---------------- updates ----------------
   Phones (especially iPhone home-screen apps) keep an old copy of the page. On open, ask the
   server which version is current and, if it's newer, load it under a fresh address so nothing
   saved gets in the way. */
let lastUpdateCheck = 0;
async function checkForUpdate(force) {
  if (!force && Date.now() - lastUpdateCheck < 60000) return;
  lastUpdateCheck = Date.now();
  try {
    const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    const { v } = await res.json();
    if (Number(v) > APP_VERSION || force) {
      if (listOps.length) await flushList();
      location.replace(location.pathname + '?v=' + (Number(v) || APP_VERSION) + '&t=' + Date.now() + location.hash);
    }
  } catch { if (force) location.reload(); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });

/* ---------------- boot ---------------- */
async function refresh() {
  try { await Store.loadAll(); rebuildEntries(); cacheSave(); }
  catch (e) { if (navigator.onLine) toast("Couldn't load the latest. Showing what's saved on this device."); }
  render();
}
async function startSession() {
  S.notMember = !(await Store.isMember());
  await refresh();
  S.ready = true; render();
  if (Store === Remote) Remote.subscribe(refresh);
}
async function boot() {
  cacheLoad(); rebuildEntries(); route();
  checkForUpdate();
  if (Remote.enabled()) {
    Store = Remote;
    try { await Remote.init(); } catch { S.ready = true; render(); toast("Couldn't reach the server. Showing what's saved on this device."); }
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.user) { refresh(); flushList(); } });
  } else {
    Store = Local; await Local.loadAll(); rebuildEntries(); S.ready = true; render();
  }
}
boot();

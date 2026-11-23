'use strict';
/* Our Recipe Box: shared recipes + weekly H-E-B shopping list.
   Data lives in Supabase (shared by the household) or, before setup, in this browser only. */

const CFG = window.RECIPE_BOX_CONFIG || {};
const CACHE_KEY = 'recipe-box-cache-v1';
const LOCAL_KEY = 'recipe-box-local-v1';

const S = {
  ready: false, user: null, notMember: false, authMsg: null,
  recipes: [], prices: {}, list: emptyList(),
  view: 'recipes', openId: null, q: '',
  import: null, editing: null, confirm: null, matching: null, editRecipe: false,
  showHave: false, pasteOpen: false,
};
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
function cacheSave() { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ recipes: S.recipes, prices: S.prices, list: S.list })); } catch {} }
function cacheLoad() { try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); if (c) { S.recipes = c.recipes || []; S.prices = c.prices || {}; S.list = { ...emptyList(), ...(c.list || {}) }; } } catch {} }

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
  async loadAll() { const d = this.read(); S.recipes = d.recipes; S.prices = d.prices; S.list = { ...emptyList(), ...d.list }; },
  async addRecipe(data) { const d = this.read(); const id = uid(); d.recipes.unshift({ id, ...data, createdAt: new Date().toISOString() }); this.write(d); return id; },
  async updateRecipe(id, data) { const d = this.read(); d.recipes = d.recipes.map(r => r.id === id ? { id, ...data, createdAt: r.createdAt } : r); this.write(d); },
  async deleteRecipe(id) { const d = this.read(); d.recipes = d.recipes.filter(r => r.id !== id); this.write(d); },
  async setPrice(key, data) { const d = this.read(); d.prices[key] = data; this.write(d); },
  async writeList(ops) { const d = this.read(); const next = { ...emptyList(), ...d.list }; ops.forEach(fn => fn(next)); d.list = next; this.write(d); return next; },
  async importUrl() { throw { code: 'needs_setup' }; },
};
let Store = Local;

/* ---------------- price book + ingredient math ---------------- */
let ENTRIES = new Map();
function rebuildEntries() {
  ENTRIES = new Map(PRICE_BOOK.map(e => [e.key, e]));
  for (const [key, d] of Object.entries(S.prices)) {
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
function resolve(ing) {
  const ck = ing.raw + '|' + (ing.key || '');
  if (resolveCache.has(ck)) return resolveCache.get(ck);
  const p = parseIngredient(ing.raw);
  if (ing.key) p.key = p.full = ing.key;
  const e = ing.key && ENTRIES.has(ing.key) ? ENTRIES.get(ing.key) : (matchEntry(p.full) || matchEntry(p.key));
  const r = {
    p, e, itemKey: e ? e.key : p.key, aisle: e ? e.aisle : guessAisle(p.key), pantry: e ? e.pantry : false,
    buy: e ? amountToBuy(p, e) : 1, price: e ? e.price : 0,
  };
  r.cost = r.buy * r.price;
  resolveCache.set(ck, r);
  return r;
}
const recipeCost = r => (r.ingredients || []).reduce((s, i) => s + resolve(i).cost, 0);
const recipeById = id => S.recipes.find(r => r.id === id);

function buildList() {
  const agg = new Map();
  for (const [rid, sel] of Object.entries(S.list.recipes || {})) {
    const r = recipeById(rid); if (!r) continue;
    const mult = Number(sel && sel.mult) || 1;
    for (const ing of r.ingredients || []) {
      const x = resolve(ing);
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
      addedBy: S.user ? S.user.email : '',
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
    ingredients: t.ingredients.map(raw => ({ raw })), steps: t.steps.map(text => ({ group: '', text })), addedBy: S.user ? S.user.email : '' };
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
  const app = $('#app');
  const f = document.activeElement, focusId = f && f.id, sel = f && f.selectionStart;
  if (!S.ready) app.innerHTML = `<div class="empty"><h2>Opening your recipe box…</h2></div>`;
  else if (Store === Remote && !S.user) app.innerHTML = viewAuth();
  else if (S.notMember) app.innerHTML = viewNotMember();
  else if (S.view === 'list') app.innerHTML = viewList();
  else if (S.view === 'recipe') app.innerHTML = viewRecipe();
  else if (S.view === 'account') app.innerHTML = viewAccount();
  else app.innerHTML = viewRecipes();
  if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); try { if (sel != null) el.setSelectionRange(sel, sel); } catch {} } }
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
    <p><button class="btn" data-act="signout">Sign out</button> <a class="btn ghost" href="#recipes">Back</a></p></div>`;
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
  const list = S.recipes.filter(r => !q || (r.title + ' ' + (r.ingredients || []).map(i => i.raw).join(' ')).toLowerCase().includes(q));
  let body;
  if (!S.recipes.length) body = `<div class="empty"><h2>No recipes yet</h2><p class="muted">Paste a link from a recipe site above. The app keeps just the ingredients and steps and estimates what they cost at H-E-B.</p></div>`;
  else if (!list.length) body = `<div class="empty"><h2>Nothing matches “${esc(S.q)}”</h2><p class="muted">Try an ingredient or part of the name.</p></div>`;
  else body = `<div class="grid">${list.map(card).join('')}</div>`;
  return `${viewImporter()}
    ${S.recipes.length > 3 ? `<div class="toolbar"><input type="text" id="search" placeholder="Search recipes or ingredients" value="${esc(S.q)}" autocomplete="off"></div>` : ''}
    ${body}`;
}

function card(r) {
  const on = !!S.list.recipes[r.id];
  const img = safeUrl(r.image);
  return `<article class="card ${on ? 'on' : ''}">
    ${img ? `<a href="#r-${esc(r.id)}" tabindex="-1"><img class="thumb" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"></a>` : ''}
    <div class="body">
      <h3><a href="#r-${esc(r.id)}">${esc(r.title)}</a></h3>
      <div class="meta">${r.totalMinutes ? `<span>${fmtMinutes(r.totalMinutes)}</span>` : ''}${r.servings ? `<span>Serves ${esc(r.servings)}</span>` : ''}${r.sourceUrl ? `<span>${esc(host(r.sourceUrl))}</span>` : ''}</div>
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
        <span class="num">About ${money(recipeCost(r))} at H-E-B <span class="est">estimate</span></span></div>
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
  if (!sel.length && !(S.list.extras || []).length) return `<div class="empty"><h2>No recipes picked for this week</h2><p class="muted">Open <a href="#recipes">Recipes</a> and tap “Add to week” on what you want to cook. The list adds up every ingredient, grouped by aisle, with H-E-B price estimates.</p></div>${extrasBox()}`;
  const chips = sel.map(([id, v]) => { const r = recipeById(id); const m = Number(v && v.mult) || 1; return `<span class="chip"><a href="#r-${esc(id)}">${esc(r.title)}</a>
      <span class="mult"><button data-act="mult" data-id="${esc(id)}" data-d="-1" aria-label="Fewer batches">−</button><span class="num">×${m}</span><button data-act="mult" data-id="${esc(id)}" data-d="1" aria-label="More batches">+</button></span>
      <button class="x" data-act="toggle-week" data-id="${esc(id)}" aria-label="Remove ${esc(r.title)}">✕</button></span>`; }).join('');
  const groups = AISLE_ORDER.map(a => [a, need.filter(i => i.aisle === a)]).filter(([, l]) => l.length);
  const unpriced = need.filter(i => !i.priced).length;
  const newWeek = S.confirm === 'newweek'
    ? `<span class="confirm">Clear this week's recipes and checkmarks for your household? <button class="btn sm danger" data-act="new-week">Clear list</button><button class="btn sm ghost" data-act="cancel-confirm">Cancel</button></span>`
    : `<button class="btn" data-act="ask-new-week">Start a new week</button>`;
  return `<section class="summary">
      <div><div class="lbl">Estimated at H-E-B</div><div class="big num">${money(total)}</div></div>
      <div><div class="lbl">Items</div><div class="num" style="font-size:18px;font-weight:600">${left} left of ${need.length}</div></div>
      <div class="actions"><button class="btn" data-act="copy">Copy list</button>${newWeek}</div>
    </section>
    <div class="chips">${chips}</div>
    ${unpriced ? `<p class="note">${unpriced} item${unpriced > 1 ? 's have' : ' has'} no price yet, so the total is low. Tap “add price” to fill one in once; it's remembered.</p>` : ''}
    ${groups.map(([a, l]) => `<section class="aisle"><h3>${esc(a)}</h3><div class="rows">${l.map(row).join('')}</div></section>`).join('')}
    ${extrasBox()}
    ${have.length ? `<section class="aisle"><h3>Already have at home (${have.length}) <button class="linkish" data-act="toggle-have-list">${S.showHave ? 'hide' : 'show'}</button></h3>
      ${S.showHave ? `<div class="rows">${have.map(row).join('')}</div>` : `<p class="note">Staples like salt and oil start here and aren't in the total. Move anything back if you're out.</p>`}</section>` : ''}
    <p class="note">Prices marked EST are built-in estimates of regular H-E-B shelf prices; your store and sales will differ. Tap a price to correct it, and your price is used everywhere from then on.</p>`;
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
      · <a class="linkish" href="https://www.heb.com/search?q=${encodeURIComponent(i.name)}" target="_blank" rel="noopener">Find on H-E-B</a>`}
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
  lines.push(`Estimated total: ${money(items.reduce((s, i) => s + i.cost, 0))}`);
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
    case 'step': { const k = S.openId + ':' + el.dataset.ix; doneSteps.has(k) ? doneSteps.delete(k) : doneSteps.add(k); el.classList.toggle('done'); break; }
    case 'match': S.matching = Number(el.dataset.ix); render(); setTimeout(() => { const m = $('#match-input'); if (m) { m.focus(); m.select(); } }, 0); break;
    case 'cancel-match': S.matching = null; render(); break;
    case 'edit-recipe': S.editRecipe = true; render(); break;
    case 'cancel-edit-recipe': S.editRecipe = false; render(); break;
    case 'signout': await Store.signOut(); navTo('recipes'); break;
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
      const data = { ...(S.prices[k] || {}), size: $('#pe-size').value.trim(), by: $('#pe-by').value, price, aisle: $('#pe-aisle').value, updatedAt: Date.now() };
      S.prices = { ...S.prices, [k]: data }; rebuildEntries(); cacheSave();
      safely(Store.setPrice(k, data), 'Price saved for every recipe').catch(() => {});
    }
    S.editing = null; render();
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
async function saveRecipeData(id, data) {
  try { await safely(Store.updateRecipe(id, data), 'Saved'); } catch { return; }
  S.recipes = S.recipes.map(r => r.id === id ? { id, ...data, createdAt: r.createdAt } : r);
  resolveCache.clear(); cacheSave(); render();
}

/* ---------------- routing ---------------- */
function navTo(h) { try { if (location.hash.slice(1) !== h) history.pushState(null, '', '#' + h); } catch {} route(h); }
function route(given) {
  const h = typeof given === 'string' ? given : location.hash.replace(/^#/, '');
  S.confirm = null; S.editing = null; S.matching = null; S.editRecipe = false;
  if (h === 'list') S.view = 'list';
  else if (h === 'account') S.view = 'account';
  else if (h.startsWith('r-')) { S.view = 'recipe'; S.openId = h.slice(2); }
  else S.view = 'recipes';
  render(); window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => route());
window.addEventListener('hashchange', () => route());

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
  if (Remote.enabled()) {
    Store = Remote;
    try { await Remote.init(); } catch { S.ready = true; render(); toast("Couldn't reach the server. Showing what's saved on this device."); }
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.user) { refresh(); flushList(); } });
  } else {
    Store = Local; await Local.loadAll(); rebuildEntries(); S.ready = true; render();
  }
}
boot();

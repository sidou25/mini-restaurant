// ---------- Outils ----------

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const num = n => (Number(n) || 0).toLocaleString('fr-FR');
const da = n => num(n) + ' DA';

// Date locale au format AAAA-MM-JJ
function ymd(d = new Date()) {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
}
const addDays = (n, d = new Date()) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const hour = s => s.slice(11, 16);
const dateFr = s => s.slice(8, 10) + '/' + s.slice(5, 7) + ' ' + hour(s);
const dayFr = s => s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4);
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const TYPES = { surplace: 'Sur place', emporter: 'À emporter', livraison: 'Livraison' };
const TYPE_ICONS = { surplace: '🪑', emporter: '🛍️', livraison: '🛵' };
const STATUS = { terminee: '✓ Payée', en_cours: '🛵 En livraison', livree: '✓ Livrée', annulee: 'Annulée' };

// Une image pour chaque produit, devinée depuis son nom puis sa catégorie
const EMOJIS = [
  [/burger/i, '🍔'], [/pizza/i, '🍕'], [/tacos?/i, '🌮'], [/sandwich|panini|chawarma|shawarma|kebab/i, '🥪'],
  [/frite/i, '🍟'], [/poulet|chicken|nugget|wings/i, '🍗'], [/salade/i, '🥗'],
  [/dessert|gâteau|gateau|tiramisu|glace|crêpe|crepe/i, '🍰'], [/café|cafe|thé\b/i, '☕'],
  [/\beau\b/i, '💧'], [/jus|boisson|canette|soda|coca|hamoud/i, '🥤'],
];
const emojiOf = p => (EMOJIS.find(([r]) => r.test(p.name)) || EMOJIS.find(([r]) => r.test(p.category)) || [0, '🍽️'])[1];

async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // Nouvelle version en ligne ? On rechargera la page au prochain changement de page
  const version = res.headers.get('X-App-Version');
  if (version) {
    if (!S.version) S.version = version;
    else if (version !== S.version) S.newVersion = true;
  }
  if (res.status === 401 && !url.startsWith('/api/login')) {
    showAuth(false);
    throw new Error('Connecte-toi');
  }
  if (!res.ok) throw new Error(data.error || 'Erreur');
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// Lance une action et affiche l'erreur s'il y en a une
async function attempt(fn) {
  try { await fn(); } catch (e) { toast(e.message, true); }
}

function openModal(html, wide = false) {
  const box = $('#modal-box');
  box.className = 'modal-box' + (wide ? ' wide' : '');
  box.innerHTML = html;
  $('#modal').classList.remove('hidden');
  $$('[data-close]', box).forEach(b => b.onclick = closeModal);
  box.querySelector('input:not([type=checkbox])')?.focus();
  return box;
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function confirmer(message, onYes, yesLabel = 'Oui') {
  const box = openModal(`
    <h2>Confirmer</h2>
    <p>${message}</p>
    <div class="modal-actions">
      <button class="btn" data-close>Non</button>
      <button class="btn primary" id="yes">${yesLabel}</button>
    </div>`);
  $('#yes', box).onclick = () => attempt(async () => { await onYes(); closeModal(); });
}

// Petit rebond quand un chiffre change
function bump(el) {
  if (!el) return;
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

// ---------- État ----------

const S = {
  me: null,
  settings: { restaurant_name: 'Brother' },
  products: [],
  livreurs: [],
  cart: {},          // { productId: quantité }
  type: 'surplace',
  form: {},          // champs de la livraison
  cat: 'Tout',
  lastAdded: null,
  lastTotal: 0,
  ordersDate: ymd(),
  ordersFilter: 'toutes',
  dash: { from: ymd(), to: ymd(), preset: 'jour' },
  seen: null,        // commandes déjà vues par le livreur
  poll: null,
};
const isAdmin = () => S.me?.role === 'admin';
const isLivreur = () => S.me?.role === 'livreur';

function getAutoPrint() {
  try { return localStorage.getItem('autoPrint') === '1'; } catch { return false; }
}
function setAutoPrint(on) {
  try { localStorage.setItem('autoPrint', on ? '1' : '0'); } catch { /* navigateur privé */ }
}

// ---------- Connexion ----------

let setupMode = false;

function showAuth(setup, needsCode = false) {
  setupMode = setup;
  clearInterval(S.poll);
  $('#shell').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#code-field').classList.toggle('hidden', !(setup && needsCode));
  $('[name=code]').required = setup && needsCode;
  $('#auth-title').textContent = setup ? 'Bienvenue' : 'Connexion';
  $('#auth-help').textContent = setup ? 'Premier lancement : crée le compte du patron.' : '';
  $('#auth-btn').textContent = setup ? 'Créer le compte du patron' : 'Se connecter';
  $('#auth-error').textContent = '';
}

$('#auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    S.me = await api(setupMode ? '/api/setup' : '/api/login', {
      method: 'POST',
      body: { username: f.get('username'), password: f.get('password'), code: f.get('code') },
    });
    e.target.reset();
    start();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

$('#logout').onclick = async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  S.me = null;
  S.seen = null;
  showAuth(false);
};

async function boot() {
  const { needsSetup, needsCode } = await api('/api/setup');
  if (needsSetup) return showAuth(true, needsCode);
  const res = await fetch('/api/me');
  if (!res.ok) return showAuth(false);
  S.me = await res.json();
  start();
}

async function start() {
  $('#auth').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  $('#me-name').textContent = isLivreur() ? `🛵 ${S.me.livreur_name}` : S.me.username;
  await loadBase();
  renderNav();
  router();
}

async function loadBase() {
  const staff = !isLivreur();
  [S.settings, S.products, S.livreurs] = await Promise.all([
    api('/api/settings'),
    staff ? api('/api/products') : [],
    staff ? api('/api/livreurs') : [],
  ]);
  const name = S.settings.restaurant_name || 'Brother';
  $('#resto-name').textContent = name.toUpperCase();
  $('#logo-mark').textContent = name.trim()[0]?.toUpperCase() || 'B';
  document.title = name;
}

// ---------- Navigation ----------

const PAGES = [
  { id: 'accueil', ico: '🏠', label: 'Accueil', render: renderAccueil, roles: ['admin'] },
  { id: 'caisse', ico: '🍔', label: 'Caisse', render: renderCaisse, roles: ['admin', 'caissier'] },
  { id: 'commandes', ico: '🧾', label: 'Commandes', render: renderCommandes, roles: ['admin', 'caissier'] },
  { id: 'livreurs', ico: '🛵', label: 'Livreurs', render: renderLivreurs, roles: ['admin'] },
  { id: 'menu', ico: '📋', label: 'Menu', render: renderMenu, roles: ['admin'] },
  { id: 'reglages', ico: '⚙️', label: 'Réglages', render: renderReglages, roles: ['admin', 'caissier'] },
  { id: 'livraisons', ico: '🛵', label: 'Mes livraisons', render: renderLivreurPage, roles: ['livreur'] },
];
const visiblePages = () => PAGES.filter(p => p.roles.includes(S.me.role));

function renderNav() {
  const pages = visiblePages();
  $('#nav').innerHTML = pages.map(p =>
    `<a href="#${p.id}" data-page="${p.id}"><span class="ico">${p.ico}</span><span>${p.label}</span></a>`).join('');
  $('#nav').classList.toggle('single', pages.length < 2);
  document.body.classList.toggle('has-nav', pages.length > 1);
}

function router() {
  if (!S.me) return;
  // une nouvelle version est en ligne : on recharge (sauf si une commande est en cours de saisie)
  if (S.newVersion && !Object.keys(S.cart).length) return location.reload();
  clearInterval(S.poll);
  const id = location.hash.slice(1);
  const page = visiblePages().find(p => p.id === id) || visiblePages()[0];
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.page === page.id));
  const main = $('#page');
  // relance l'animation d'entrée de page
  main.style.animation = 'none';
  void main.offsetWidth;
  main.style.animation = '';
  attempt(() => page.render(main));
}
window.addEventListener('hashchange', router);

// ---------- Caisse ----------

function renderCaisse(el) {
  const cats = ['Tout', ...new Set(S.products.map(p => p.category))];
  if (!cats.includes(S.cat)) S.cat = 'Tout';

  el.innerHTML = `
    <div class="caisse">
      <section>
        <div class="menu-head">
          <div class="chips" id="chips">
            ${cats.map(c => `<button class="chip ${c === S.cat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
          </div>
        </div>
        <div class="grid" id="grid"></div>
      </section>
      <aside class="panier" id="panier"></aside>
    </div>
    <button class="btn primary go-panier hidden" id="go-panier"></button>`;

  $$('[data-cat]', el).forEach(b => b.onclick = () => {
    S.cat = b.dataset.cat;
    $$('[data-cat]', el).forEach(x => x.classList.toggle('on', x === b));
    renderGrid();
  });
  $('#go-panier', el).onclick = () => $('#panier').scrollIntoView({ behavior: 'smooth' });
  renderGrid();
  renderPanier();
}

function renderGrid() {
  const list = S.products.filter(p => S.cat === 'Tout' || p.category === S.cat);
  $('#grid').innerHTML = list.map((p, i) => `
    <button class="prod" data-id="${p.id}" style="animation-delay:${Math.min(i, 12) * 25}ms">
      <span class="emoji">${emojiOf(p)}</span>
      <span class="name">${esc(p.name)}</span>
      <span class="price">${da(p.price)}</span>
    </button>`).join('') || '<p class="muted">Aucun produit. Le patron les ajoute dans la page Menu.</p>';
  $$('.prod').forEach(b => b.onclick = e => addToCart(b, e));
  updateCounts();
}

function addToCart(btn, ev) {
  const pid = btn.dataset.id;
  S.cart[pid] = (S.cart[pid] || 0) + 1;
  S.lastAdded = pid;
  // éclair rouge à l'endroit du clic
  const r = btn.getBoundingClientRect();
  btn.style.setProperty('--x', (ev.clientX ? ev.clientX - r.left : r.width / 2) + 'px');
  btn.style.setProperty('--y', (ev.clientY ? ev.clientY - r.top : r.height / 2) + 'px');
  btn.classList.remove('flash');
  void btn.offsetWidth;
  btn.classList.add('flash');
  renderPanier();
  flyToCart(btn);
}

// L'image du produit vole jusqu'à la commande
function flyToCart(btn) {
  if (reducedMotion()) return;
  const emoji = btn.querySelector('.emoji');
  const from = emoji.getBoundingClientRect();
  const go = $('#go-panier');
  const target = go && getComputedStyle(go).display !== 'none' ? go : $('#panier-title');
  if (!target) return;
  const to = target.getBoundingClientRect();
  const fly = document.createElement('div');
  fly.className = 'fly';
  fly.textContent = emoji.textContent;
  fly.style.left = from.left + 'px';
  fly.style.top = from.top + 'px';
  document.body.appendChild(fly);
  const dx = to.left + to.width / 2 - from.left - 17;
  const dy = to.top + to.height / 2 - from.top - 17;
  fly.animate([
    { transform: 'translate(0, 0) scale(1)', opacity: 1 },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 90}px) scale(1.25) rotate(-12deg)`, opacity: 1, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) scale(.3)`, opacity: 0.2 },
  ], { duration: 650, easing: 'cubic-bezier(.45,0,.55,1)' }).onfinish = () => fly.remove();
}

function updateCounts() {
  $$('.prod').forEach(b => {
    const q = S.cart[b.dataset.id] || 0;
    let c = b.querySelector('.count');
    b.classList.toggle('in-cart', q > 0);
    if (!q) return c?.remove();
    if (!c) {
      c = document.createElement('span');
      c.className = 'count';
      b.appendChild(c);
    }
    if (c.textContent !== String(q)) {
      c.textContent = q;
      c.classList.remove('pop');
      void c.offsetWidth;
      c.classList.add('pop');
    }
  });
}

function cartLines() {
  return Object.entries(S.cart)
    .map(([id, qty]) => ({ p: S.products.find(p => p.id == id), qty }))
    .filter(l => l.p && l.qty > 0);
}

function renderPanier() {
  const el = $('#panier');
  if (!el) return;
  const lines = cartLines();
  const isLiv = S.type === 'livraison';
  updateCounts();

  el.innerHTML = `
    <div class="panier-head">
      <h2 id="panier-title"><span class="display">Commande</span>
        ${lines.length ? `<button class="btn ghost small" id="vider">Vider</button>` : ''}</h2>
      <div class="seg">
        ${Object.entries(TYPES).map(([v, l]) =>
          `<button data-type="${v}" class="${S.type === v ? 'on' : ''}"><span class="t-ico">${TYPE_ICONS[v]}</span>${l}</button>`).join('')}
      </div>
    </div>

    <div class="panier-body">
      ${lines.map(l => `
        <div class="line ${l.p.id == S.lastAdded && l.qty === 1 ? 'new' : ''}">
          <span class="lname">${emojiOf(l.p)} ${esc(l.p.name)}<small>${da(l.p.price)}</small></span>
          <div class="qty">
            <button data-minus="${l.p.id}" aria-label="Moins">−</button>
            <b>${l.qty}</b>
            <button data-plus="${l.p.id}" aria-label="Plus">+</button>
          </div>
          <span>${da(l.p.price * l.qty)}</span>
        </div>`).join('') || `
        <div class="empty"><span class="big-emoji">🍔</span>Touche un produit pour l'ajouter</div>`}
    </div>

    <div class="panier-foot">
      ${isLiv ? `
        <div class="liv">
          <div class="liv-grid">
            <label>Livreur *
              <select data-f="livreur_id">
                <option value="">— choisir —</option>
                ${S.livreurs.map(l => `<option value="${l.id}" ${S.form.livreur_id == l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
              </select>
            </label>
            <label>Téléphone <input data-f="client_phone" type="tel" value="${esc(S.form.client_phone)}"></label>
          </div>
          <label>Client <input data-f="client_name" value="${esc(S.form.client_name)}" placeholder="Nom"></label>
          <label>Adresse <input data-f="address" value="${esc(S.form.address)}"></label>
          ${S.livreurs.length ? '' : '<p class="error" style="margin-bottom:10px">Aucun livreur. Le patron l\'ajoute dans la page Livreurs.</p>'}
        </div>` : ''}
      <label>Note <input data-f="note" value="${esc(S.form.note)}" placeholder="ex : sans oignon"></label>
      <div class="totaux" id="totaux"></div>
      <label class="check-row"><input type="checkbox" id="auto-print" ${getAutoPrint() ? 'checked' : ''}> 🖨️ Imprimer le bon automatiquement</label>
      <button class="btn primary big" id="valider" ${lines.length ? '' : 'disabled'}>Valider la commande</button>
    </div>`;

  $$('[data-type]', el).forEach(b => b.onclick = () => { S.type = b.dataset.type; renderPanier(); });
  $$('[data-plus]', el).forEach(b => b.onclick = () => { S.cart[b.dataset.plus]++; S.lastAdded = null; renderPanier(); });
  $$('[data-minus]', el).forEach(b => b.onclick = () => {
    if (--S.cart[b.dataset.minus] <= 0) delete S.cart[b.dataset.minus];
    S.lastAdded = null;
    renderPanier();
  });
  // On garde ce qui est tapé sans tout redessiner
  $$('[data-f]', el).forEach(i => i.oninput = () => { S.form[i.dataset.f] = i.value; renderTotaux(); });
  $('#vider', el)?.addEventListener('click', () => { S.cart = {}; renderPanier(); });
  $('#auto-print', el).onchange = e => setAutoPrint(e.target.checked);
  $('#valider', el).onclick = validerCommande;
  renderTotaux();
}

function renderTotaux() {
  const lines = cartLines();
  const food = lines.reduce((s, l) => s + l.p.price * l.qty, 0);
  const isLiv = S.type === 'livraison';
  // Bouton flottant (téléphone) pour descendre jusqu'à la commande
  const go = $('#go-panier');
  const n = lines.reduce((s, l) => s + l.qty, 0);
  go.classList.toggle('hidden', n === 0);
  go.innerHTML = `<span>🧾 Voir la commande (${n})</span><b>${da(food)}</b>`;

  $('#totaux').innerHTML = `
    <div class="tot big"><span>${isLiv ? 'Le client paie' : 'Total'}</span><span class="amount" id="total">${da(food)}</span></div>
    ${isLiv ? `<div class="tot warn"><span>🛵 Le livreur doit rendre</span><span>${da(food)}</span></div>` : ''}`;

  if (food !== S.lastTotal) bump($('#total'));
  S.lastTotal = food;
}

async function validerCommande() {
  const btn = $('#valider');
  btn.disabled = true;
  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: {
        type: S.type,
        items: cartLines().map(l => ({ product_id: l.p.id, qty: l.qty })),
        livreur_id: S.form.livreur_id,
        client_name: S.form.client_name,
        client_phone: S.form.client_phone,
        address: S.form.address,
        note: S.form.note,
      },
    });
    S.cart = {};
    S.form = {};
    S.lastAdded = null;
    renderPanier();
    showDone(order);
    if (getAutoPrint()) setTimeout(() => printTicket(order), 500);
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
  }
}

function showDone(o) {
  const total = o.food_total;
  const box = openModal(`
    <div class="done">
      <div class="tick"><svg viewBox="0 0 48 48"><path d="M12 25 l8 8 l16 -18"/></svg></div>
      <h2>Commande n°${o.id}</h2>
      <div class="amount">${da(total)}</div>
      <p class="muted">${TYPE_ICONS[o.type]} ${TYPES[o.type]}${o.type === 'livraison'
        ? ` · <b style="color:var(--amber)">${esc(o.livreur_name)} doit rendre ${da(o.food_total)}</b>` : ''}</p>
      <div class="modal-actions" style="justify-content:center">
        <button class="btn" id="print">🖨️ Imprimer le bon</button>
        <button class="btn primary" data-close>Nouvelle commande</button>
      </div>
    </div>`);
  $('#print', box).onclick = () => printTicket(o);
  $('[data-close]', box).focus();
}

// ---------- Bon de commande (ticket) ----------

function printTicket(o) {
  const isLiv = o.type === 'livraison';
  const row = (a, b) => `<div class="t-row"><span>${a}</span><span>${b}</span></div>`;
  $('#ticket').innerHTML = `
    <div class="t-brand">${esc((S.settings.restaurant_name || 'Brother').toUpperCase())}</div>
    <div class="t-center">${dayFr(o.created_at)} ${hour(o.created_at)}</div>
    <hr>
    <div class="t-center t-big">COMMANDE N° ${o.id}</div>
    <div class="t-center">${TYPES[o.type].toUpperCase()}</div>
    <hr>
    ${o.items.map(i => row(`${i.qty} x ${esc(i.name)}`, num(i.qty * i.price))).join('')}
    <hr>
    <div class="t-row t-total"><span>TOTAL</span><span>${da(o.food_total)}</span></div>
    ${o.note ? `<hr><div><b>Note :</b> ${esc(o.note)}</div>` : ''}
    ${isLiv ? `<hr>
      ${o.client_name ? `<div>Client : ${esc(o.client_name)}</div>` : ''}
      ${o.client_phone ? `<div>Tél : ${esc(o.client_phone)}</div>` : ''}
      ${o.address ? `<div>Adresse : ${esc(o.address)}</div>` : ''}
      <div>Livreur : ${esc(o.livreur_name)}</div>` : ''}
    <hr>
    <div class="t-center">Merci et bon appétit !</div>`;
  window.print();
}

// ---------- Commandes ----------

async function renderCommandes(el) {
  const orders = await api(`/api/orders?from=${S.ordersDate}&to=${S.ordersDate}`);
  const ok = orders.filter(o => o.status !== 'annulee');
  const total = ok.reduce((s, o) => s + o.food_total, 0);
  const enCours = ok.filter(o => o.status === 'en_cours');
  const shown = S.ordersFilter === 'livraison' ? enCours : orders;

  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Commandes</h1>
        <div class="sub">${plural(ok.length, 'commande')} · ${da(total)} de ventes</div>
      </div>
      <div class="toolbar">
        <label>Jour <input type="date" id="o-date" value="${S.ordersDate}"></label>
        <button class="btn" id="o-today">Aujourd'hui</button>
      </div>
    </div>
    <div class="chips" style="margin-bottom:16px">
      <button class="chip ${S.ordersFilter === 'toutes' ? 'on' : ''}" data-filter="toutes">Toutes (${orders.length})</button>
      <button class="chip ${S.ordersFilter === 'livraison' ? 'on' : ''}" data-filter="livraison">🛵 En livraison (${enCours.length})</button>
    </div>
    <div class="orders">
      ${shown.map((o, i) => orderCard(o, i)).join('') || '<div class="card empty"><span class="big-emoji">🧾</span>Aucune commande ici.</div>'}
    </div>`;

  const byId = id => orders.find(o => o.id == id);
  $('#o-date', el).onchange = e => { S.ordersDate = e.target.value || ymd(); renderCommandes(el); };
  $('#o-today', el).onclick = () => { S.ordersDate = ymd(); renderCommandes(el); };
  $$('[data-filter]', el).forEach(b => b.onclick = () => { S.ordersFilter = b.dataset.filter; renderCommandes(el); });
  $$('[data-print]', el).forEach(b => b.onclick = () => printTicket(byId(b.dataset.print)));
  $$('[data-livree]', el).forEach(b => b.onclick = () => attempt(async () => {
    await api(`/api/orders/${b.dataset.livree}/status`, { method: 'PATCH', body: { status: 'livree' } });
    toast('✓ Commande marquée livrée');
    renderCommandes(el);
  }));
  $$('[data-supprimer]', el).forEach(b => b.onclick = () => {
    const o = byId(b.dataset.supprimer);
    confirmer(`Le client a annulé ? Supprimer la commande <b>n°${o.id}</b> (${da(o.food_total)}) ?
      Elle disparaît des ventes${o.livreur_name ? ` et ${esc(o.livreur_name)} ne la doit plus` : ''}.`,
    async () => {
      await api(`/api/orders/${o.id}`, { method: 'DELETE' });
      toast(`🗑️ Commande n°${o.id} supprimée`);
      renderCommandes(el);
    }, '🗑️ Oui, supprimer');
  });
}

function orderCard(o, i) {
  return `
    <div class="order ${o.status}" style="animation-delay:${Math.min(i, 10) * 30}ms">
      <div class="order-top">
        <div class="order-num">N° ${o.id}<small>${hour(o.created_at)}</small></div>
        <span class="badge ${o.status}">${STATUS[o.status]}</span>
      </div>
      <div><span class="badge type">${TYPE_ICONS[o.type]} ${TYPES[o.type]}</span></div>
      <div class="order-items">
        ${o.items.map(i => `<div><b>${i.qty}×</b> ${esc(i.name)}</div>`).join('')}
        ${o.note ? `<div class="muted">« ${esc(o.note)} »</div>` : ''}
      </div>
      ${o.type === 'livraison' ? `
        <div class="order-info">
          🛵 <b style="color:var(--ink)">${esc(o.livreur_name)}</b>
          ${o.client_name || o.client_phone ? `<br>👤 ${esc(o.client_name)} ${esc(o.client_phone)}` : ''}
          ${o.address ? `<br>📍 ${esc(o.address)}` : ''}
        </div>` : ''}
      <div class="order-sum">
        <span class="muted">Total</span>
        <span class="amount">${da(o.food_total)}</span>
      </div>
      <div class="actions">
        <button class="btn small" data-print="${o.id}">🖨️ Bon</button>
        ${o.status === 'en_cours' ? `<button class="btn small green" data-livree="${o.id}">✓ Livrée</button>` : ''}
        ${isAdmin() ? `<button class="btn small danger" data-supprimer="${o.id}">🗑️ Supprimer</button>` : ''}
      </div>
    </div>`;
}

// ---------- Accueil du patron (simple) ----------

const PRESETS = {
  jour: { label: "Aujourd'hui", words: "aujourd'hui", range: () => [ymd(), ymd()] },
  hier: { label: 'Hier', words: 'hier', range: () => [ymd(addDays(-1)), ymd(addDays(-1))] },
  semaine: { label: '7 jours', words: 'ces 7 derniers jours', range: () => [ymd(addDays(-6)), ymd()] },
  mois: {
    label: 'Ce mois', words: 'ce mois-ci',
    range: () => { const d = new Date(); return [ymd(new Date(d.getFullYear(), d.getMonth(), 1)), ymd()]; },
  },
};

async function renderAccueil(el) {
  const { from, to, preset } = S.dash;
  const st = await api(`/api/stats?from=${from}&to=${to}`);
  const t = st.totals;
  const words = PRESETS[preset]?.words || `du ${dayFr(from)} au ${dayFr(to)}`;
  const recu = t.caisse_directe + t.verse_livreurs;
  const chez = st.chez_livreurs;
  const today = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  el.innerHTML = `
    <div class="page-head">
      <div>
        <div class="hello">Salam ${esc(S.me.username)} 👋 · ${today}</div>
        <h1>Ton restaurant ${esc(words)}</h1>
      </div>
      <div class="seg">
        ${Object.entries(PRESETS).map(([k, p]) => `<button data-preset="${k}" class="${preset === k ? 'on' : ''}">${p.label}</button>`).join('')}
      </div>
    </div>

    <div class="big-cards">
      <div class="big-card money">
        <div class="icon">💰</div>
        <div class="label">Tu as vendu</div>
        <div class="value">${da(t.ventes)}</div>
        <div class="explain">${plural(t.nb, 'commande')} ${esc(words)}</div>
      </div>
      <div class="big-card good">
        <div class="icon">💵</div>
        <div class="label">Argent reçu dans ta main</div>
        <div class="value">${da(recu)}</div>
        <div class="explain">${da(t.caisse_directe)} au comptoir + ${da(t.verse_livreurs)} rendus par les livreurs</div>
      </div>
      <div class="big-card ${chez > 0 ? 'alert' : 'good'}">
        <div class="icon">🛵</div>
        <div class="label">${chez > 0 ? 'Les livreurs te doivent' : 'Les livreurs ne te doivent rien'}</div>
        <div class="value">${da(chez)}</div>
        <div class="explain">${chez > 0 ? "C'est l'argent de ta nourriture encore dans leur poche." : 'Tout est rendu 👍'}</div>
      </div>
    </div>

    <div class="section-title"><h2>Tes livreurs</h2><a class="btn small" href="#livreurs">Gérer</a></div>
    <div class="people">
      ${st.livreurs.filter(l => l.active).map((l, i) => `
        <div class="person ${l.reste > 0 ? 'owes' : ''}" style="animation-delay:${i * 50}ms">
          <div class="avatar">${esc(l.name.trim()[0]?.toUpperCase())}</div>
          <div class="who">
            <b>${esc(l.name)}</b>
            <div class="say">${l.reste > 0 ? `doit te rendre <b>${da(l.reste)}</b>`
              : l.reste < 0 ? `a rendu ${da(-l.reste)} en trop` : '<span class="ok">✓ ne te doit rien</span>'}</div>
            <div class="say">${plural(l.nb, 'livraison')} ${esc(words)}</div>
          </div>
          ${l.reste > 0 ? `<button class="btn primary" data-verser="${l.id}">💵 Il m'a donné</button>` : ''}
        </div>`).join('') || '<div class="card empty">Pas encore de livreur. Ajoute-les dans « Livreurs ».</div>'}
    </div>

    <div class="section-title"><h2>Ce qui se vend le plus</h2></div>
    <div class="top-list">
      ${st.produits.slice(0, 5).map((p, i) => `
        <div class="top-item">
          <span class="rank">${['🥇', '🥈', '🥉', '4', '5'][i]}</span>
          <span class="what">${esc(p.name)}</span>
          <span class="how"><b>${p.qty}</b> vendus · ${da(p.montant)}</span>
        </div>`).join('') || '<div class="card empty">Rien de vendu pour le moment.</div>'}
    </div>

    <details class="more">
      <summary>📊 Plus de détails (pour vérifier les chiffres)</summary>
      <div class="inner">
        <div class="toolbar" style="margin-bottom:14px">
          <label>Du <input type="date" id="d-from" value="${from}"></label>
          <label>Au <input type="date" id="d-to" value="${to}"></label>
        </div>
        <div class="kpis">
          <div class="kpi"><div class="label">Ventes sur place / à emporter</div><div class="value">${da(t.caisse_directe)}</div></div>
          <div class="kpi"><div class="label">Ventes en livraison</div><div class="value">${da(t.ventes_livraison)}</div></div>
          <div class="kpi"><div class="label">Sur place · À emporter · Livraison</div><div class="value">${t.nb_surplace} · ${t.nb_emporter} · ${t.nb_livraison}</div></div>
          <div class="kpi"><div class="label">Commandes annulées</div><div class="value">${t.annulees}</div></div>
        </div>
        <div class="two">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Produit</th><th class="num">Qté</th><th class="num">Montant</th></tr></thead>
              <tbody>${st.produits.map(p => `<tr><td>${esc(p.name)}</td><td class="num">${p.qty}</td><td class="num">${da(p.montant)}</td></tr>`).join('')
                || '<tr><td colspan="3" class="muted">Aucune vente.</td></tr>'}</tbody>
            </table>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Livreur</th><th class="num">Livr.</th><th class="num">Ventes</th><th class="num">Rendu</th><th class="num">Doit</th></tr></thead>
              <tbody>${st.livreurs.map(l => `
                <tr><td>${esc(l.name)}</td><td class="num">${l.nb}</td><td class="num">${da(l.ventes)}</td>
                <td class="num">${da(l.verse_periode)}</td>
                <td class="num ${l.reste > 0 ? 'plus' : 'moins'}">${da(l.reste)}</td></tr>`).join('')
                || '<tr><td colspan="5" class="muted">Aucun livreur.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </div>
    </details>`;

  $$('[data-preset]', el).forEach(b => b.onclick = () => {
    const [f, t2] = PRESETS[b.dataset.preset].range();
    S.dash = { from: f, to: t2, preset: b.dataset.preset };
    renderAccueil(el);
  });
  const custom = () => {
    const f = $('#d-from', el).value, t2 = $('#d-to', el).value;
    if (!f || !t2) return;
    S.dash = { from: f <= t2 ? f : t2, to: f <= t2 ? t2 : f, preset: '' };
    renderAccueil(el);
  };
  $('#d-from', el).onchange = custom;
  $('#d-to', el).onchange = custom;
  $$('[data-verser]', el).forEach(b => b.onclick = () =>
    verser(st.livreurs.find(l => l.id == b.dataset.verser), () => renderAccueil(el)));
}

// ---------- Livreurs (admin) ----------

async function renderLivreurs(el) {
  const comptes = (await api(`/api/livreurs/comptes?from=${ymd()}&to=${ymd()}`))
    .filter(l => l.active);
  const totalDette = comptes.reduce((s, l) => s + Math.max(l.reste, 0), 0);
  const refresh = () => renderLivreurs(el);

  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Livreurs</h1>
        <div class="sub">Ils te rendent tout l'argent que les clients leur donnent.</div>
      </div>
      <button class="btn primary" id="add-livreur">+ Ajouter un livreur</button>
    </div>
    <div class="big-cards" style="grid-template-columns:1fr">
      <div class="big-card ${totalDette > 0 ? 'alert' : 'good'}">
        <div class="label">💸 Argent encore chez les livreurs</div>
        <div class="value">${da(totalDette)}</div>
      </div>
    </div>
    <div class="livreurs">
      ${comptes.map((l, i) => `
        <div class="card livreur" style="animation-delay:${i * 40}ms">
          <h2>🛵 ${esc(l.name)} ${l.active ? '' : '<span class="badge annulee">ancien</span>'}</h2>
          <div class="muted">${l.phone ? `📞 ${esc(l.phone)}` : 'pas de téléphone'}</div>
          <div class="reste ${l.reste > 0 ? 'dette' : ''}">
            <div class="label">${l.reste > 0 ? 'Il doit te rendre' : l.reste < 0 ? 'Il a rendu en trop' : 'Il ne te doit rien'}</div>
            <div class="value">${da(Math.abs(l.reste))}</div>
          </div>
          <div class="mini">
            <div>Livraisons aujourd'hui<b>${l.nb}</b></div>
            <div>En route maintenant<b>${l.en_cours}</b></div>
            <div>Ventes aujourd'hui<b>${da(l.ventes)}</b></div>
            <div>Rendu aujourd'hui<b>${da(l.verse_periode)}</b></div>
          </div>
          <div class="acces">🔑 ${l.acces ? `Son accès : <b>${esc(l.acces)}</b>` : 'Pas encore d\'accès à sa page'}</div>
          <div class="actions">
            <button class="btn primary small" data-verser="${l.id}">💵 Il m'a donné</button>
            <button class="btn small" data-histo="${l.id}">Historique</button>
            <button class="btn small" data-acces="${l.id}">🔑 Accès</button>
            <button class="btn small ghost" data-edit="${l.id}">Modifier</button>
            <button class="btn small danger" data-del-livreur="${l.id}">🗑️ Supprimer</button>
          </div>
        </div>`).join('') || '<div class="card empty"><span class="big-emoji">🛵</span>Aucun livreur pour l\'instant.</div>'}
    </div>`;

  const byId = id => comptes.find(l => l.id == id);
  $('#add-livreur', el).onclick = () => editLivreur(null, refresh);
  $$('[data-edit]', el).forEach(b => b.onclick = () => editLivreur(byId(b.dataset.edit), refresh));
  $$('[data-verser]', el).forEach(b => b.onclick = () => verser(byId(b.dataset.verser), refresh));
  $$('[data-acces]', el).forEach(b => b.onclick = () => editAcces(byId(b.dataset.acces), refresh));
  $$('[data-histo]', el).forEach(b => b.onclick = () => attempt(() => historique(b.dataset.histo, refresh)));
  $$('[data-del-livreur]', el).forEach(b => b.onclick = () => supprimerLivreur(byId(b.dataset.delLivreur), refresh));
}

function supprimerLivreur(l, done) {
  const dette = l.reste > 0;
  confirmer(`${dette ? `⚠️ <b>${esc(l.name)}</b> doit encore <b class="plus">${da(l.reste)}</b>.
    Si tu le supprimes, <b>cet argent ne sera plus compté</b>.<br><br>` : ''}
    Supprimer <b>${esc(l.name)}</b> ? Il ne pourra plus se connecter.
    Ses anciennes livraisons restent dans tes ventes.`, async () => {
    await api(`/api/livreurs/${l.id}${dette ? '?force=1' : ''}`, { method: 'DELETE' });
    S.livreurs = await api('/api/livreurs');
    toast(`${l.name} est supprimé`);
    done();
  }, dette ? '🗑️ Supprimer quand même' : '🗑️ Oui, supprimer');
}

function editLivreur(l, done) {
  const box = openModal(`
    <h2>${l ? 'Modifier le livreur' : 'Nouveau livreur'}</h2>
    <form id="lf">
      <label>Nom <input name="name" value="${esc(l?.name)}" required></label>
      <label>Téléphone <input name="phone" type="tel" value="${esc(l?.phone)}"></label>
      ${l ? `<label class="check-row"><input type="checkbox" name="active" ${l.active ? 'checked' : ''}> Travaille encore chez nous</label>` : ''}
      <div class="modal-actions">
        <button type="button" class="btn" data-close>Annuler</button>
        <button class="btn primary">Enregistrer</button>
      </div>
    </form>`);
  $('#lf', box).onsubmit = e => attempt(async () => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { name: f.get('name'), phone: f.get('phone'), active: l ? f.get('active') === 'on' : true };
    await api(l ? `/api/livreurs/${l.id}` : '/api/livreurs', { method: l ? 'PUT' : 'POST', body });
    closeModal();
    S.livreurs = await api('/api/livreurs');
    toast('✓ Livreur enregistré');
    done();
  });
}

function editAcces(l, done) {
  const box = openModal(`
    <h2>🔑 Accès de ${esc(l.name)}</h2>
    <p class="muted">Avec ce nom et ce mot de passe, ${esc(l.name)} voit <b>seulement ses livraisons</b>
      et peut dire « c'est livré ». Il ne voit pas l'argent du restaurant.</p>
    <form id="af">
      <label>Nom d'utilisateur <input name="username" value="${esc(l.acces || l.name.toLowerCase().replace(/\s+/g, ''))}" required minlength="3" autocapitalize="none"></label>
      <label>Mot de passe ${l.acces ? '(nouveau)' : ''} <input name="password" type="text" required minlength="6" autocomplete="off"></label>
      <div class="modal-actions">
        ${l.acces ? '<button type="button" class="btn danger" id="del-acces">Supprimer l\'accès</button>' : ''}
        <button type="button" class="btn" data-close>Annuler</button>
        <button class="btn primary">Enregistrer</button>
      </div>
    </form>`);
  $('#af', box).onsubmit = e => attempt(async () => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api(`/api/livreurs/${l.id}/acces`, { method: 'PUT', body: { username: f.get('username'), password: f.get('password') } });
    closeModal();
    toast(`✓ ${l.name} peut se connecter`);
    done();
  });
  $('#del-acces', box)?.addEventListener('click', () => attempt(async () => {
    await api(`/api/livreurs/${l.id}/acces`, { method: 'DELETE' });
    closeModal();
    toast('Accès supprimé');
    done();
  }));
}

function verser(l, done) {
  const box = openModal(`
    <h2>💵 ${esc(l.name)} te donne de l'argent</h2>
    <p>Il te doit en ce moment <b class="plus">${da(Math.max(l.reste, 0))}</b>.</p>
    <form id="vf">
      <label>Combien il t'a donné ? (DA)
        <input name="amount" type="number" min="1" step="1" inputmode="numeric" value="${Math.max(l.reste, 0) || ''}" required>
      </label>
      <label>Note <input name="note" placeholder="facultatif"></label>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>Annuler</button>
        <button class="btn green">Enregistrer</button>
      </div>
    </form>`);
  $('#vf', box).onsubmit = e => attempt(async () => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/api/versements', {
      method: 'POST',
      body: { livreur_id: l.id, amount: Number(f.get('amount')), note: f.get('note') },
    });
    closeModal();
    toast('✓ Argent enregistré');
    done();
  });
}

async function historique(id, done) {
  const { livreur, solde, lignes } = await api(`/api/livreurs/${id}/compte`);
  const box = openModal(`
    <div class="section-title">
      <h2>Compte de ${esc(livreur.name)}</h2>
      <button class="btn" data-close>Fermer</button>
    </div>
    <p>Reste à rendre : <b class="${solde > 0 ? 'plus' : 'moins'}">${da(solde)}</b></p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Quoi</th><th class="num">Il doit</th><th class="num">Il a rendu</th><th class="num">Reste</th><th></th></tr></thead>
        <tbody>
          ${lignes.map(l => l.kind === 'commande' ? `
            <tr>
              <td>${dateFr(l.created_at)}</td>
              <td>Commande n°${l.id}</td>
              <td class="num plus">+ ${da(l.food_total)}</td><td></td>
              <td class="num">${da(l.solde)}</td><td></td>
            </tr>` : `
            <tr>
              <td>${dateFr(l.created_at)}</td>
              <td>💵 Versement ${l.note ? `<span class="muted">${esc(l.note)}</span>` : ''}</td>
              <td></td><td class="num moins">− ${da(l.amount)}</td>
              <td class="num">${da(l.solde)}</td>
              <td><button class="btn small danger" data-del="${l.id}" title="Supprimer ce versement">✕</button></td>
            </tr>`).join('') || '<tr><td colspan="6" class="muted">Rien pour l\'instant.</td></tr>'}
        </tbody>
      </table>
    </div>`, true);
  $$('[data-del]', box).forEach(b => b.onclick = () => attempt(async () => {
    if (!confirm('Supprimer ce versement (erreur de saisie) ?')) return;
    await api(`/api/versements/${b.dataset.del}`, { method: 'DELETE' });
    toast('Versement supprimé');
    await historique(id, done);
    done();
  }));
}

// ---------- Menu (produits) ----------

async function renderMenu(el) {
  const all = await api('/api/products?all=1');
  const cats = [...new Set(all.map(p => p.category))];

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Menu</h1><div class="sub">Les produits et leurs prix. Ce qui est ici apparaît dans la caisse.</div></div>
    </div>
    <form class="card form-row" id="pf" style="margin-bottom:16px">
      <label>Nom <input name="name" required placeholder="ex : Pizza poulet"></label>
      <label>Catégorie <input name="category" list="cats" placeholder="ex : Pizzas"></label>
      <label style="max-width:150px">Prix (DA) <input name="price" type="number" min="0" step="10" inputmode="numeric" required></label>
      <button class="btn primary">+ Ajouter</button>
      <datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    </form>
    <div class="menu-list">
      ${all.map(p => `
        <div class="menu-item ${p.active ? '' : 'off'}" data-row="${p.id}">
          <span class="m-emoji">${emojiOf(p)}</span>
          <label class="m-name">Nom <input data-k="name" value="${esc(p.name)}"></label>
          <label class="m-cat">Catégorie <input data-k="category" value="${esc(p.category)}" list="cats"></label>
          <label class="m-price">Prix (DA) <input data-k="price" type="number" min="0" step="10" inputmode="numeric" value="${p.price}"></label>
          <label class="check-row m-active"><input data-k="active" type="checkbox" ${p.active ? 'checked' : ''}> En vente</label>
          <button class="btn small m-save" data-save="${p.id}">Enregistrer</button>
        </div>`).join('')}
    </div>
    <p class="muted">Changer un prix ne change pas les anciennes commandes. Décoche « En vente » pour cacher un produit de la caisse.</p>`;

  $('#pf', el).onsubmit = e => attempt(async () => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/api/products', {
      method: 'POST',
      body: { name: f.get('name'), category: f.get('category'), price: Number(f.get('price')) },
    });
    toast('✓ Produit ajouté');
    S.products = await api('/api/products');
    renderMenu(el);
  });

  $$('[data-save]', el).forEach(b => b.onclick = () => attempt(async () => {
    const row = $(`[data-row="${b.dataset.save}"]`, el);
    const v = k => $(`[data-k="${k}"]`, row);
    await api(`/api/products/${b.dataset.save}`, {
      method: 'PUT',
      body: { name: v('name').value, category: v('category').value, price: Number(v('price').value), active: v('active').checked },
    });
    row.classList.toggle('off', !v('active').checked);
    toast('✓ Produit enregistré');
    S.products = await api('/api/products');
  }));
}

// ---------- Réglages ----------

function passwordForm() {
  return `
    <form id="pwf">
      <label>Ancien mot de passe <input name="old" type="password" required autocomplete="current-password"></label>
      <label>Nouveau mot de passe <input name="password" type="password" minlength="6" required autocomplete="new-password"></label>
      <button class="btn primary">Changer</button>
    </form>`;
}

function bindPasswordForm(el) {
  $('#pwf', el).onsubmit = e => attempt(async () => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/api/me/password', { method: 'PUT', body: { old: f.get('old'), password: f.get('password') } });
    e.target.reset();
    toast('✓ Mot de passe changé');
  });
}

async function renderReglages(el) {
  const users = isAdmin() ? await api('/api/users') : [];
  const ROLE = { admin: '👑 patron', caissier: '🧾 caissier', livreur: '🛵 livreur' };

  el.innerHTML = `
    <div class="page-head"><h1>Réglages</h1></div>
    <div class="two">
      ${isAdmin() ? `
        <form class="card" id="sf">
          <h2>Restaurant</h2>
          <label>Nom du restaurant <input name="restaurant_name" value="${esc(S.settings.restaurant_name)}"></label>
          <button class="btn primary">Enregistrer</button>
        </form>` : ''}

      <div class="card">
        <h2>Mon mot de passe</h2>
        ${passwordForm()}
      </div>

      <div class="card">
        <h2>📲 Application sur le téléphone</h2>
        ${isInstalled()
          ? '<p class="moins">✓ Tu utilises déjà l\'application installée.</p>'
          : `<p class="muted">Installe Brother sur ton téléphone : une icône sur l'écran d'accueil,
              et le site s'ouvre en plein écran comme une vraie application.</p>
            <button class="btn primary" id="install-card-btn">📲 Installer l'application</button>`}
      </div>

      ${isAdmin() ? `
        <div class="card">
          <h2>Comptes</h2>
          <p class="muted">Le <b>caissier</b> prend les commandes mais ne voit pas l'argent.
            Les accès des <b>livreurs</b> se créent dans la page Livreurs (bouton 🔑 Accès).</p>
          <table>
            <tbody>
              ${users.map(u => `
                <tr>
                  <td><b>${esc(u.username)}</b></td>
                  <td><span class="badge type">${ROLE[u.role]}${u.livreur_name ? ` · ${esc(u.livreur_name)}` : ''}</span></td>
                  <td class="num">${u.id === S.me.id ? '<span class="muted">toi</span>'
                    : `<button class="btn small danger" data-deluser="${u.id}" data-name="${esc(u.username)}">Supprimer</button>`}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          <form id="uf" style="margin-top:14px">
            <div class="form-row">
              <label>Nom <input name="username" required minlength="3" autocomplete="off" autocapitalize="none"></label>
              <label>Mot de passe <input name="password" type="password" required minlength="6" autocomplete="new-password"></label>
            </div>
            <div class="form-row" style="margin-top:10px">
              <label>Rôle
                <select name="role"><option value="caissier">Caissier</option><option value="admin">Patron (admin)</option></select>
              </label>
              <button class="btn primary">+ Ajouter le compte</button>
            </div>
          </form>
        </div>

        <div class="card" style="border-color:rgba(227,38,47,.45)">
          <h2>🧹 Remettre à zéro</h2>
          <p class="muted">Après tes essais, efface <b>toutes les commandes</b> et <b>tout l'argent rendu par les livreurs</b>.
            Le menu, les livreurs et les comptes restent. Les numéros de commande repartent à 1.</p>
          <button class="btn danger" id="reset">🧹 Tout effacer et repartir à zéro</button>
        </div>` : ''}
    </div>`;

  $('#reset', el)?.addEventListener('click', () => {
    const box = openModal(`
      <h2>🧹 Tout effacer ?</h2>
      <p>Toutes les commandes et tout l'argent rendu seront <b>effacés pour toujours</b>.</p>
      <form id="rf">
        <label>Pour confirmer, écris <b style="color:var(--ink)">EFFACER</b> <input name="confirm" autocomplete="off" autocapitalize="characters" required></label>
        <div class="modal-actions">
          <button type="button" class="btn" data-close>Non</button>
          <button class="btn primary">Tout effacer</button>
        </div>
      </form>`);
    $('#rf', box).onsubmit = e => attempt(async () => {
      e.preventDefault();
      await api('/api/reset', { method: 'POST', body: { confirm: new FormData(e.target).get('confirm').trim().toUpperCase() } });
      closeModal();
      toast('🧹 Tout est remis à zéro');
    });
  });

  $('#sf', el)?.addEventListener('submit', e => attempt(async () => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/api/settings', {
      method: 'PUT',
      body: { restaurant_name: f.get('restaurant_name') },
    });
    await loadBase();
    toast('✓ Réglages enregistrés');
  }));

  bindPasswordForm(el);
  $('#install-card-btn', el)?.addEventListener('click', installApp);

  $('#uf', el)?.addEventListener('submit', e => attempt(async () => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/api/users', {
      method: 'POST',
      body: { username: f.get('username'), password: f.get('password'), role: f.get('role') },
    });
    toast('✓ Compte ajouté');
    renderReglages(el);
  }));

  $$('[data-deluser]', el).forEach(b => b.onclick = () => confirmer(
    `Supprimer le compte « ${esc(b.dataset.name)} » ?`,
    async () => {
      await api(`/api/users/${b.dataset.deluser}`, { method: 'DELETE' });
      toast('Compte supprimé');
      renderReglages(el);
    }, 'Oui, supprimer'));
}

// ---------- Page du livreur ----------

async function renderLivreurPage(el, auto = false) {
  const d = await api('/api/livreur/moi');
  const ids = d.a_livrer.map(o => o.id);
  const fresh = S.seen ? ids.filter(id => !S.seen.has(id)) : [];
  S.seen = new Set(ids);
  if (auto && fresh.length) {
    toast(`🛵 Nouvelle commande à livrer !`);
    navigator.vibrate?.([200, 100, 200]);
  }
  // si on tape dans le mot de passe, on ne redessine pas la page
  if (auto && el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;

  el.innerHTML = `
    <div class="liv-page">
      <div class="hello">Salam ${esc(S.me.livreur_name)} 👋</div>
      <h1>Mes livraisons</h1>
      <div class="liv-hero ${d.reste > 0 ? '' : 'clean'}">
        <div class="label">${d.reste > 0 ? 'Tu dois rendre au restaurant' : 'Tu ne dois rien au restaurant 👍'}</div>
        <div class="value">${da(Math.max(d.reste, 0))}</div>
        <div class="sub">Aujourd'hui : ${plural(d.nb, 'livraison')}</div>
      </div>

      <div class="section-title">
        <h2>À livrer (${d.a_livrer.length})</h2>
        <button class="btn small" id="refresh">↻ Actualiser</button>
      </div>
      ${d.a_livrer.map((o, i) => deliverCard(o, i, fresh.includes(o.id))).join('')
        || '<div class="card empty"><span class="big-emoji">😴</span>Rien à livrer pour le moment.</div>'}

      ${d.livrees.length ? `
        <div class="section-title" style="margin-top:22px"><h2>Livrées aujourd'hui</h2></div>
        <div class="top-list">
          ${d.livrees.map(o => `
            <div class="top-item">
              <span class="rank">✅</span>
              <span class="what">N° ${o.id} <span class="muted">· ${hour(o.created_at)} ${o.address ? '· ' + esc(o.address) : ''}</span></span>
              <span class="how"><b>${da(o.food_total)}</b> à rendre</span>
            </div>`).join('')}
        </div>` : ''}

      <details class="more">
        <summary>🔑 Changer mon mot de passe</summary>
        <div class="inner">${passwordForm()}</div>
      </details>
    </div>`;

  $('#refresh', el).onclick = () => attempt(() => renderLivreurPage(el, true));
  $$('[data-livree]', el).forEach(b => b.onclick = () => {
    const o = d.a_livrer.find(x => x.id == b.dataset.livree);
    confirmer(`Tu as livré la commande <b>n°${o.id}</b> et le client t'a payé <b>${da(o.food_total)}</b> ?`,
      async () => {
        await api(`/api/orders/${o.id}/status`, { method: 'PATCH', body: { status: 'livree' } });
        toast('✅ Bravo, commande livrée !');
        renderLivreurPage(el);
      }, '✅ Oui, c\'est livré');
  });
  bindPasswordForm(el);

  // Regarde toutes les 45 secondes s'il y a une nouvelle commande (seulement si l'écran est allumé)
  clearInterval(S.poll);
  S.poll = setInterval(() => {
    if (document.visibilityState === 'visible' && !$('#modal').offsetParent) {
      if (S.newVersion) return location.reload();
      renderLivreurPage(el, true).catch(() => {});
    }
  }, 45000);
}

function deliverCard(o, i, fresh) {
  const tel = (o.client_phone || '').replace(/[^\d+]/g, '');
  return `
    <div class="deliver ${fresh ? 'fresh' : ''}" style="animation-delay:${i * 50}ms">
      <div class="order-top">
        <div class="order-num">N° ${o.id}<small>${hour(o.created_at)}</small></div>
        <span class="badge en_cours">🛵 À livrer</span>
      </div>
      <div class="where">
        ${o.client_name ? `<div>👤 ${esc(o.client_name)}</div>` : ''}
        ${tel ? `<a href="tel:${tel}">📞 ${esc(o.client_phone)}</a>` : ''}
        ${o.address ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.address)}" target="_blank" rel="noopener">📍 ${esc(o.address)}</a>` : ''}
      </div>
      <div class="order-items" style="margin-bottom:12px">
        ${o.items.map(it => `<div><b>${it.qty}×</b> ${esc(it.name)}</div>`).join('')}
        ${o.note ? `<div class="muted">« ${esc(o.note)} »</div>` : ''}
      </div>
      <div class="collect"><span>Le client te paie</span><span class="amount">${da(o.food_total)}</span></div>
      <p class="muted" style="margin:-4px 0 12px">Tu rends tout cet argent au restaurant</p>
      <button class="btn green big" data-livree="${o.id}">✅ C'est livré</button>
    </div>`;
}

// ---------- Application installable (PWA) ----------

let installPrompt = null;
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// Chrome propose l'installation : on garde l'événement pour notre propre bouton
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('#install').classList.remove('hidden');
  $('#install-card-btn')?.removeAttribute('disabled');
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('#install').classList.add('hidden');
  toast('✅ Application installée ! Elle est sur ton écran d\'accueil.');
});

async function installApp() {
  if (!installPrompt) {
    return openModal(`
      <h2>📲 Installer l'application</h2>
      <p>Dans Chrome, touche le menu <b>⋮</b> en haut à droite, puis <b>« Installer l'application »</b>
        (ou « Ajouter à l'écran d'accueil »).</p>
      <p class="muted">Sur iPhone (Safari) : bouton <b>Partager</b> puis <b>« Sur l'écran d'accueil »</b>.</p>
      <div class="modal-actions"><button class="btn primary" data-close>Compris</button></div>`);
  }
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('#install').classList.add('hidden');
}
$('#install').onclick = installApp;

boot().catch(e => toast(e.message, true));

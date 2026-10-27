// ---------- Outils ----------

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const da = n => (Number(n) || 0).toLocaleString('fr-FR') + ' DA';

// Date locale au format AAAA-MM-JJ
function ymd(d = new Date()) {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
}
const addDays = (n, d = new Date()) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const hour = s => s.slice(11, 16);
const dateFr = s => s.slice(8, 10) + '/' + s.slice(5, 7) + ' ' + hour(s);

const TYPES = { surplace: 'Sur place', emporter: 'À emporter', livraison: 'Livraison' };
const STATUS = { terminee: 'Payée', en_cours: 'En livraison', livree: 'Livrée', annulee: 'Annulée' };

async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
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
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// Lance une action et affiche l'erreur s'il y en a une
async function attempt(fn) {
  try { await fn(); } catch (e) { toast(e.message, true); }
}

function openModal(html, wide = false) {
  const box = $('#modal-box');
  box.className = 'card modal-box' + (wide ? ' wide' : '');
  box.innerHTML = html;
  $('#modal').classList.remove('hidden');
  $$('[data-close]', box).forEach(b => b.onclick = closeModal);
  box.querySelector('input:not([type=checkbox])')?.focus();
  return box;
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ---------- État ----------

const S = {
  me: null,
  settings: { restaurant_name: 'Mini Restaurant', delivery_fee: 200 },
  products: [],
  livreurs: [],
  cart: {},          // { productId: quantité }
  type: 'surplace',
  form: {},          // champs de la livraison
  ordersDate: ymd(),
  dash: { from: ymd(), to: ymd(), preset: 'jour' },
};
const isAdmin = () => S.me?.role === 'admin';

// ---------- Connexion ----------

let setupMode = false;

function showAuth(setup, needsCode = false) {
  setupMode = setup;
  $('#code-field').classList.toggle('hidden', !(setup && needsCode));
  $('[name=code]').required = setup && needsCode;
  $('#shell').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#auth-title').textContent = setup ? 'Bienvenue 👋' : 'Connexion';
  $('#auth-help').textContent = setup
    ? 'Premier lancement : crée le compte du patron (admin).'
    : '';
  $('#auth-btn').textContent = setup ? 'Créer le compte admin' : 'Se connecter';
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
  $('#me-name').textContent = `${S.me.username} (${S.me.role})`;
  await loadBase();
  renderNav();
  router();
}

async function loadBase() {
  [S.settings, S.products, S.livreurs] = await Promise.all([
    api('/api/settings'), api('/api/products'), api('/api/livreurs'),
  ]);
  $('#resto-name').textContent = S.settings.restaurant_name;
  document.title = S.settings.restaurant_name;
}

// ---------- Navigation ----------

const PAGES = [
  { id: 'caisse', label: '🍔 Caisse', render: renderCaisse },
  { id: 'commandes', label: '🧾 Commandes', render: renderCommandes },
  { id: 'livreurs', label: '🛵 Livreurs', render: renderLivreurs, admin: true },
  { id: 'dashboard', label: '📊 Tableau de bord', render: renderDashboard, admin: true },
  { id: 'produits', label: '📋 Produits', render: renderProduits, admin: true },
  { id: 'parametres', label: '⚙️ Paramètres', render: renderParametres },
];
const visiblePages = () => PAGES.filter(p => !p.admin || isAdmin());

function renderNav() {
  $('#nav').innerHTML = visiblePages().map(p => `<a href="#${p.id}" data-page="${p.id}">${p.label}</a>`).join('');
}

function router() {
  if (!S.me) return;
  const id = location.hash.slice(1);
  const page = visiblePages().find(p => p.id === id) || visiblePages()[0];
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.page === page.id));
  attempt(() => page.render($('#page')));
}
window.addEventListener('hashchange', router);

// ---------- Caisse ----------

function renderCaisse(el) {
  const cats = {};
  S.products.forEach(p => (cats[p.category] ||= []).push(p));

  el.innerHTML = `
    <div class="caisse">
      <section>
        ${Object.entries(cats).map(([cat, ps]) => `
          <h3>${esc(cat)}</h3>
          <div class="grid">
            ${ps.map(p => `
              <button class="prod" data-id="${p.id}">
                <span>${esc(p.name)}</span><b>${da(p.price)}</b>
              </button>`).join('')}
          </div>`).join('') || '<p class="muted">Aucun produit. Ajoute ton menu dans la page Produits.</p>'}
      </section>
      <aside class="card panier" id="panier"></aside>
    </div>
    <button class="btn primary go-panier hidden" id="go-panier"></button>`;
  $('#go-panier', el).onclick = () => $('#panier').scrollIntoView({ behavior: 'smooth' });

  $$('.prod', el).forEach(b => b.onclick = () => {
    S.cart[b.dataset.id] = (S.cart[b.dataset.id] || 0) + 1;
    renderPanier();
  });
  renderPanier();
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
  if (S.form.fee === undefined) S.form.fee = S.settings.delivery_fee;

  // Petit compteur sur les boutons produits
  $$('.prod').forEach(b => {
    b.querySelector('.count')?.remove();
    const q = S.cart[b.dataset.id];
    if (q) b.insertAdjacentHTML('afterbegin', `<span class="count">× ${q}</span>`);
  });

  el.innerHTML = `
    <h2>Nouvelle commande</h2>
    <div class="seg">
      ${Object.entries(TYPES).map(([v, l]) =>
        `<button data-type="${v}" class="${S.type === v ? 'on' : ''}">${l}</button>`).join('')}
    </div>

    <div class="lines">
      ${lines.map(l => `
        <div class="line">
          <span>${esc(l.p.name)}</span>
          <div class="qty">
            <button data-minus="${l.p.id}" aria-label="Moins">−</button>
            <b>${l.qty}</b>
            <button data-plus="${l.p.id}" aria-label="Plus">+</button>
          </div>
          <span>${da(l.p.price * l.qty)}</span>
        </div>`).join('') || '<p class="muted">Clique sur un produit pour l\'ajouter.</p>'}
    </div>

    ${isLiv ? `
      <div class="liv">
        <div class="liv-grid">
          <label>Livreur *
            <select data-f="livreur_id">
              <option value="">— choisir —</option>
              ${S.livreurs.map(l => `<option value="${l.id}" ${S.form.livreur_id == l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
            </select>
          </label>
          <label>Frais de livraison (DA)
            <input data-f="fee" type="number" min="0" step="10" value="${esc(S.form.fee)}">
          </label>
          <label>Client <input data-f="client_name" value="${esc(S.form.client_name)}" placeholder="Nom"></label>
          <label>Téléphone <input data-f="client_phone" type="tel" value="${esc(S.form.client_phone)}"></label>
        </div>
        <label>Adresse <input data-f="address" value="${esc(S.form.address)}"></label>
        ${S.livreurs.length ? '' : '<p class="error">Aucun livreur. Ajoute-le dans la page Livreurs.</p>'}
      </div>` : ''}

    <label>Note <input data-f="note" value="${esc(S.form.note)}" placeholder="ex : sans oignon"></label>
    <div class="totaux" id="totaux"></div>
    <div class="form-row">
      <button class="btn ghost" id="vider" ${lines.length ? '' : 'disabled'}>Vider</button>
      <button class="btn primary" style="flex:1;padding:13px;font-size:16px" id="valider" ${lines.length ? '' : 'disabled'}>Valider la commande</button>
    </div>`;

  $$('[data-type]', el).forEach(b => b.onclick = () => { S.type = b.dataset.type; renderPanier(); });
  $$('[data-plus]', el).forEach(b => b.onclick = () => { S.cart[b.dataset.plus]++; renderPanier(); });
  $$('[data-minus]', el).forEach(b => b.onclick = () => {
    if (--S.cart[b.dataset.minus] <= 0) delete S.cart[b.dataset.minus];
    renderPanier();
  });
  // On garde ce qui est tapé sans tout redessiner
  $$('[data-f]', el).forEach(i => i.oninput = () => { S.form[i.dataset.f] = i.value; renderTotaux(); });
  $('#vider', el).onclick = () => { S.cart = {}; renderPanier(); };
  $('#valider', el).onclick = validerCommande;
  renderTotaux();
}

function renderTotaux() {
  const lines = cartLines();
  const food = lines.reduce((s, l) => s + l.p.price * l.qty, 0);
  // Bouton flottant (téléphone) pour descendre jusqu'à la commande
  const go = $('#go-panier');
  const n = lines.reduce((s, l) => s + l.qty, 0);
  go.classList.toggle('hidden', n === 0);
  go.textContent = `Voir la commande (${n}) · ${da(food)}`;
  const el = $('#totaux');
  if (S.type !== 'livraison') {
    el.innerHTML = `<div class="tot big"><span>Total</span><span>${da(food)}</span></div>`;
    return;
  }
  const fee = Number(S.form.fee) || 0;
  el.innerHTML = `
    <div class="tot"><span>Nourriture</span><span>${da(food)}</span></div>
    <div class="tot"><span>Livraison (pour le livreur)</span><span>${da(fee)}</span></div>
    <div class="tot big"><span>Le client paie</span><span>${da(food + fee)}</span></div>
    <div class="tot warn"><span>🛵 Le livreur doit rendre</span><span>${da(food)}</span></div>`;
}

async function validerCommande() {
  const btn = $('#valider');
  btn.disabled = true;
  try {
    const r = await api('/api/orders', {
      method: 'POST',
      body: {
        type: S.type,
        items: cartLines().map(l => ({ product_id: l.p.id, qty: l.qty })),
        livreur_id: S.form.livreur_id,
        delivery_fee: Number(S.form.fee) || 0,
        client_name: S.form.client_name,
        client_phone: S.form.client_phone,
        address: S.form.address,
        note: S.form.note,
      },
    });
    toast(`✅ Commande n°${r.id} enregistrée — ${da(r.food_total + r.delivery_fee)}`);
    S.cart = {};
    S.form = {};
    renderPanier();
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
  }
}

// ---------- Commandes ----------

async function renderCommandes(el) {
  const orders = await api(`/api/orders?from=${S.ordersDate}&to=${S.ordersDate}`);
  const ok = orders.filter(o => o.status !== 'annulee');
  const total = ok.reduce((s, o) => s + o.food_total, 0);
  const enCours = ok.filter(o => o.status === 'en_cours').length;

  el.innerHTML = `
    <div class="section-title">
      <h2>Commandes</h2>
      <div class="toolbar" style="margin:0">
        <label>Jour <input type="date" id="o-date" value="${S.ordersDate}"></label>
        <button class="btn" id="o-today">Aujourd'hui</button>
      </div>
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="label">Commandes</div><div class="value">${ok.length}</div></div>
      <div class="card kpi"><div class="label">Ventes (nourriture)</div><div class="value">${da(total)}</div></div>
      <div class="card kpi"><div class="label">En livraison maintenant</div><div class="value">${enCours}</div></div>
    </div>
    <div class="card table-wrap" style="padding:0">
      <table>
        <thead><tr>
          <th>N°</th><th>Heure</th><th>Type</th><th>Articles</th>
          <th class="num">Nourriture</th><th class="num">Livraison</th><th>Statut</th><th></th>
        </tr></thead>
        <tbody>
          ${orders.map(o => `
            <tr class="${o.status}">
              <td><b>${o.id}</b></td>
              <td>${hour(o.created_at)}</td>
              <td>
                <span class="badge type">${TYPES[o.type]}</span>
                ${o.livreur_name ? `<div class="items">🛵 ${esc(o.livreur_name)}</div>` : ''}
                ${o.client_name || o.address ? `<div class="items">${esc(o.client_name)} ${esc(o.client_phone)}<br>${esc(o.address)}</div>` : ''}
              </td>
              <td class="items">
                ${o.items.map(i => `${i.qty} × ${esc(i.name)}`).join('<br>')}
                ${o.note ? `<br><i>« ${esc(o.note)} »</i>` : ''}
              </td>
              <td class="num"><b>${da(o.food_total)}</b></td>
              <td class="num">${o.type === 'livraison' ? da(o.delivery_fee) : '—'}</td>
              <td><span class="badge ${o.status}">${STATUS[o.status]}</span></td>
              <td><div class="actions">
                ${o.status === 'en_cours' ? `<button class="btn small green" data-livree="${o.id}">Livrée</button>` : ''}
                ${isAdmin() && o.status !== 'annulee' ? `<button class="btn small danger" data-annuler="${o.id}">Annuler</button>` : ''}
              </div></td>
            </tr>`).join('') || '<tr><td colspan="8" class="muted">Aucune commande ce jour-là.</td></tr>'}
        </tbody>
      </table>
    </div>`;

  $('#o-date', el).onchange = e => { S.ordersDate = e.target.value || ymd(); renderCommandes(el); };
  $('#o-today', el).onclick = () => { S.ordersDate = ymd(); renderCommandes(el); };
  $$('[data-livree]', el).forEach(b => b.onclick = () => attempt(async () => {
    await api(`/api/orders/${b.dataset.livree}/status`, { method: 'PATCH', body: { status: 'livree' } });
    toast('Commande marquée livrée');
    renderCommandes(el);
  }));
  $$('[data-annuler]', el).forEach(b => b.onclick = () => confirmer(
    `Annuler la commande n°${b.dataset.annuler} ? Elle ne comptera plus dans les ventes ni dans la dette du livreur.`,
    async () => {
      await api(`/api/orders/${b.dataset.annuler}/status`, { method: 'PATCH', body: { status: 'annulee' } });
      toast('Commande annulée');
      renderCommandes(el);
    }));
}

function confirmer(message, onYes) {
  const box = openModal(`
    <h2>Confirmer</h2>
    <p>${esc(message)}</p>
    <div class="modal-actions">
      <button class="btn" data-close>Non</button>
      <button class="btn primary" id="yes">Oui</button>
    </div>`);
  $('#yes', box).onclick = () => attempt(async () => { await onYes(); closeModal(); });
}

// ---------- Livreurs ----------

async function renderLivreurs(el) {
  const comptes = await api(`/api/livreurs/comptes?from=${ymd()}&to=${ymd()}`);
  const totalDette = comptes.reduce((s, l) => s + Math.max(l.reste, 0), 0);

  el.innerHTML = `
    <div class="section-title">
      <h2>Livreurs</h2>
      <button class="btn primary" id="add-livreur">+ Ajouter un livreur</button>
    </div>
    <div class="kpis">
      <div class="card kpi ${totalDette > 0 ? 'alert' : 'good'}">
        <div class="label">Argent encore chez les livreurs</div>
        <div class="value">${da(totalDette)}</div>
        <div class="sub">Ce qu'ils doivent rendre au restaurant</div>
      </div>
    </div>
    <p class="muted">Règle : le livreur garde les frais de livraison et rend le prix de la nourriture.
      Quand il te donne de l'argent, clique sur « Il a rendu de l'argent ».</p>
    <div class="livreurs">
      ${comptes.map(l => `
        <div class="card livreur">
          <h2>🛵 ${esc(l.name)} ${l.active ? '' : '<span class="badge annulee">ancien</span>'}</h2>
          <div class="muted">${esc(l.phone) || 'pas de téléphone'}</div>
          <div class="reste ${l.reste > 0 ? 'dette' : ''}">
            <div class="label">${l.reste > 0 ? 'Il doit rendre' : l.reste < 0 ? 'Il a rendu en trop' : 'Compte à jour'}</div>
            <div class="value">${da(Math.abs(l.reste))}</div>
          </div>
          <div class="mini">
            <div>Livraisons aujourd'hui<b>${l.nb}</b></div>
            <div>En route maintenant<b>${l.en_cours}</b></div>
            <div>Nourriture aujourd'hui<b>${da(l.ventes)}</b></div>
            <div>Ses frais aujourd'hui<b>${da(l.frais)}</b></div>
            <div>Rendu aujourd'hui<b>${da(l.verse_periode)}</b></div>
          </div>
          <div class="actions" style="justify-content:flex-start">
            <button class="btn primary small" data-verser="${l.id}">💵 Il a rendu de l'argent</button>
            <button class="btn small" data-histo="${l.id}">Historique</button>
            <button class="btn small ghost" data-edit="${l.id}">Modifier</button>
          </div>
        </div>`).join('') || '<p class="muted">Aucun livreur pour l\'instant.</p>'}
    </div>`;

  const byId = id => comptes.find(l => l.id == id);
  $('#add-livreur', el).onclick = () => editLivreur(null, el);
  $$('[data-edit]', el).forEach(b => b.onclick = () => editLivreur(byId(b.dataset.edit), el));
  $$('[data-verser]', el).forEach(b => b.onclick = () => verser(byId(b.dataset.verser), el));
  $$('[data-histo]', el).forEach(b => b.onclick = () => attempt(() => historique(b.dataset.histo, el)));
}

function editLivreur(l, pageEl) {
  const box = openModal(`
    <h2>${l ? 'Modifier le livreur' : 'Nouveau livreur'}</h2>
    <form id="lf">
      <label>Nom <input name="name" value="${esc(l?.name)}" required></label>
      <label>Téléphone <input name="phone" type="tel" value="${esc(l?.phone)}"></label>
      ${l ? `<label style="flex-direction:row;align-items:center;gap:8px">
        <input type="checkbox" name="active" ${l.active ? 'checked' : ''}> Travaille encore chez nous</label>` : ''}
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
    toast('Livreur enregistré');
    renderLivreurs(pageEl);
  });
}

function verser(l, pageEl) {
  const box = openModal(`
    <h2>💵 ${esc(l.name)} rend de l'argent</h2>
    <p>Il doit actuellement <b class="plus">${da(Math.max(l.reste, 0))}</b>.</p>
    <form id="vf">
      <label>Montant reçu (DA) <input name="amount" type="number" min="1" step="1" value="${Math.max(l.reste, 0) || ''}" required autofocus></label>
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
    toast('Versement enregistré');
    renderLivreurs(pageEl);
  });
}

async function historique(id, pageEl) {
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
              <td>Commande n°${l.id} <span class="items">${esc(l.client_name)} ${esc(l.address)} · frais ${da(l.delivery_fee)}</span></td>
              <td class="num plus">+ ${da(l.food_total)}</td><td></td>
              <td class="num">${da(l.solde)}</td><td></td>
            </tr>` : `
            <tr>
              <td>${dateFr(l.created_at)}</td>
              <td>💵 Versement ${l.note ? `<span class="items">${esc(l.note)}</span>` : ''}</td>
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
    await historique(id, pageEl);
    renderLivreurs(pageEl);
  }));
}

// ---------- Tableau de bord ----------

const PRESETS = {
  jour: () => [ymd(), ymd()],
  hier: () => [ymd(addDays(-1)), ymd(addDays(-1))],
  semaine: () => [ymd(addDays(-6)), ymd()],
  mois: () => { const d = new Date(); return [ymd(new Date(d.getFullYear(), d.getMonth(), 1)), ymd()]; },
};

async function renderDashboard(el) {
  const { from, to } = S.dash;
  const st = await api(`/api/stats?from=${from}&to=${to}`);
  const t = st.totals;
  const encaisse = t.caisse_directe + t.verse_livreurs;

  el.innerHTML = `
    <div class="section-title">
      <h2>Tableau de bord</h2>
      <div class="toolbar" style="margin:0">
        <div class="seg" style="margin:0">
          ${[['jour', "Aujourd'hui"], ['hier', 'Hier'], ['semaine', '7 jours'], ['mois', 'Ce mois']].map(([k, l]) =>
            `<button data-preset="${k}" class="${S.dash.preset === k ? 'on' : ''}">${l}</button>`).join('')}
        </div>
        <label>Du <input type="date" id="d-from" value="${from}"></label>
        <label>Au <input type="date" id="d-to" value="${to}"></label>
      </div>
    </div>

    <div class="kpis">
      <div class="card kpi">
        <div class="label">Ventes (nourriture)</div>
        <div class="value">${da(t.ventes)}</div>
        <div class="sub">${t.nb} commandes · ${t.annulees} annulée(s)</div>
      </div>
      <div class="card kpi good">
        <div class="label">Argent entré dans la caisse</div>
        <div class="value">${da(encaisse)}</div>
        <div class="sub">${da(t.caisse_directe)} sur place/emporter + ${da(t.verse_livreurs)} rendus par les livreurs</div>
      </div>
      <div class="card kpi ${st.chez_livreurs > 0 ? 'alert' : 'good'}">
        <div class="label">Encore chez les livreurs</div>
        <div class="value">${da(st.chez_livreurs)}</div>
        <div class="sub">Total à récupérer (tous les jours)</div>
      </div>
      <div class="card kpi">
        <div class="label">Frais de livraison</div>
        <div class="value">${da(t.frais_livraison)}</div>
        <div class="sub">Gagnés par les livreurs</div>
      </div>
      <div class="card kpi">
        <div class="label">Type de commandes</div>
        <div class="value" style="font-size:18px">${t.nb_surplace} · ${t.nb_emporter} · ${t.nb_livraison}</div>
        <div class="sub">sur place · à emporter · livraison</div>
      </div>
    </div>

    <div class="two">
      <div class="card">
        <h2>Produits vendus</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Produit</th><th class="num">Quantité</th><th class="num">Montant</th></tr></thead>
            <tbody>
              ${st.produits.map(p => `<tr><td>${esc(p.name)}</td><td class="num"><b>${p.qty}</b></td><td class="num">${da(p.montant)}</td></tr>`).join('')
                || '<tr><td colspan="3" class="muted">Aucune vente sur cette période.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <h2>Livreurs</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Livreur</th><th class="num">Livraisons</th><th class="num">Nourriture</th><th class="num">Ses frais</th><th class="num">Rendu</th><th class="num">Doit encore</th></tr></thead>
            <tbody>
              ${st.livreurs.map(l => `
                <tr>
                  <td>${esc(l.name)}</td>
                  <td class="num">${l.nb}</td>
                  <td class="num">${da(l.ventes)}</td>
                  <td class="num">${da(l.frais)}</td>
                  <td class="num">${da(l.verse_periode)}</td>
                  <td class="num ${l.reste > 0 ? 'plus' : 'moins'}">${da(l.reste)}</td>
                </tr>`).join('') || '<tr><td colspan="6" class="muted">Aucun livreur.</td></tr>'}
            </tbody>
          </table>
        </div>
        <p class="muted" style="font-size:12px">« Doit encore » = tout ce qu'il a pris depuis le début − tout ce qu'il a rendu.</p>
      </div>
    </div>`;

  $$('[data-preset]', el).forEach(b => b.onclick = () => {
    const [f, t2] = PRESETS[b.dataset.preset]();
    S.dash = { from: f, to: t2, preset: b.dataset.preset };
    renderDashboard(el);
  });
  const custom = () => {
    const f = $('#d-from', el).value, t2 = $('#d-to', el).value;
    if (!f || !t2) return;
    S.dash = { from: f <= t2 ? f : t2, to: f <= t2 ? t2 : f, preset: '' };
    renderDashboard(el);
  };
  $('#d-from', el).onchange = custom;
  $('#d-to', el).onchange = custom;
}

// ---------- Produits ----------

async function renderProduits(el) {
  const all = await api('/api/products?all=1');
  const cats = [...new Set(all.map(p => p.category))];

  el.innerHTML = `
    <div class="section-title"><h2>Produits (menu)</h2></div>
    <form class="card form-row" id="pf" style="margin-bottom:16px">
      <label>Nom <input name="name" required placeholder="ex : Pizza poulet"></label>
      <label>Catégorie <input name="category" list="cats" placeholder="ex : Pizzas"></label>
      <label style="max-width:140px">Prix (DA) <input name="price" type="number" min="0" step="10" required></label>
      <button class="btn primary">+ Ajouter</button>
      <datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    </form>
    <div class="card table-wrap" style="padding:0">
      <table>
        <thead><tr><th>Nom</th><th>Catégorie</th><th>Prix (DA)</th><th>En vente</th><th></th></tr></thead>
        <tbody>
          ${all.map(p => `
            <tr data-row="${p.id}">
              <td><input data-k="name" value="${esc(p.name)}"></td>
              <td><input data-k="category" value="${esc(p.category)}" list="cats"></td>
              <td><input data-k="price" type="number" min="0" step="10" value="${p.price}" style="width:110px"></td>
              <td><input data-k="active" type="checkbox" ${p.active ? 'checked' : ''}></td>
              <td><button class="btn small" data-save="${p.id}">Enregistrer</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="muted">Changer un prix ne change pas les anciennes commandes. Décoche « En vente » pour cacher un produit de la caisse.</p>`;

  $('#pf', el).onsubmit = e => attempt(async () => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/api/products', {
      method: 'POST',
      body: { name: f.get('name'), category: f.get('category'), price: Number(f.get('price')) },
    });
    toast('Produit ajouté');
    S.products = await api('/api/products');
    renderProduits(el);
  });

  $$('[data-save]', el).forEach(b => b.onclick = () => attempt(async () => {
    const row = $(`[data-row="${b.dataset.save}"]`, el);
    const v = k => $(`[data-k="${k}"]`, row);
    await api(`/api/products/${b.dataset.save}`, {
      method: 'PUT',
      body: { name: v('name').value, category: v('category').value, price: Number(v('price').value), active: v('active').checked },
    });
    toast('Produit enregistré');
    S.products = await api('/api/products');
  }));
}

// ---------- Paramètres ----------

async function renderParametres(el) {
  const users = isAdmin() ? await api('/api/users') : [];

  el.innerHTML = `
    <div class="two">
      ${isAdmin() ? `
        <form class="card" id="sf">
          <h2>Restaurant</h2>
          <label>Nom du restaurant <input name="restaurant_name" value="${esc(S.settings.restaurant_name)}"></label>
          <label>Frais de livraison par défaut (DA) <input name="delivery_fee" type="number" min="0" step="10" value="${S.settings.delivery_fee}"></label>
          <button class="btn primary">Enregistrer</button>
        </form>` : ''}

      <form class="card" id="pwf">
        <h2>Mon mot de passe</h2>
        <label>Ancien mot de passe <input name="old" type="password" required autocomplete="current-password"></label>
        <label>Nouveau mot de passe <input name="password" type="password" minlength="6" required autocomplete="new-password"></label>
        <button class="btn primary">Changer</button>
      </form>

      ${isAdmin() ? `
        <div class="card">
          <h2>Comptes</h2>
          <p class="muted">Le <b>caissier</b> peut prendre les commandes et marquer « livrée ». Seul l'<b>admin</b> voit l'argent, les livreurs et peut annuler.</p>
          <table>
            <tbody>
              ${users.map(u => `
                <tr>
                  <td><b>${esc(u.username)}</b></td>
                  <td><span class="badge type">${u.role}</span></td>
                  <td class="num">${u.id === S.me.id ? '<span class="muted">toi</span>'
                    : `<button class="btn small danger" data-deluser="${u.id}" data-name="${esc(u.username)}">Supprimer</button>`}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          <form id="uf" style="margin-top:14px">
            <div class="form-row">
              <label>Nom <input name="username" required minlength="3" autocomplete="off"></label>
              <label>Mot de passe <input name="password" type="password" required minlength="6" autocomplete="new-password"></label>
            </div>
            <div class="form-row" style="margin-top:10px">
              <label>Rôle
                <select name="role"><option value="caissier">Caissier</option><option value="admin">Admin</option></select>
              </label>
              <button class="btn primary">+ Ajouter le compte</button>
            </div>
          </form>
        </div>` : ''}
    </div>`;

  $('#sf', el)?.addEventListener('submit', e => attempt(async () => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/api/settings', {
      method: 'PUT',
      body: { restaurant_name: f.get('restaurant_name'), delivery_fee: Number(f.get('delivery_fee')) },
    });
    await loadBase();
    S.form.fee = undefined;
    toast('Réglages enregistrés');
  }));

  $('#pwf', el).onsubmit = e => attempt(async () => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/api/me/password', { method: 'PUT', body: { old: f.get('old'), password: f.get('password') } });
    e.target.reset();
    toast('Mot de passe changé');
  });

  $('#uf', el)?.addEventListener('submit', e => attempt(async () => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/api/users', {
      method: 'POST',
      body: { username: f.get('username'), password: f.get('password'), role: f.get('role') },
    });
    toast('Compte ajouté');
    renderParametres(el);
  }));

  $$('[data-deluser]', el).forEach(b => b.onclick = () => confirmer(
    `Supprimer le compte « ${b.dataset.name} » ?`,
    async () => {
      await api(`/api/users/${b.dataset.deluser}`, { method: 'DELETE' });
      toast('Compte supprimé');
      renderParametres(el);
    }));
}

boot().catch(e => toast(e.message, true));

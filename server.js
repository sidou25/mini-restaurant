const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const { pool, init, all, one, transaction } = require('./db');

const app = express();
const PORT = process.env.PORT || 3100;
const onVercel = Boolean(process.env.VERCEL);
const isProd = onVercel || process.env.NODE_ENV === 'production';

app.set('trust proxy', 1); // Vercel est devant nous (HTTPS + vraie IP du client)
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Version du site : change à chaque mise en ligne (le navigateur se recharge tout seul)
const VERSION = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now());

// Avant toute route /api : configuration présente et base prête (sinon message clair)
app.use('/api', (req, res, next) => {
  res.set('X-App-Version', VERSION);
  if (isProd && !process.env.SESSION_SECRET) {
    return res.status(500).json({ error: "SESSION_SECRET manquant dans les variables d'environnement" });
  }
  init().then(() => next(), err => {
    console.error('Base de données :', err.message);
    res.status(503).json({ error: 'Base de données injoignable' });
  });
});

// La session (qui est connecté) est gardée dans PostgreSQL, table "session"
app.use(session({
  store: new PgSession({ pool, pruneSessionInterval: onVercel ? false : 15 * 60 }),
  name: 'sid',
  secret: process.env.SESSION_SECRET || 'dev-seulement',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000 * 60 * 60 * 24 * 30 },
}));

// Pas plus de 10 essais de mot de passe par quart d'heure
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: { error: 'Trop d’essais, réessaie dans 15 minutes' },
});

// ---------- Outils ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

const sameText = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Erreur affichée telle quelle à l'utilisateur
function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

// Attrape les erreurs des routes et renvoie un JSON propre
const route = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Erreur du serveur' });
  }
};

// Montant en dinars : entier positif
function money(value, label = 'Montant') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) fail(`${label} invalide`);
  return n;
}

const text = (value, max = 200) => String(value ?? '').trim().slice(0, max);
const id = value => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
const today = async () => (await one("SELECT (now() AT TIME ZONE 'Africa/Algiers')::date AS d")).d;

async function period(req) {
  const from = isDate(req.query.from) ? req.query.from : await today();
  const to = isDate(req.query.to) ? req.query.to : from;
  return [from, to];
}

// Relit le compte à chaque requête : un compte supprimé ou un livreur désactivé est coupé tout de suite
const findUser = userId => one(`
  SELECT u.id, u.username, u.role, u.livreur_id, l.name AS livreur_name
  FROM users u LEFT JOIN livreurs l ON l.id = u.livreur_id
  WHERE u.id = $1 AND (u.role != 'livreur' OR l.active)`, [userId]);

// allow() = tout compte connecté ; allow('admin') = seulement l'admin, etc.
const allow = (...roles) => (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  findUser(req.session.user.id).then(user => {
    if (!user) {
      req.session.user = null;
      return res.status(401).json({ error: 'Non connecté' });
    }
    if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'Accès refusé' });
    req.user = user;
    next();
  }, next);
};
const auth = allow();
const staff = allow('admin', 'caissier'); // la caisse
const admin = allow('admin');
const livreurOnly = allow('livreur');

// ---------- Connexion ----------

const userCount = async () => (await one('SELECT COUNT(*) AS n FROM users')).n;

app.get('/api/setup', route(async (req, res) => {
  res.json({ needsSetup: (await userCount()) === 0, needsCode: Boolean(process.env.SETUP_CODE) });
}));

// Premier lancement : création du compte admin (protégée par SETUP_CODE en ligne)
app.post('/api/setup', loginLimit, route(async (req, res) => {
  if ((await userCount()) > 0) fail('Le compte admin existe déjà', 403);
  if (isProd && !process.env.SETUP_CODE) fail("SETUP_CODE manquant dans les variables d'environnement", 500);
  if (process.env.SETUP_CODE && !sameText(req.body.code || '', process.env.SETUP_CODE)) {
    fail("Code d'installation incorrect", 403);
  }
  const username = text(req.body.username, 40);
  const password = String(req.body.password || '');
  if (username.length < 3) fail("Nom d'utilisateur trop court (3 lettres minimum)");
  if (password.length < 6) fail('Mot de passe trop court (6 caractères minimum)');
  const user = await one(
    "INSERT INTO users (username, password, role) VALUES ($1, $2, 'admin') RETURNING id, username, role",
    [username, hashPassword(password)],
  );
  req.session.user = { id: user.id };
  res.json(user);
}));

app.post('/api/login', loginLimit, route(async (req, res) => {
  const row = await one('SELECT * FROM users WHERE username = $1', [text(req.body.username, 40)]);
  if (!row || !checkPassword(String(req.body.password || ''), row.password)) {
    fail('Identifiants incorrects', 401);
  }
  const user = await findUser(row.id);
  if (!user) fail('Ce compte livreur est désactivé', 403);
  req.session.user = { id: user.id };
  res.json(user);
}));

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', auth, (req, res) => res.json(req.user));

app.put('/api/me/password', auth, route(async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!checkPassword(String(req.body.old || ''), user.password)) fail('Ancien mot de passe incorrect');
  const pw = String(req.body.password || '');
  if (pw.length < 6) fail('Mot de passe trop court (6 caractères minimum)');
  await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashPassword(pw), user.id]);
  res.json({ ok: true });
}));

// ---------- Utilisateurs (admin) ----------

app.get('/api/users', admin, route(async (req, res) => {
  res.json(await all(`
    SELECT u.id, u.username, u.role, l.name AS livreur_name
    FROM users u LEFT JOIN livreurs l ON l.id = u.livreur_id ORDER BY u.id`));
}));

app.post('/api/users', admin, route(async (req, res) => {
  const username = text(req.body.username, 40);
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'caissier';
  if (username.length < 3) fail("Nom d'utilisateur trop court");
  if (password.length < 6) fail('Mot de passe trop court (6 caractères minimum)');
  if (await one('SELECT 1 FROM users WHERE username = $1', [username])) fail('Ce nom existe déjà');
  await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)',
    [username, hashPassword(password), role]);
  res.json({ ok: true });
}));

app.delete('/api/users/:id', admin, route(async (req, res) => {
  if (id(req.params.id) === req.user.id) fail('Tu ne peux pas supprimer ton propre compte');
  await pool.query('DELETE FROM users WHERE id = $1', [id(req.params.id)]);
  res.json({ ok: true });
}));

// ---------- Réglages ----------

app.get('/api/settings', auth, route(async (req, res) => {
  const rows = await all('SELECT key, value FROM settings');
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  s.delivery_fee = Number(s.delivery_fee);
  res.json(s);
}));

app.put('/api/settings', admin, route(async (req, res) => {
  const name = text(req.body.restaurant_name, 60) || 'Mini Restaurant';
  const fee = money(req.body.delivery_fee, 'Frais de livraison');
  await pool.query(`
    INSERT INTO settings (key, value) VALUES ('restaurant_name', $1), ('delivery_fee', $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [name, String(fee)]);
  res.json({ ok: true });
}));

// ---------- Produits ----------

app.get('/api/products', staff, route(async (req, res) => {
  const showAll = req.query.all === '1' && req.user.role === 'admin';
  // Les catégories restent dans l'ordre où elles ont été créées
  res.json(await all(`
    SELECT * FROM products ${showAll ? '' : 'WHERE active'}
    ORDER BY (SELECT MIN(id) FROM products p2 WHERE p2.category = products.category), id`));
}));

function readProduct(body) {
  const name = text(body.name, 60);
  if (!name) fail('Nom du produit obligatoire');
  return [name, text(body.category, 40) || 'Autres', money(body.price, 'Prix')];
}

app.post('/api/products', admin, route(async (req, res) => {
  await pool.query('INSERT INTO products (name, category, price) VALUES ($1, $2, $3)', readProduct(req.body));
  res.json({ ok: true });
}));

// Changer le prix ne touche pas les anciennes commandes (le prix est copié dans order_items)
app.put('/api/products/:id', admin, route(async (req, res) => {
  await pool.query('UPDATE products SET name = $1, category = $2, price = $3, active = $4 WHERE id = $5',
    [...readProduct(req.body), req.body.active !== false, id(req.params.id)]);
  res.json({ ok: true });
}));

// ---------- Livreurs ----------

app.get('/api/livreurs', staff, route(async (req, res) => {
  res.json(await all('SELECT * FROM livreurs WHERE active ORDER BY name'));
}));

app.post('/api/livreurs', admin, route(async (req, res) => {
  const name = text(req.body.name, 60);
  if (!name) fail('Nom du livreur obligatoire');
  await pool.query('INSERT INTO livreurs (name, phone) VALUES ($1, $2)', [name, text(req.body.phone, 30)]);
  res.json({ ok: true });
}));

app.put('/api/livreurs/:id', admin, route(async (req, res) => {
  const name = text(req.body.name, 60);
  if (!name) fail('Nom du livreur obligatoire');
  await pool.query('UPDATE livreurs SET name = $1, phone = $2, active = $3 WHERE id = $4',
    [name, text(req.body.phone, 30), req.body.active !== false, id(req.params.id)]);
  res.json({ ok: true });
}));

// Supprimer un livreur. S'il doit encore de l'argent, il faut ?force=1 (le patron accepte d'oublier la dette).
// S'il a déjà travaillé, on le cache seulement (ses anciennes commandes restent dans les ventes).
app.delete('/api/livreurs/:id', admin, route(async (req, res) => {
  const l = await one(`
    SELECT l.id, l.name,
      (SELECT COALESCE(SUM(food_total), 0) FROM orders o WHERE o.livreur_id = l.id AND o.status != 'annulee')
        - (SELECT COALESCE(SUM(amount), 0) FROM versements v WHERE v.livreur_id = l.id) AS reste,
      EXISTS (SELECT 1 FROM orders o WHERE o.livreur_id = l.id)
        OR EXISTS (SELECT 1 FROM versements v WHERE v.livreur_id = l.id) AS has_history
    FROM livreurs l WHERE l.id = $1`, [id(req.params.id)]);
  if (!l) fail('Livreur introuvable', 404);
  if (l.reste > 0 && req.query.force !== '1') {
    fail(`${l.name} doit encore ${l.reste.toLocaleString('fr-FR')} DA. Encaisse d'abord son argent, puis supprime-le.`);
  }
  await transaction(async client => {
    await client.query('DELETE FROM users WHERE livreur_id = $1', [l.id]);
    if (l.has_history) await client.query('UPDATE livreurs SET active = FALSE WHERE id = $1', [l.id]);
    else await client.query('DELETE FROM livreurs WHERE id = $1', [l.id]);
  });
  res.json({ ok: true });
}));

// Le compte de chaque livreur.
// Règle : dès qu'une commande part avec le livreur, il doit rendre le prix de la nourriture
// (food_total). Les frais de livraison sont à lui. Seul l'admin peut annuler une commande.
// reste = tout ce qu'il doit depuis le début − tout ce qu'il a déjà versé.
async function livreurComptes(from, to, onlyId = null) {
  const rows = await all(`
    SELECT l.id, l.name, l.phone, l.active,
      (SELECT COUNT(*) FROM orders o WHERE o.livreur_id = l.id AND o.status != 'annulee'
         AND o.created_at::date BETWEEN $1 AND $2) AS nb,
      (SELECT COALESCE(SUM(food_total), 0) FROM orders o WHERE o.livreur_id = l.id AND o.status != 'annulee'
         AND o.created_at::date BETWEEN $1 AND $2) AS ventes,
      (SELECT COALESCE(SUM(delivery_fee), 0) FROM orders o WHERE o.livreur_id = l.id AND o.status != 'annulee'
         AND o.created_at::date BETWEEN $1 AND $2) AS frais,
      (SELECT COALESCE(SUM(amount), 0) FROM versements v WHERE v.livreur_id = l.id
         AND v.created_at::date BETWEEN $1 AND $2) AS verse_periode,
      (SELECT COUNT(*) FROM orders o WHERE o.livreur_id = l.id AND o.status = 'en_cours') AS en_cours,
      (SELECT COALESCE(SUM(food_total), 0) FROM orders o WHERE o.livreur_id = l.id AND o.status != 'annulee') AS du_total,
      (SELECT COALESCE(SUM(amount), 0) FROM versements v WHERE v.livreur_id = l.id) AS verse_total,
      (SELECT username FROM users u WHERE u.livreur_id = l.id) AS acces
    FROM livreurs l
    WHERE $3::int IS NULL OR l.id = $3
    ORDER BY l.active DESC, l.name`, [from, to, onlyId]);
  return rows.map(l => ({ ...l, reste: l.du_total - l.verse_total }))
    // un livreur supprimé reste seulement dans les chiffres de la période où il a travaillé
    .filter(l => l.active || l.nb > 0);
}

app.get('/api/livreurs/comptes', admin, route(async (req, res) => {
  res.json(await livreurComptes(...await period(req)));
}));

// Historique : commandes (+ ce qu'il doit) et versements (− ce qu'il a rendu), avec solde
app.get('/api/livreurs/:id/compte', admin, route(async (req, res) => {
  const livreur = await one('SELECT * FROM livreurs WHERE id = $1', [id(req.params.id)]);
  if (!livreur) fail('Livreur introuvable', 404);
  const orders = (await all(`
    SELECT id, created_at, food_total, delivery_fee, status, client_name, address
    FROM orders WHERE livreur_id = $1 AND status != 'annulee'`, [livreur.id]))
    .map(o => ({ kind: 'commande', ...o }));
  const versements = (await all('SELECT id, created_at, amount, note FROM versements WHERE livreur_id = $1', [livreur.id]))
    .map(v => ({ kind: 'versement', ...v }));

  let solde = 0;
  const lignes = [...orders, ...versements]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || (a.kind === 'commande' ? -1 : 1))
    .map(l => {
      solde += l.kind === 'commande' ? l.food_total : -l.amount;
      return { ...l, solde };
    })
    .reverse();
  res.json({ livreur, solde, lignes });
}));

// Créer ou changer l'accès (nom + mot de passe) d'un livreur
app.put('/api/livreurs/:id/acces', admin, route(async (req, res) => {
  const livreur = await one('SELECT id FROM livreurs WHERE id = $1', [id(req.params.id)]);
  if (!livreur) fail('Livreur introuvable', 404);
  const username = text(req.body.username, 40);
  const password = String(req.body.password || '');
  if (username.length < 3) fail("Nom d'utilisateur trop court (3 lettres minimum)");
  if (password.length < 6) fail('Mot de passe trop court (6 caractères minimum)');
  const taken = await one('SELECT 1 FROM users WHERE username = $1 AND livreur_id IS DISTINCT FROM $2', [username, livreur.id]);
  if (taken) fail('Ce nom est déjà pris');
  await pool.query(`
    INSERT INTO users (username, password, role, livreur_id) VALUES ($1, $2, 'livreur', $3)
    ON CONFLICT (livreur_id) DO UPDATE SET username = EXCLUDED.username, password = EXCLUDED.password`,
  [username, hashPassword(password), livreur.id]);
  res.json({ ok: true });
}));

app.delete('/api/livreurs/:id/acces', admin, route(async (req, res) => {
  await pool.query('DELETE FROM users WHERE livreur_id = $1', [id(req.params.id)]);
  res.json({ ok: true });
}));

// La page du livreur : ses commandes à livrer, ce qu'il a livré aujourd'hui, ce qu'il doit
app.get('/api/livreur/moi', livreurOnly, route(async (req, res) => {
  const lid = req.user.livreur_id;
  const day = await today();
  const aLivrer = await all(`${ORDER_SELECT}
    WHERE o.livreur_id = $1 AND o.status = 'en_cours' ORDER BY o.id`, [lid]);
  const livrees = await all(`${ORDER_SELECT}
    WHERE o.livreur_id = $1 AND o.status = 'livree' AND o.created_at::date = $2 ORDER BY o.id DESC`, [lid, day]);
  const [compte] = await livreurComptes(day, day, lid);
  res.json({
    a_livrer: await withItems(aLivrer),
    livrees: await withItems(livrees),
    reste: compte?.reste ?? 0,
    nb: compte?.nb ?? 0,
    frais: compte?.frais ?? 0,
  });
}));

// ---------- Versements (le livreur rend l'argent) ----------

app.post('/api/versements', admin, route(async (req, res) => {
  const livreur = await one('SELECT id FROM livreurs WHERE id = $1', [id(req.body.livreur_id)]);
  if (!livreur) fail('Livreur introuvable');
  const amount = money(req.body.amount);
  if (amount === 0) fail('Le montant doit être plus grand que 0');
  await pool.query('INSERT INTO versements (livreur_id, amount, note, created_by) VALUES ($1, $2, $3, $4)',
    [livreur.id, amount, text(req.body.note), req.user.id]);
  res.json({ ok: true });
}));

app.delete('/api/versements/:id', admin, route(async (req, res) => {
  await pool.query('DELETE FROM versements WHERE id = $1', [id(req.params.id)]);
  res.json({ ok: true });
}));

// ---------- Commandes ----------

app.post('/api/orders', staff, route(async (req, res) => {
  const { type, items } = req.body;
  if (!['surplace', 'emporter', 'livraison'].includes(type)) fail('Type de commande invalide');
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) fail('La commande est vide');

  // Les prix viennent toujours de la base, jamais du navigateur
  const products = await all('SELECT * FROM products WHERE active AND id = ANY($1::int[])',
    [items.map(it => id(it.product_id))]);
  const lines = items.map(it => {
    const p = products.find(x => x.id === id(it.product_id));
    if (!p) fail('Produit introuvable');
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) fail('Quantité invalide');
    return { p, qty };
  });
  const food = lines.reduce((s, l) => s + l.p.price * l.qty, 0);

  let livreurId = null;
  let fee = 0;
  if (type === 'livraison') {
    const l = await one('SELECT id FROM livreurs WHERE id = $1 AND active', [id(req.body.livreur_id)]);
    if (!l) fail('Choisis un livreur');
    livreurId = l.id;
    fee = money(req.body.delivery_fee, 'Frais de livraison');
  }

  const orderId = await transaction(async client => {
    const { rows } = await client.query(`
      INSERT INTO orders (type, livreur_id, client_name, client_phone, address, note,
                          food_total, delivery_fee, status, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`, [
      type, livreurId, text(req.body.client_name, 60), text(req.body.client_phone, 30),
      text(req.body.address), text(req.body.note), food, fee,
      type === 'livraison' ? 'en_cours' : 'terminee', req.user.id,
    ]);
    for (const l of lines) {
      await client.query('INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES ($1, $2, $3, $4, $5)',
        [rows[0].id, l.p.id, l.p.name, l.p.price, l.qty]);
    }
    return rows[0].id;
  });

  res.json(await getOrder(orderId));
}));

const ORDER_SELECT = `
  SELECT o.*, l.name AS livreur_name, u.username AS created_by_name
  FROM orders o
  LEFT JOIN livreurs l ON l.id = o.livreur_id
  LEFT JOIN users u ON u.id = o.created_by`;

// Ajoute les articles à chaque commande (une seule requête)
async function withItems(orders) {
  const items = orders.length
    ? await all('SELECT * FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY id', [orders.map(o => o.id)])
    : [];
  orders.forEach(o => { o.items = items.filter(i => i.order_id === o.id); });
  return orders;
}

async function getOrder(orderId) {
  const [order] = await withItems(await all(`${ORDER_SELECT} WHERE o.id = $1`, [orderId]));
  return order;
}

app.get('/api/orders', staff, route(async (req, res) => {
  const [from, to] = await period(req);
  const orders = await all(`${ORDER_SELECT}
    WHERE o.created_at::date BETWEEN $1 AND $2
    ORDER BY o.id DESC`, [from, to]);

  res.json(await withItems(orders));
}));

// en_cours → livree : caisse ou le livreur de la commande. Annuler : admin seulement (anti-triche).
app.patch('/api/orders/:id/status', auth, route(async (req, res) => {
  const order = await one('SELECT * FROM orders WHERE id = $1', [id(req.params.id)]);
  if (!order) fail('Commande introuvable', 404);
  const { status } = req.body;
  if (req.user.role === 'livreur' && (order.livreur_id !== req.user.livreur_id || status !== 'livree')) {
    fail('Accès refusé', 403);
  }

  if (status === 'livree') {
    if (order.status !== 'en_cours') fail("Cette commande n'est pas en cours de livraison");
  } else if (status === 'annulee') {
    if (req.user.role !== 'admin') fail("Seul l'admin peut annuler une commande", 403);
    if (order.status === 'annulee') fail('Déjà annulée');
  } else {
    fail('Statut invalide');
  }
  await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, order.id]);
  res.json({ ok: true });
}));

// Supprimer une commande (le client a annulé) : elle disparaît des ventes et de la dette du livreur.
// Seulement l'admin, pour qu'on ne puisse pas effacer une vente en cachette.
app.delete('/api/orders/:id', admin, route(async (req, res) => {
  const deleted = await transaction(async client => {
    await client.query('DELETE FROM order_items WHERE order_id = $1', [id(req.params.id)]);
    return (await client.query('DELETE FROM orders WHERE id = $1', [id(req.params.id)])).rowCount;
  });
  if (!deleted) fail('Commande introuvable', 404);
  res.json({ ok: true });
}));

// ---------- Tableau de bord ----------

app.get('/api/stats', admin, route(async (req, res) => {
  const [from, to] = await period(req);
  const p = [from, to];

  const totals = await one(`
    SELECT COUNT(*) AS nb,
      COALESCE(SUM(food_total), 0) AS ventes,
      COALESCE(SUM(food_total) FILTER (WHERE type != 'livraison'), 0) AS caisse_directe,
      COALESCE(SUM(food_total) FILTER (WHERE type = 'livraison'), 0) AS ventes_livraison,
      COALESCE(SUM(delivery_fee), 0) AS frais_livraison,
      COUNT(*) FILTER (WHERE type = 'surplace') AS nb_surplace,
      COUNT(*) FILTER (WHERE type = 'emporter') AS nb_emporter,
      COUNT(*) FILTER (WHERE type = 'livraison') AS nb_livraison
    FROM orders WHERE status != 'annulee' AND created_at::date BETWEEN $1 AND $2`, p);

  totals.annulees = (await one(
    "SELECT COUNT(*) AS n FROM orders WHERE status = 'annulee' AND created_at::date BETWEEN $1 AND $2", p)).n;
  totals.verse_livreurs = (await one(
    'SELECT COALESCE(SUM(amount), 0) AS s FROM versements WHERE created_at::date BETWEEN $1 AND $2', p)).s;

  const produits = await all(`
    SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.qty * oi.price) AS montant
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status != 'annulee' AND o.created_at::date BETWEEN $1 AND $2
    GROUP BY oi.name ORDER BY qty DESC, montant DESC`, p);

  const livreurs = await livreurComptes(from, to);
  const chez_livreurs = livreurs.filter(l => l.active).reduce((s, l) => s + Math.max(l.reste, 0), 0);

  res.json({ from, to, totals, produits, livreurs, chez_livreurs });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide' });
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur' });
});

// Lancé directement (npm start) : on écoute un port ; importé (Vercel) : on exporte l'app
if (require.main === module) {
  app.listen(PORT, () => console.log(`Mini restaurant : http://localhost:${PORT}`));
  init().catch(err => console.error('Attention, PostgreSQL injoignable :', err.message));
}

module.exports = app;

-- Tables du mini restaurant (PostgreSQL). Lancé à chaque démarrage : rien n'est écrasé.
-- Les dates sont gardées à l'heure d'Alger (le serveur Vercel, lui, est en UTC).

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'caissier'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Autres',
  price INTEGER NOT NULL CHECK (price >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS livreurs (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE
);

-- food_total = prix de la nourriture (argent du restaurant)
-- delivery_fee = frais de livraison (argent du livreur)
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'Africa/Algiers'),
  type TEXT NOT NULL CHECK (type IN ('surplace', 'emporter', 'livraison')),
  livreur_id INTEGER REFERENCES livreurs(id),
  client_name TEXT NOT NULL DEFAULT '',
  client_phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  food_total INTEGER NOT NULL,
  delivery_fee INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('terminee', 'en_cours', 'livree', 'annulee')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER REFERENCES products(id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0)
);

-- Argent que le livreur a rendu au restaurant
CREATE TABLE IF NOT EXISTS versements (
  id SERIAL PRIMARY KEY,
  livreur_id INTEGER NOT NULL REFERENCES livreurs(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP(0) NOT NULL DEFAULT (now() AT TIME ZONE 'Africa/Algiers'),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Comptes livreur : rôle 'livreur' relié à une ligne de la table livreurs
ALTER TABLE users ADD COLUMN IF NOT EXISTS livreur_id INTEGER REFERENCES livreurs(id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check3') THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check3
      CHECK (role IN ('admin', 'caissier', 'livreur') AND (role = 'livreur') = (livreur_id IS NOT NULL));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_livreur ON users(livreur_id);

-- Sessions de connexion (connect-pg-simple)
CREATE TABLE IF NOT EXISTS session (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_livreur ON orders(livreur_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_versements_livreur ON versements(livreur_id);

INSERT INTO settings (key, value) VALUES ('restaurant_name', 'Brother'), ('delivery_fee', '200')
ON CONFLICT (key) DO NOTHING;
UPDATE settings SET value = 'Brother' WHERE key = 'restaurant_name' AND value = 'Mini Restaurant';

-- Menu de départ (seulement si la table est vide), modifiable dans la page Produits
INSERT INTO products (name, category, price)
SELECT * FROM (VALUES
  ('Burger classique', 'Burgers', 400),
  ('Cheese burger', 'Burgers', 500),
  ('Double burger', 'Burgers', 700),
  ('Pizza Margherita', 'Pizzas', 600),
  ('Pizza Thon', 'Pizzas', 800),
  ('Pizza 4 fromages', 'Pizzas', 1000),
  ('Tacos poulet', 'Tacos', 550),
  ('Frites', 'Accompagnements', 150),
  ('Canette', 'Boissons', 100),
  ('Eau 0,5 L', 'Boissons', 50)
) AS menu(name, category, price)
WHERE NOT EXISTS (SELECT 1 FROM products);

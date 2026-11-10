-- Phase 2: the demo merchant "Stride & Co", its catalog (seeded from data/catalog.json) and carts.

CREATE TABLE merchants (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  currency    char(3) NOT NULL DEFAULT 'USD',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchant_products (
  id           text PRIMARY KEY,
  merchant_id  text NOT NULL REFERENCES merchants (id),
  name         text NOT NULL,
  brand        text NOT NULL,
  category     text NOT NULL,
  description  text NOT NULL DEFAULT ''
);
CREATE INDEX merchant_products_merchant_idx ON merchant_products (merchant_id);

-- A size is meaningless without its system: US 10 and UK 10 are different shoes.
CREATE TABLE merchant_variants (
  id           text PRIMARY KEY,
  product_id   text NOT NULL REFERENCES merchant_products (id),
  size_system  text NOT NULL CHECK (size_system IN ('US', 'UK', 'EU')),
  size         text NOT NULL,
  price_value  numeric(12, 2) NOT NULL CHECK (price_value >= 0),
  currency     char(3) NOT NULL DEFAULT 'USD',
  stock        integer NOT NULL CHECK (stock >= 0),
  UNIQUE (product_id, size_system, size)
);
CREATE INDEX merchant_variants_product_idx ON merchant_variants (product_id);

-- Carts keep what the client asked for; prices, stock and validation_issues are computed on every read.
CREATE TABLE merchant_carts (
  id                text PRIMARY KEY,
  merchant_id       text NOT NULL REFERENCES merchants (id),
  status            text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'INCOMPLETE', 'READY', 'COMPLETED')),
  items             jsonb NOT NULL DEFAULT '[]'::jsonb,
  customer          jsonb,
  shipping_address  jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

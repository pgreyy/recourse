-- Phase 2: the demo merchant (transaction) and the evidence it produces.

-- Merchant and its current catalog (seeded from data/catalog.json; catalog_version comes from the file).
CREATE TABLE merchants (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  currency         char(3) NOT NULL DEFAULT 'USD',
  catalog_version  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchant_listings (
  id           text PRIMARY KEY,
  merchant_id  text NOT NULL REFERENCES merchants (id),
  name         text NOT NULL,
  brand        text NOT NULL,
  category     text NOT NULL,
  description  text NOT NULL DEFAULT ''        -- merchant-written text: untrusted input for any LLM
);
CREATE INDEX merchant_listings_merchant_idx ON merchant_listings (merchant_id);

-- Structured attributes as the merchant supplied them. unit_system may be NULL: incomplete merchant
-- data is part of what Recourse has to reason about, so the schema does not paper over it.
CREATE TABLE merchant_variants (
  id           text PRIMARY KEY,
  listing_id   text NOT NULL REFERENCES merchant_listings (id),
  size         text NOT NULL,
  unit_system  text CHECK (unit_system IN ('US', 'UK', 'EU')),
  gender       text,
  price_value  numeric(12, 2) NOT NULL CHECK (price_value >= 0),
  currency     char(3) NOT NULL DEFAULT 'USD',
  stock        integer NOT NULL CHECK (stock >= 0),
  description  text NOT NULL DEFAULT ''
);
CREATE INDEX merchant_variants_listing_idx ON merchant_variants (listing_id);

-- Store Sync style carts. case_ref ties every cart call to the flight recorder.
CREATE TABLE carts (
  id                text PRIMARY KEY,
  merchant_id       text NOT NULL REFERENCES merchants (id),
  case_ref          text NOT NULL,
  status            text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'INCOMPLETE', 'READY', 'COMPLETED')),
  items             jsonb NOT NULL DEFAULT '[]'::jsonb,
  customer          jsonb,
  shipping_address  jsonb,
  last_snapshot_id  uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX carts_case_ref_idx ON carts (case_ref);

-- What the merchant showed at a moment: every listing, variant, attribute, description, price and
-- stock level, with catalog_version. sha256 = sha256 of the canonical JSON of `snapshot`;
-- identical catalogs share one row.
CREATE TABLE catalog_snapshots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id      text NOT NULL REFERENCES merchants (id),
  catalog_version  text NOT NULL,
  sha256           char(64) NOT NULL UNIQUE,
  snapshot         jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE carts ADD CONSTRAINT carts_last_snapshot_fk FOREIGN KEY (last_snapshot_id) REFERENCES catalog_snapshots (id);

-- Flight recorder: append-only (enforced in code; there is no update or delete path) hash chain per case.
-- hash = sha256_hex(prev_hash || canonical_json({case_ref, seq, kind, recorded_at, payload}));
-- seq 1 has prev_hash = 64 zeros. created_at is the recorded_at that was hashed.
CREATE TABLE recorder_entries (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_ref    text NOT NULL,
  seq         integer NOT NULL CHECK (seq >= 1),
  kind        text NOT NULL,
  payload     jsonb NOT NULL,
  prev_hash   char(64) NOT NULL,
  hash        char(64) NOT NULL,
  created_at  timestamptz NOT NULL,
  UNIQUE (case_ref, seq)
);

-- Signed chain heads, kept apart from the entries: if entries are deleted from the end, the last
-- checkpoint still says how long the chain was. signature = Ed25519 over the canonical JSON of
-- {type, case_ref, seq, head_hash, signed_at, signing_key_id}.
CREATE TABLE recorder_checkpoints (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_ref        text NOT NULL,
  seq             integer NOT NULL CHECK (seq >= 1),
  head_hash       char(64) NOT NULL,
  signed_at       timestamptz NOT NULL,
  signing_key_id  text NOT NULL,
  signature       text NOT NULL,
  UNIQUE (case_ref, seq)
);

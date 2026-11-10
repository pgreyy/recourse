-- Phase 1: buyers, operators, agents, mandates, orders, flight recorder.
-- gen_random_uuid() is built into Postgres 13+ (Neon runs 16+).

CREATE TABLE buyers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL UNIQUE,
  paypal_customer_id  text,                       -- Vault customer id from the first approved setup token
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- The company that runs a shopping agent and pre-authorizes liability payments.
CREATE TABLE operators (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  email                     text NOT NULL,
  status                    text NOT NULL DEFAULT 'PENDING_VAULT'
                              CHECK (status IN ('PENDING_VAULT', 'PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED')),
  setup_token_id            text UNIQUE,
  paypal_customer_id        text,
  operator_vault_id         text,               -- charged payer-not-present when a ruling finds agent fault
  vaulted_at                timestamptz,
  liability_limit_value     numeric(12, 2) NOT NULL DEFAULT 200.00 CHECK (liability_limit_value > 0),
  liability_limit_currency  char(3) NOT NULL DEFAULT 'USD',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- A versioned shopping agent. Rulings and reputation (later phases) attach to name + version.
CREATE TABLE agents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id  uuid NOT NULL REFERENCES operators (id),
  name         text NOT NULL,
  version      text NOT NULL,
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'RETIRED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operator_id, name, version)
);
CREATE INDEX agents_operator_idx ON agents (operator_id);

-- What the buyer allowed the agent to buy. `spec` is the structured mandate from the LLM;
-- signature + mandate_hash are over the canonical JSON of the signed document (see src/mandates/document.ts).
CREATE TABLE mandates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id            uuid NOT NULL REFERENCES buyers (id),
  agent_id            uuid REFERENCES agents (id),   -- bound when an agent acts on it (Phase 3)
  status              text NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'CONSUMED', 'REVOKED', 'EXPIRED')),
  source_text         text NOT NULL,
  spec                jsonb NOT NULL,
  llm_provider        text,
  llm_model           text,
  setup_token_id      text UNIQUE,
  paypal_customer_id  text,
  vault_id            text,
  signed_at           timestamptz,
  mandate_hash        char(64),
  signature           text,                          -- Ed25519, base64url
  signing_key_id      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('ACTIVE', 'CONSUMED') OR (vault_id IS NOT NULL AND signature IS NOT NULL AND mandate_hash IS NOT NULL))
);
CREATE INDEX mandates_buyer_idx ON mandates (buyer_id);
CREATE INDEX mandates_hash_idx ON mandates (mandate_hash);

-- A purchase an agent made under a mandate. case_ref ties it to the flight recorder and, later,
-- to disputes, rulings and settlements. custom_id on the PayPal order is the mandate_hash.
CREATE TABLE orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_ref           text NOT NULL UNIQUE,
  mandate_id         uuid NOT NULL REFERENCES mandates (id),
  agent_id           uuid REFERENCES agents (id),
  merchant_id        text NOT NULL,
  merchant_cart_id   text,
  status             text NOT NULL DEFAULT 'CREATED'
                       CHECK (status IN ('CREATED', 'PAID', 'FULFILLED', 'DISPUTED', 'REFUNDED', 'SETTLED', 'FAILED')),
  items              jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_value        numeric(12, 2),
  currency           char(3),
  paypal_order_id    text UNIQUE,
  paypal_capture_id  text UNIQUE,
  custom_id          text,
  invoice_id         text UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_mandate_idx ON orders (mandate_id);

-- Flight recorder: an append-only hash chain per case.
-- hash = sha256_hex(prev_hash || canonical_json(payload)); seq 1 has prev_hash = 64 zeros.
-- Not a foreign key to orders: a case starts recording before any order exists.
CREATE TABLE recorder_entries (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_ref    text NOT NULL,
  seq         integer NOT NULL CHECK (seq >= 1),
  kind        text NOT NULL,
  payload     jsonb NOT NULL,
  prev_hash   char(64) NOT NULL,
  hash        char(64) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_ref, seq)
);

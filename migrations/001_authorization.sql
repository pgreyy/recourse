-- Phase 1, authorization: who may buy what, on whose money, and who answers when an agent gets it wrong.
-- Later phases add (and reference these tables by uuid): carts, orders, receipts, cases, assessments,
-- rulings, appeals, settlement_obligations, settlement_actions, paypal_events, reputation_events.
-- gen_random_uuid() is built into Postgres 13+.

CREATE TABLE buyers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL UNIQUE,
  paypal_customer_id  text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- The company that runs shopping agents and agrees, in advance, to pay for its agents' faults.
-- Onboarding state (agreement accepted? payment method saved?) is derived from the tables below.
CREATE TABLE operators (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  email       text NOT NULL,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id  uuid NOT NULL REFERENCES operators (id),
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'RETIRED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operator_id, name)
);

-- Liability, rulings and reputation attach to a specific version of an agent.
CREATE TABLE agent_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid NOT NULL REFERENCES agents (id),
  version     text NOT NULL,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);

-- Versioned terms the operator accepts before any payment method is saved. `terms` is the full
-- canonical document; terms_hash = sha256 of its canonical JSON. Acceptance is recorded as a
-- canonical acceptance record signed with Recourse's Ed25519 key (acceptance_signature).
CREATE TABLE liability_agreements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id           uuid NOT NULL REFERENCES operators (id),
  version               integer NOT NULL CHECK (version >= 1),
  status                text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACCEPTED', 'SUPERSEDED', 'REVOKED')),
  terms                 jsonb NOT NULL,
  terms_hash            char(64) NOT NULL,
  per_incident_cap      numeric(12, 2) NOT NULL CHECK (per_incident_cap > 0),
  aggregate_cap         numeric(12, 2) NOT NULL CHECK (aggregate_cap > 0),
  currency              char(3) NOT NULL,
  appeal_window_hours   integer NOT NULL CHECK (appeal_window_hours > 0),
  accepted_at           timestamptz,
  accepted_by_name      text,
  accepted_by_email     text,
  acceptance_hash       char(64),
  acceptance_signature  text,
  signing_key_id        text,
  revoked_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operator_id, version),
  CHECK (per_incident_cap <= aggregate_cap),
  CHECK (status = 'DRAFT' OR (accepted_at IS NOT NULL AND acceptance_signature IS NOT NULL))
);
CREATE UNIQUE INDEX liability_agreements_one_accepted ON liability_agreements (operator_id) WHERE status = 'ACCEPTED';

-- Which agent versions an agreement covers (also listed inside the signed terms).
CREATE TABLE liability_agreement_agent_versions (
  liability_agreement_id  uuid NOT NULL REFERENCES liability_agreements (id),
  agent_version_id        uuid NOT NULL REFERENCES agent_versions (id),
  PRIMARY KEY (liability_agreement_id, agent_version_id)
);

-- PayPal Vault payment tokens. A buyer token funds a mandate; an operator token is linked to the
-- liability agreement it was saved under and is charged (payer not present) for agent-fault rulings.
CREATE TABLE payment_tokens (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type              text NOT NULL CHECK (owner_type IN ('BUYER', 'OPERATOR')),
  buyer_id                uuid REFERENCES buyers (id),
  operator_id             uuid REFERENCES operators (id),
  liability_agreement_id  uuid REFERENCES liability_agreements (id),
  provider                text NOT NULL DEFAULT 'paypal',
  status                  text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED', 'FAILED')),
  setup_token_id          text UNIQUE,
  vault_id                text UNIQUE,
  paypal_customer_id      text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  activated_at            timestamptz,
  revoked_at              timestamptz,
  CHECK (owner_type <> 'BUYER' OR (buyer_id IS NOT NULL AND operator_id IS NULL)),
  CHECK (owner_type <> 'OPERATOR' OR (operator_id IS NOT NULL AND liability_agreement_id IS NOT NULL AND buyer_id IS NULL)),
  CHECK (status <> 'ACTIVE' OR vault_id IS NOT NULL)
);
CREATE UNIQUE INDEX payment_tokens_one_active_operator ON payment_tokens (operator_id) WHERE owner_type = 'OPERATOR' AND status = 'ACTIVE';

-- One row per mandate version. lineage_id is the mandate's stable identity; an edit inserts version
-- n+1 (supersedes_id -> previous row) and marks the previous row SUPERSEDED. Signed versions carry
-- signature + mandate_hash over the canonical signed document (src/authorization/mandate-document.ts).
CREATE TABLE mandates (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage_id             uuid NOT NULL,
  version                integer NOT NULL CHECK (version >= 1),
  supersedes_id          uuid REFERENCES mandates (id),
  buyer_id               uuid NOT NULL REFERENCES buyers (id),
  status                 text NOT NULL DEFAULT 'DRAFT'
                           CHECK (status IN ('DRAFT', 'ACTIVE', 'CONSUMED', 'EXPIRED', 'REVOKED', 'SUPERSEDED')),
  source_text            text NOT NULL,
  spec                   jsonb NOT NULL,
  expires_at             timestamptz NOT NULL,
  llm_provider           text,
  llm_model              text,
  payment_token_id       uuid REFERENCES payment_tokens (id),
  signed_at              timestamptz,
  signing_key_id         text,
  previous_mandate_hash  char(64),
  mandate_hash           char(64),
  signature              text,
  revoked_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lineage_id, version),
  CHECK (status IN ('DRAFT', 'SUPERSEDED', 'REVOKED', 'EXPIRED') OR (signature IS NOT NULL AND mandate_hash IS NOT NULL AND payment_token_id IS NOT NULL))
);
-- Only the newest version of a lineage is live.
CREATE UNIQUE INDEX mandates_one_current_per_lineage ON mandates (lineage_id) WHERE status <> 'SUPERSEDED';
CREATE INDEX mandates_buyer_idx ON mandates (buyer_id);
CREATE INDEX mandates_hash_idx ON mandates (mandate_hash);

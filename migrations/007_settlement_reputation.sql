-- Phase 5 (settlement) and Phase 6 (reputation). Settlement is separate from rulings: a ruling says who
-- is responsible; an obligation is what must happen with money, executed only after checks.

ALTER TABLE rulings
  ADD COLUMN operator_accepted_at timestamptz,
  ADD COLUMN operator_accepted_by text;
ALTER TABLE rulings DROP CONSTRAINT rulings_status_check;
ALTER TABLE rulings ADD CONSTRAINT rulings_status_check CHECK (status IN ('RULING_APPROVED', 'APPEALED', 'REVERSED', 'SUPERSEDED', 'SETTLED'));

-- What has to happen because of a ruling. kind:
--   RECOVERY       AGENT_FAULT: refund the buyer, then recover from the operator (workflow A, or B via accept_claim)
--   DISPUTE_RESPONSE  workflow B for MERCHANT_FAULT / BUYER_REMORSE (offer, refund or evidence)
--   NO_CHARGE      THIRD_PARTY_FAULT: nobody is charged
--   REVERSAL       an appeal reversed an AGENT_FAULT after money moved: refund the operator's capture
CREATE TABLE settlement_obligations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ruling_id              uuid NOT NULL REFERENCES rulings (id),
  case_id                uuid NOT NULL REFERENCES cases (id),
  kind                   text NOT NULL CHECK (kind IN ('RECOVERY', 'DISPUTE_RESPONSE', 'NO_CHARGE', 'REVERSAL')),
  workflow               char(1) NOT NULL CHECK (workflow IN ('A', 'B')),
  verdict                text NOT NULL,
  status                 text NOT NULL DEFAULT 'OPEN'
                           CHECK (status IN ('OPEN', 'BUYER_REFUNDED', 'AWAITING_CONFIRMATION', 'INVOICED', 'AWAITING_PAYPAL', 'RECOVERED', 'COMPLETED', 'FAILED', 'NO_ACTION')),
  amount_value           numeric(12, 2) NOT NULL,
  currency               char(3) NOT NULL,
  operator_id            uuid REFERENCES operators (id),
  liability_agreement_id uuid REFERENCES liability_agreements (id),
  agent_version_id       uuid REFERENCES agent_versions (id),
  recovered_value        numeric(12, 2) NOT NULL DEFAULT 0,
  last_error             text,
  checks                 jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX settlement_one_per_ruling_kind ON settlement_obligations (ruling_id, kind);

-- Every money or dispute action. The intent is written BEFORE the PayPal call (status INTENDED), the
-- response after. idempotency_key = sha256(obligation id + action) is also the PayPal-Request-Id, so a
-- retry after an uncertain outcome returns PayPal's original result instead of acting twice.
CREATE TABLE settlement_actions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id    uuid NOT NULL REFERENCES settlement_obligations (id),
  action           text NOT NULL CHECK (action IN ('REFUND_BUYER', 'CHARGE_OPERATOR', 'INVOICE_OPERATOR', 'DISPUTE_ACCEPT_CLAIM', 'DISPUTE_MAKE_OFFER', 'DISPUTE_PROVIDE_EVIDENCE', 'DISPUTE_ESCALATE', 'REFUND_OPERATOR')),
  idempotency_key  char(64) NOT NULL UNIQUE,
  status           text NOT NULL CHECK (status IN ('INTENDED', 'SUCCEEDED', 'FAILED', 'UNCERTAIN', 'SKIPPED')),
  confirmation     text NOT NULL DEFAULT 'pending' CHECK (confirmation IN ('pending', 'confirmed')),
  confirmed_by     text,
  amount_value     numeric(12, 2),
  currency         char(3),
  request          jsonb NOT NULL,
  response         jsonb,
  http_status      integer,
  debug_id         text,
  paypal_ids       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  confirmed_at     timestamptz
);
CREATE INDEX settlement_actions_obligation_idx ON settlement_actions (obligation_id);

-- Operator appeals (API only). The note is untrusted text and goes through the injection guard.
CREATE TABLE appeals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ruling_id      uuid NOT NULL REFERENCES rulings (id),
  operator_id    uuid REFERENCES operators (id),
  note           text NOT NULL,
  flagged        boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'UPHELD', 'REVERSED')),
  decided_by     text,
  decision_note  text,
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX appeals_one_per_ruling ON appeals (ruling_id);

-- Reputation comes only from finalized rulings (approved + recovered, or appeal decided). weight is in
-- currency units; a reversal adds a compensating event with the opposite sign.
CREATE TABLE reputation_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('CONFIRMED_AGENT_FAULT', 'AGENT_FAULT_REVERSED', 'OBLIGATION_PAID', 'OBLIGATION_FAILED', 'OBLIGATION_REVERSED')),
  agent_version_id  uuid REFERENCES agent_versions (id),
  operator_id       uuid REFERENCES operators (id),
  ruling_id         uuid REFERENCES rulings (id),
  obligation_id     uuid REFERENCES settlement_obligations (id),
  amount_value      numeric(12, 2) NOT NULL DEFAULT 0,
  currency          char(3) NOT NULL DEFAULT 'USD',
  weight            numeric(12, 2) NOT NULL DEFAULT 0,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ruling_id, obligation_id)
);
CREATE INDEX reputation_agent_idx ON reputation_events (agent_version_id, occurred_at);
CREATE INDEX reputation_operator_idx ON reputation_events (operator_id, occurred_at);

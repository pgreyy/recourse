-- Phase 3 and 3b: agent runs, deterministic checkout, PayPal anchoring, receipts, PayPal events.

-- Agent versions carry their own instructions and model settings: how real agents differ by version.
ALTER TABLE agent_versions
  ADD COLUMN instructions  text,
  ADD COLUMN model_config  jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The merchant's delivery promise, used by the firewall's deadline check and shown in snapshots.
ALTER TABLE merchants ADD COLUMN delivery_days integer CHECK (delivery_days >= 0);

-- One agent run against one mandate. Everything it did is in the recorder under case_ref.
CREATE TABLE agent_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_ref          text NOT NULL UNIQUE,
  mandate_id        uuid NOT NULL REFERENCES mandates (id),
  agent_version_id  uuid NOT NULL REFERENCES agent_versions (id),
  status            text NOT NULL DEFAULT 'RUNNING'
                      CHECK (status IN ('RUNNING', 'PURCHASED', 'STEP_UP_REQUIRED', 'NO_PURCHASE', 'FAILED')),
  model_provider    text,
  model_id          text,
  steps             integer NOT NULL DEFAULT 0,
  final_text        text,
  error             text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);

-- A purchase. invoice_id = order_ref; custom_id = mandate_hash; anchor_description carries the recorder
-- head hash into PayPal. paypal_request_id is unique: a repeated checkout returns this row instead of
-- charging again (and PayPal dedupes the same PayPal-Request-Id too).
CREATE TABLE orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_ref             text NOT NULL UNIQUE,
  case_ref              text NOT NULL,
  mandate_id            uuid NOT NULL REFERENCES mandates (id),
  mandate_lineage_id    uuid NOT NULL,
  agent_version_id      uuid REFERENCES agent_versions (id),
  cart_id               text NOT NULL REFERENCES carts (id),
  merchant_id           text NOT NULL REFERENCES merchants (id),
  status                text NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED')),
  lines                 jsonb NOT NULL,
  total_value           numeric(12, 2) NOT NULL,
  currency              char(3) NOT NULL,
  firewall              jsonb NOT NULL,
  compliance            text NOT NULL CHECK (compliance IN ('COMPLIANT', 'WARNING', 'VIOLATION_APPROVED')),
  paypal_request_id     text NOT NULL UNIQUE,
  paypal_order_id       text UNIQUE,
  paypal_capture_id     text UNIQUE,
  custom_id             text NOT NULL,
  invoice_id            text NOT NULL UNIQUE,
  anchor_description    text NOT NULL,
  anchor_seq            integer NOT NULL,
  anchor_head_hash      char(64) NOT NULL,
  anchor_verified       boolean,
  tracker_id            text,
  error                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  captured_at           timestamptz
);
CREATE INDEX orders_lineage_idx ON orders (mandate_lineage_id);
CREATE INDEX orders_case_ref_idx ON orders (case_ref);

-- A purchase the firewall blocked, waiting for the buyer to approve it directly at PayPal.
CREATE TABLE step_ups (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_ref         text NOT NULL,
  mandate_id       uuid NOT NULL REFERENCES mandates (id),
  cart_id          text NOT NULL REFERENCES carts (id),
  violations       jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'CANCELLED', 'EXPIRED')),
  paypal_order_id  text UNIQUE,
  approve_url      text,
  order_id         uuid REFERENCES orders (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz
);

-- Ratification receipt shown to the buyer after a purchase. The URL token is signed (see receipts.ts).
CREATE TABLE receipts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id               uuid NOT NULL UNIQUE REFERENCES orders (id),
  status                 text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'ISSUE_REPORTED')),
  confirmed_at           timestamptz,
  acknowledgement_hash   char(64),
  acknowledgement_sig    text,
  signing_key_id         text,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- A buyer-raised issue (pre-dispute: no PayPal dispute is opened). Phase 4 adds assessments,
-- rulings and appeals that reference cases(id).
CREATE TABLE cases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_ref     text NOT NULL,
  order_id     uuid REFERENCES orders (id),
  receipt_id   uuid REFERENCES receipts (id),
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'UNDER_ASSESSMENT', 'RULED', 'APPEALED', 'CLOSED')),
  opened_by    text NOT NULL CHECK (opened_by IN ('BUYER', 'OPERATOR', 'MERCHANT', 'PAYPAL')),
  description  text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cases_case_ref_idx ON cases (case_ref);

-- Every PayPal webhook delivery, deduplicated by PayPal's event id.
CREATE TABLE paypal_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id             text NOT NULL UNIQUE,
  event_type           text NOT NULL,
  resource_type        text,
  resource_id          text,
  verification_status  text NOT NULL,
  payload              jsonb NOT NULL,
  transmission_id      text,
  received_at          timestamptz NOT NULL DEFAULT now(),
  processed_at         timestamptz,
  processing_result    jsonb,
  order_id             uuid REFERENCES orders (id),
  deliveries           integer NOT NULL DEFAULT 1
);

-- Phase 4: the accountability engine. Cases (buyer reports and PayPal disputes), operator statements,
-- assessments (code checks + AI, validated in code), approved rulings, and the scorecard.

ALTER TABLE cases
  ADD COLUMN source text NOT NULL DEFAULT 'BUYER_REPORT' CHECK (source IN ('BUYER_REPORT', 'PAYPAL_DISPUTE', 'MANUAL')),
  ADD COLUMN dispute_id text,
  ADD COLUMN dispute_snapshot jsonb;
ALTER TABLE cases DROP CONSTRAINT cases_status_check;
ALTER TABLE cases ADD CONSTRAINT cases_status_check
  CHECK (status IN ('OPEN', 'ASSESSED', 'NEEDS_HUMAN_REVIEW', 'RULING_APPROVED', 'APPEALED', 'CLOSED'));
CREATE UNIQUE INDEX cases_dispute_idx ON cases (dispute_id) WHERE dispute_id IS NOT NULL;

-- Text a party adds to a case. Always treated as untrusted evidence; never as instructions.
CREATE TABLE case_statements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES cases (id),
  party       text NOT NULL CHECK (party IN ('OPERATOR', 'BUYER', 'MERCHANT')),
  author      text,
  text        text NOT NULL,
  flagged     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_statements_case_idx ON case_statements (case_id);

-- One assessment run. code_checks, counterfactual and injection_flags come from code; ai_output is
-- the model's raw structured answer; validation decides what survives. confidence is stored, not shown.
CREATE TABLE assessments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                uuid REFERENCES cases (id),
  scorecard_run_id       uuid,
  fixture_id             text,
  is_appeal              boolean NOT NULL DEFAULT false,
  evidence_pack          jsonb NOT NULL,
  evidence_pack_hash     char(64) NOT NULL,
  code_checks            jsonb NOT NULL,
  counterfactual         jsonb NOT NULL,
  injection_flags        jsonb NOT NULL,
  ai_called              boolean NOT NULL,
  ai_output              jsonb,
  model_provider         text,
  model_id               text,
  prompt_version_hash    char(64) NOT NULL,
  confidence             numeric(4, 3),
  validation             jsonb NOT NULL,
  final_verdict          text NOT NULL CHECK (final_verdict IN ('AGENT_FAULT', 'MERCHANT_FAULT', 'BUYER_REMORSE', 'THIRD_PARTY_FAULT', 'INCONCLUSIVE')),
  requires_human_review  boolean NOT NULL,
  human_review_reasons   jsonb NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (case_id IS NOT NULL OR fixture_id IS NOT NULL)
);
CREATE INDEX assessments_case_idx ON assessments (case_id);

-- A validated assessment a human approved. Phase 5 turns approved rulings into settlement obligations;
-- approving moves no money. The ruling document is signed with Recourse's key.
CREATE TABLE rulings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id           uuid NOT NULL REFERENCES cases (id),
  assessment_id     uuid NOT NULL UNIQUE REFERENCES assessments (id),
  status            text NOT NULL DEFAULT 'RULING_APPROVED' CHECK (status IN ('RULING_APPROVED', 'APPEALED', 'SUPERSEDED', 'SETTLED')),
  verdict           text NOT NULL,
  liable_party      text NOT NULL CHECK (liable_party IN ('OPERATOR', 'MERCHANT', 'BUYER', 'THIRD_PARTY')),
  amount_value      numeric(12, 2) NOT NULL,
  currency          char(3) NOT NULL,
  document          jsonb NOT NULL,
  document_hash     char(64) NOT NULL,
  signature         text NOT NULL,
  signing_key_id    text NOT NULL,
  approved_by_name  text NOT NULL,
  approved_by_email text NOT NULL,
  approved_at       timestamptz NOT NULL,
  appeal_deadline   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rulings_one_active_per_case ON rulings (case_id) WHERE status IN ('RULING_APPROVED', 'APPEALED');

-- Scorecard: labelled fixture cases run through the same pipeline, per model and prompt version.
CREATE TABLE scorecard_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_provider         text,
  model_id               text,
  prompt_version_hash    char(64) NOT NULL,
  fixtures_version       text NOT NULL,
  cases_total            integer NOT NULL,
  correct                integer NOT NULL,
  accuracy               numeric(5, 4) NOT NULL,
  false_agent_fault_rate numeric(5, 4) NOT NULL,
  inconclusive_rate      numeric(5, 4) NOT NULL,
  ai_calls               integer NOT NULL,
  results                jsonb NOT NULL,
  started_at             timestamptz NOT NULL,
  finished_at            timestamptz NOT NULL
);

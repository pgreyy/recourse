-- The case screen's PayPal re-verification, cached with its time. The live read (order, capture,
-- dispute) is repeated on "Re-verify now", or automatically when the case's recorder has moved on
-- since the cached read (head_seq differs).
CREATE TABLE case_verifications (
  case_id      uuid PRIMARY KEY REFERENCES cases (id) ON DELETE CASCADE,
  verified_at  timestamptz NOT NULL,
  head_seq     integer NOT NULL,
  evidence     jsonb NOT NULL,     -- code checks, decision facts, counterfactual, injection flags, clauses
  disputes     jsonb NOT NULL      -- live PayPal dispute state per obligation id (workflow B)
);

-- Copies of recorded demo runs (scenario A and B), kept by npm run demo:reset so they can be shown
-- again (npm run demo:restore) if a live rerun fails. One row per label and table: the rows as JSON.
CREATE TABLE demo_archive (
  label        text NOT NULL,
  table_name   text NOT NULL,
  rows         jsonb NOT NULL,
  archived_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (label, table_name)
);

-- PayPal returns the SAME vault payment token when the same payer approves the same merchant again
-- (seen 2026-11-10: the buyer's mandate approval returned the vault_id from Phase 0). A payment_tokens
-- row is one authorization (one mandate or one liability agreement), so several rows can point at the
-- same PayPal vault_id. Revoking a row stops Recourse using it for that authorization only.
ALTER TABLE payment_tokens DROP CONSTRAINT payment_tokens_vault_id_key;
CREATE INDEX payment_tokens_vault_idx ON payment_tokens (vault_id);

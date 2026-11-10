-- Dry runs: the agent shops and checkout reports what the firewall would decide, but nothing is
-- anchored or charged. Used to rehearse the demo and to check an agent version's choices.
ALTER TABLE agent_runs ADD COLUMN dry_run boolean NOT NULL DEFAULT false;
ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('RUNNING', 'PURCHASED', 'STEP_UP_REQUIRED', 'NO_PURCHASE', 'FAILED', 'DRY_RUN'));
